# N-door 자동 추출 확장 계획

방 안에 문이 N개 있어도 각 문의 4코너를 독립적으로 추출하도록 door-ml 파이프라인을 확장한다.

## 0. 현재 상태 (단일 문)

```
Phase 2  벽-정면 카메라(wall-facing) — 각 벽을 따라 순서대로 타일링하며 렌더 (view_idx 순차)
Phase 3  SAM3 → 검출된 coarse 뷰들 (mask_path 보유)
Phase 4-6 4코너 보이는 coarse 뷰 있으면 iterative skip, 없으면 iterative 접근
Phase 7+8 selected 뷰 mask → quad → LT/RT/LB/RB ordering
Phase 9   각 뷰 4코너 픽셀 → world ray. by_corner 로 corner_type 별 묶음 (전 뷰 혼합)
Phase 10  ray ∩ door_wall 평면. 4코너 보이는 best single view 면 그 뷰 ray 4개로 확정,
          상단만이면 다중뷰 평균 + 하단 floorY 직강하
Phase 11  품질 + JSON (door_corners_3d 단일)
```

**한계**: Phase 9 의 `by_corner` 가 **모든 뷰의 left_top 을 한 묶음으로 섞는다**. 서로 다른 문을
본 뷰들이 섞이면 코너가 오염된다. 또 결과가 문 1개로 고정.

## 1. 핵심 아이디어

렌더가 **각 벽을 따라 순서대로(view_idx 순차)** 진행되므로:
- 4코너 보이는 `view_K` 의 **±2 이웃**(K-2..K+2) 은 같은 문을 담을 확률이 높다.
- 따라서 **연속된 검출 뷰 = 같은 문**, **index 가 떨어진 새 검출 = 다른 문** 으로 1차 그룹화.
- 1차 그룹별로 4코너를 추출한 뒤, **3D 코너 근접도로 검증·병합**해 최종 N개 문 확정.

## 2. 확정된 설계 결정 (사용자)

| # | 결정 | 내용 |
|---|------|------|
| D1 | 그룹화 기준 | **인접(±2) + 3D 검증 조합** — view-index 인접으로 1차 클러스터, 3D 근접도로 검증·병합 |
| D2 | 코너 확정 | **최고 품질 단일 view** — 그룹 내 4코너 보이는 최고 score 뷰 1장의 ray 교점으로 확정 |
| D3 | 벽 경계 | **1문 = 1벽** — 서로 다른 벽 평면의 검출은 항상 다른 문 (벽 넘어 병합 금지) |

## 3. 사용자 요구사항 3가지 → 설계 반영

### 요구 ① 마스크당 독립 구조체 (ray 섞임 방지)
- 현재 `by_corner` 전역 혼합을 **폐기**. 각 (문 그룹의) 대표 뷰 **1장의 mask** 에서 만든 4개 ray 만으로
  하나의 `DoorStructure` 를 만든다. 서로 다른 문/뷰의 ray 가 절대 섞이지 않는다.

### 요구 ② 유사 구조체 3D 검증·병합
- 모든 `DoorStructure` 생성 후, **3D 코너가 서로 가까운(=같은 문) 구조체를 병합**한다.
- 병합 시 더 높은 품질(4코너 > 상단2점, 높은 score)을 대표로 남긴다 (D2).

### 요구 ③ 상단 2점만 검출 시 floorY 경로 진입 시점
- 상단 2코너만 마스크된 뷰는 **곧바로 대표(coarse view)로 등록하지 않는다.**
- 그 뷰의 **±2 이웃에 4코너 모두 잘 검출된 뷰가 있으면** → 그 4코너 뷰를 대표로 쓰고 이 상단2점 뷰는 버린다.
- **±2 이웃에 4코너 뷰가 없을 때만** 이 상단2점 뷰를 대표로 등록하고, 하단 2점은
  상단 XZ 에서 **Y축 평행 하강 → 벽 평면 하단 모서리(real_floor_y) 교점**으로 계산한다.
- (클러스터 프레임워크에서는 "클러스터 내 4코너 뷰 우선, 없으면 상단2점+floorY" 로 자연 처리됨.)

## 4. 알고리즘 상세

### Step A — 후보 뷰 수집
SAM3 검출된 모든 coarse 뷰(`sam3_summary["views"]` 중 `mask_path` 보유)에 대해:
- `analyze_mask_quad(mask)` → `all_corners_visible`, `quad`, `h/v_ratio`, `coverage`.
- quad 추출 실패 시 skip.
- 카메라의 **wall_idx** 기록 (벽-정면 샘플러가 카메라별 벽 index 를 반환하도록 확장 — §6).
- 후보: `{view_idx, wall_idx, score, all_corners_visible, ordered_pixels, camera}`.

> 참고: iterative(Phase 4-6)는 N-door 에선 기본 비활성. coarse 벽-정면 뷰가 이미 4코너를 자주 잡으므로.
> 단일-문 호환을 위해 `--max_doors == 1` 이면 기존 경로 유지.

### Step B — 인접 클러스터링 (벽 내부, D1·D3)
1. 후보를 `(wall_idx, view_idx)` 로 정렬.
2. 순회하며 **같은 wall_idx AND view_idx gap ≤ GAP(기본 2)** 이면 같은 클러스터.
3. gap > 2 또는 다른 wall_idx → 새 클러스터.
4. 결과: 클러스터들 = 1차 문 그룹.

