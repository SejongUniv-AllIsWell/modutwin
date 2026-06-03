# N-door 통합 계획 — 비정합 문도 정합 문과 동일 처리

## 0. 핵심 원칙

> **비정합 문과 정합 문의 유일한 차이는 "정합 transform(translation matrix) 계산 여부" 뿐.**

그 외 모든 처리(벽 punch + door mesh bake + door splat 추출 + hinge 경계선 + 4코너/경계 표시
+ 가우시안 다듬기)는 **N개 문 전부 동일**하게 적용한다.

## 1. 확정 결정 (사용자)

| # | 결정 |
|---|------|
| D1 | **hinge 자동 검출** — SAM3 마스크의 검은 영역(손잡이) 위치로 회전축 변 자동 결정. 손잡이 없으면 **마법사식 순차** 수동 설정. |
| D2 | 문 클릭 = **편집 활성 + 기준 문(정합) 지정 통합** (클릭 1번으로 둘 다). |
| D3 | 가우시안 다듬기 = **문별 개별 정리** (활성 문만, 기존 DoorCleanupViewerModal 재사용). |
| D4 | 모든 문: 4코너 마커 + 경계선 표시 (정합 문과 동일). 기준 문 위에 "기준 문" 라벨. |
| D5 | 기준 문 default = score 최고. 다른 문 클릭 시 기준 문 교체. |

## 2. 현재 한계 (삭제한 잘못된 dev 이전 = f977045 기준)

- 비정합 문: `bakeNonAlignmentDoors` 가 텍스처 crop 만 하고 **wall punch 누락** → 열어도 안 뚫림.
- 비정합 문: hinge 미설정(고정 left), 코너/경계 미표시, 다듬기 불가.
- 기준 문 변경 불가(첫 번째 고정).

## 3. hinge 자동 검출 (door-ml)

각 문의 대표 뷰(`src_view_idx`) SAM3 마스크에서:
1. 흰색 영역(문) 안의 **검은 hole** 중 가장 큰 것 = 손잡이 후보.
2. 손잡이 centroid X 와 문 centroid X 비교 (stored 이미지 프레임, 코너 ordering 과 동일 프레임):
   - 손잡이가 **왼쪽** → hinge = **오른쪽 변**.
   - 손잡이가 **오른쪽** → hinge = **왼쪽 변**.
   (hinge 는 손잡이 반대편 = 자유 회전하는 쪽이 손잡이.)
3. 검은 hole 이 없거나 너무 작으면(면적 < 문 면적 × ε) → `suggested_hinge_edge = null` → 프론트 마법사.
4. door-ml `all_doors[i]` 에 `suggested_hinge_edge: 0|1|2|3|null` 추가.
   - 변 인덱스 컨벤션: 0=상(LT-RT), 1=우(RT-RB), 2=하(RB-LB), 3=좌(LB-LT).
   - **주의**: 180° 렌더 회전 + pixel 컨벤션과 일관되게 좌/우 판정 (코너 ordering 과 같은 프레임).

> 비용: 마스크는 이미 메모리에 있음 → 문당 수 ms. 무시 가능.

## 4. 아키텍처 — 모듈 흐름을 다중 문으로 통합

베이스맵 흐름에 **이미 다중 문 인프라**(`inMemoryDoors`: 문마다 punch + bake + splat + hinge)가 있다.
**모듈 흐름도 이 방식으로 일반화**한다.

```
자동 추출(N개 문) → 각 문에 대해 순차:
  applyDoorRefine(문 i)  = wall punch + door mesh bake + door splat 추출 (기존 함수 재사용)
    → InMemoryDoor 유사 엔트리 (punch 반영된 wall tex, doorMeshInput, doorSplatBlob, hinge)
  → 모든 문이 코너 마커 + 경계선 + (활성 문) hinge cylinder 표시
  → 1개 문에 is_alignment=true (기준 문, default score 최고)

문 클릭 → 그 문을 활성 + 기준 문 지정 (D2). "기준 문" 라벨 이동.
활성 문에 대해서만 hinge 조정(마법사) / DoorCleanupViewerModal 정리 가능 (D3).

문 설정 완료 → commit-final:
  doors.json = N개 문 전부 (각 full: corners + doorMesh + doorSplat + hingeEdge + normalInward)
  alignment_transform = 기준 문 corners 로만 계산.
```