### Step C — 클러스터별 코너 추출 (요구③·D2)
각 클러스터에 대해:
1. 문 벽 평면 = 클러스터의 `wall_idx` 평면 (D3, pick_door_wall 로 재확인 가능하나 벽 고정).
2. 대표 뷰 선택: `all_corners_visible=True` 우선 → 그 중 최고 score.
3. **4코너 뷰 존재 시**: 그 단일 뷰의 4 코너 픽셀 → ray → 벽 교점 4개 = `DoorStructure` (요구①).
4. **상단2점 뷰만 존재 시**: 최고 score 상단2점 뷰의 TL/TR ray → 벽 교점.
   BL/BR = `[TL.x, real_floor_y, TL.z]`, `[TR.x, real_floor_y, TR.z]` (요구③).
5. `DoorStructure {corners4, wall_idx, score, src_view_idx, mode}`.

### Step D — 3D 검증·병합 (요구②·D2)
- 두 `DoorStructure` A, B 가 **같은 wall_idx** 이고 코너가 유사하면 병합:
  - 유사 기준(기본): centroid 거리 < `MERGE_DIST` **또는** 4코너 평균 대응거리 < `MERGE_DIST`.
  - `MERGE_DIST` 기본값: `max(0.4 m, 0.5 × min(doorA_width, doorB_width))`.
- 병합 그룹은 **최고 품질 1개**(4코너 > 상단2점, 높은 score)만 남김 (D2).
- 결과: 최종 N개 distinct 문.

### Step E — 출력
- `result.door_corners_3d` = 최고 품질 문 (backward compat).
- `result.all_doors` = N개 문 코너 리스트.
- door_ml → backend → frontend 전파.

## 5. 데이터 구조

```python
@dataclass
class DoorStructure:
    corners: dict[str, tuple[float,float,float]]  # left_top/right_top/left_bottom/right_bottom
    wall_idx: int
    score: float          # 대표 뷰 SAM3 score
    src_view_idx: int
    mode: str             # "4-corner-single" | "top-2-floorY"
```

## 6. 변경 파일

| 파일 | 변경 |
|------|------|
| `render/camera_sampler.py` | `sample_wall_facing_cameras` 가 카메라별 `wall_idx` 반환 (또는 CameraView 에 필드 추가) |
| `pipeline.py` | Phase 4-10 N-door 재구성: 후보수집 → 인접클러스터 → 클러스터별추출 → 3D병합. `--max_doors` 인자. `by_corner` 전역혼합 폐기 |
| `io/result_schema.py` | `all_doors: list[dict]` 필드 재추가 |
| `door_ml/main.py` | `max_doors` 파라미터, `DetectResponse.all_doors` 반환 |
| `backend/app/api/module_register.py` | `Sam3DetectTempRequest.max_doors`, 응답에 all_doors 전달 (+ bake/wallAngle 변환 N개 적용) |
| `frontend` | detect-temp 결과 N개 문 배치 (UnifiedSplatEditor / DoorAlignModal). **가장 큰 프론트 작업** |

> 프론트 N-door 배치: 현재 `autoExtractedCorners` 가 단일 세트. 리스트로 확장 + 문 설정 UI 가
> N개 문을 순차/동시 배치하도록 수정 필요. (claude.md 의 basemap multi-door 흐름 참고.)

## 7. 엣지 케이스 & 한계

- **같은 벽 위 두 문이 gap 이내로 가까움**: 인접 클러스터가 하나로 묶을 수 있음.
  → Step D 의 3D 검증은 "같은 문"만 병합하므로 분리는 못 함. 완화책: 클러스터 내 코너 XZ 분산이
    크면 2-means 로 재분할(후속). 일단 GAP 작게(2) 유지.
- **벽 경계/wrap-around**: D3(벽별 분리)로 자연 차단. 마지막 벽→첫 벽 wrap 은 wall_idx 로 차단.
- **모서리 문**(두 벽에 걸침): D3 상 두 문으로 잡힘 → Step D 가 3D 근접이어도 벽 다르면 병합 안 함.
  필요 시 후속 예외 처리.
- **한 문이 모든 뷰에서 상단2점만**: floorY 경로로 처리(요구③).
- **검출 0**: 기존 fail-fast 유지.

## 8. 구현 단계

1. `camera_sampler`: wall_idx 반환 + pipeline 에서 `view_idx→wall_idx` 맵 구성.
2. `DoorStructure` + Step A~E 함수 (`pipeline.py` 또는 신규 `corner_extraction/multi_door.py`).
3. `--max_doors` 분기: 1 이면 기존 경로, >1 이면 N-door 경로.
4. result_schema / door_ml / backend `all_doors` 배선.
5. 스테이징 검증: 2-door 폴리곤으로 2문 추출·distinct 확인, ray 비혼합·병합 동작 확인, 타이머.
6. 프론트 N-door 배치 (별도 단계).

## 9. 검증 기준

- 2문 방: `all_doors` 길이 == 2, 각 문이 올바른 벽·위치, width/height 정상 범위.
- ray 비혼합: 각 DoorStructure 가 단일 뷰 mask 출처(로그 `src_view_idx`).
- 병합: 같은 문을 여러 뷰가 봐도 최종 1개로 dedup (로그에 병합 건수).
- 1문 방: 기존과 동일 결과(회귀 없음, `--max_doors 1` 경로).