핵심: **`applyDoorRefine` 를 N회 호출**(문마다 punch+bake+splat). 기존 단일-문 로직을
문 루프로 일반화 (베이스맵 inMemoryDoors 경로 차용).

## 5. 구현 단계

### Step 1 — door-ml hinge 자동 검출 (backend, 작고 독립)
- [ ] `multi_door.py`: DoorStructure 에 `suggested_hinge_edge` 추가. 대표 뷰 마스크에서 손잡이 hole
      검출 → 변 결정 (§3). 없으면 null.
- [ ] door_ml/main.py, backend: `all_doors[i].suggested_hinge_edge` 전달.
- [ ] 검증: 2-door staged 에서 각 문 suggested_hinge_edge 로그 확인.

### Step 2 — 모듈 다중 문 setup (frontend, 큰 단위)
- [ ] DoorAlignModal: 모듈 모드에서 N개 문을 inMemoryDoors 유사 리스트로 관리.
- [ ] 각 문 applyDoorRefine 호출(wall punch + bake + splat) — 함수 재사용/일반화.
- [ ] 모든 문 4코너 마커 + 노란 경계선 렌더 (기존 정합 문 렌더 N회).
- [ ] 활성 문 = 노란 강조 + hinge cylinder. 비활성 = 옅은 색.
- [ ] 기준 문 위 "기준 문" HTML 라벨 (useDoorLabels 확장 or 별도 overlay).

### Step 3 — 클릭 = 활성+기준 통합 (D2)
- [ ] 문 클릭(ray ↔ 문 quad) → 활성 문 전환 + is_alignment 이동 + 라벨 이동.

### Step 4 — hinge: 자동 적용 + 마법사 (D1)
- [ ] suggested_hinge_edge 있으면 자동 적용.
- [ ] null 인 문: 활성 시 "회전축 변을 클릭하세요" 마법사 (기존 hinge 픽 UI 재사용).

### Step 5 — 문별 다듬기 (D3)
- [ ] DoorCleanupViewerModal 을 활성 문 기준으로 호출 (문 전환 시 대상 변경).

### Step 6 — N개 문 영속화
- [ ] commit-final: doors.json 에 N개 full door (corners + doorMesh tex + doorSplat + hinge).
- [ ] alignment_transform = 기준 문만.
- [ ] backend 는 door_tex_*/door_splat_* 패턴 이미 지원 (수정 최소).

### Step 7 — floor view
- [ ] 이미 다중 문 로드 + hinge 여닫기 지원 → 수정 최소 (검증만).

## 6. 시간 cost 분석

| 항목 | 비용 |
|------|------|
| hinge 자동 검출 (door-ml) | 문당 수 ms (마스크 재사용). 무시 가능. |
| 마법사 fallback | 추가 연산 0. 손잡이 없는 문만 클릭 1회 (UX). |
| **applyDoorRefine N회** | 문당 ~1-2초 (GPU punch + splat 추출). **N개 순차 → N×.** 실질 병목. |

→ N=2~3 이면 수 초. 문 많으면 늘어남. 필요시 punch/extract 를 batch 로 최적화(후속).

## 7. 좌표/프레임 주의

- 검출 코너: door-ml A'+Y → backend 변환 → 프론트 ayToRaw 로 raw 보관(기존).
- door mesh / splat / hinge: splat 프레임(A').
- commit-final: raw → A'+Y 재변환 (정합 문 1회 + 비정합 문 N-1회, 동일 경로).
- hinge 변 인덱스: door-ml(이미지) → 프론트(코너 ordering) 프레임 일관성 검증 필수.

## 8. 엣지 케이스

- 손잡이 없는 문 다수 → 마법사 다단계 (UX 다소 번거롭지만 정확).
- 같은 벽 인접 두 문 → punch 영역 겹침 주의 (각자 영역만 punch).
- 문 0개 → 기존 fail-fast / legacy fallback.
- applyDoorRefine 실패한 문 → graceful skip (punch 만이라도, 경계선 유지).

## 9. 우선순위

Step1(hinge backend) → Step2(다중 문 setup+punch) → Step3(클릭) → Step4(hinge UX)
→ Step5(다듬기) → Step6(영속화) → Step7(뷰어 검증). 각 단계 후 빌드·검증.
