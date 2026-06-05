# 클라이언트 렌더 → 서버 SAM3 문 검출 구현 계획 (v2, 계약 정정본)

## 0. 목적 / 배경

현재 모듈 등록의 자동 문 검출은 **다듬기 완료 → 임시 보관소(`/var/lib/sam3-temp`)로 refined PLY 백그라운드 업로드(`/uploads/sam3/prepare`) → 동기 `/uploads/sam3/detect-temp` 가 그 PLY 를 door-ml `/detect` 로 forward(backend relay) → door-ml 이 서버 GPU 로 다수 뷰 렌더 + SAM3 → A' 코너 반환** 순서다. 병목은 **임시 PLY 업로드(수십~수백 MB)** 다.

본 계획은 **렌더를 사용자 브라우저(PlayCanvas)로 옮긴다**. 서버에는 **렌더 이미지 + 카메라 포즈 + 방 기하(전부 소용량)** 만 보내고, door-ml 은 렌더를 생략하고 SAM3 + 기존 ray∩wall-plane 코너 추출만 수행한다.

> **v2 정정 요지** — v1 초안의 계약 3건이 실제 파이프라인과 불일치하여 전면 수정:
> 1. 카메라는 PlayCanvas `viewmat` 가 아니라 **OpenCV `c2w`(cam-to-world)**, 이미지는 **upright(비-flip)** 로 보내고 prerendered 경로는 `pixel_rotate_cw_to_orig` 를 **건너뛴다**.
> 2. 방 기하는 "world XZ + wallAngle" 가 아니라 **A' 프레임**(현행 detect-temp known-room 필드 그대로).
> 3. 통합 진입점은 `/sam3/start`(basemap async)가 아니라 **모듈 동기 경로 `/uploads/sam3/detect-temp`**, **backend relay 유지**.

### 검증으로 확정된 사실 (구현 전제)
- 프론트 렌더 = **PlayCanvas 2.1.0 / WebGL2** (`SplatViewerCore.tsx:413` 레거시 `new pc.Application()`).
- 오프스크린 렌더 → PNG → 카메라 메타 직렬화가 이미 production 에 존재: `snapshotTopdown` (`SplatViewerCore.tsx:258`), `preserveDrawingBuffer:true` (`SplatViewerCore.tsx:417`).
- 서버 SAM3 는 **PNG 1장 + 텍스트 프롬프트만으로** 동작(PLY 무관): `run_sam3_single_with_model` (`sam3_runner.py:529`), GPU ~0.16s/256px, 문 정면 뷰 score 0.8 (실측).
- back-projection 은 **깊이 불필요**: ray ∩ wall-plane (`pipeline.py` Phase 9~10, `room/wall_planes.py`). 벽 평면은 다듬기에서 사용자가 A' 프레임으로 정의(known-room).

---

## 1. 범위 / 핵심 결정 (먼저 합의 필요)

- **결정 A — 적용 플로우 분리**: 본 계획은 **모듈 등록 자동검출(`/uploads/sam3/detect-temp`)만** 대상으로 한다(Phase 1). **basemap 비동기 경로(`/uploads/sam3/start` + `sam3_door_ml.py` + Celery)는 범위 외**(Phase 2 후속). 두 경로는 입력 계약·동기성이 달라 함께 바꾸지 않는다.
- **결정 B — 네트워크: backend relay 유지**. 브라우저 → **backend** → door-ml(`httpx`, `settings.DOOR_ML_URL`). 현행 배포 구조(claude.md)가 door-ml 을 내부망으로 두므로, **브라우저 직통 door-ml 은 채택하지 않는다**(별도 네트워크/인증 설계가 필요해 비용 대비 이득 낮음).
- **결정 C — PLY 업로드 시점 이동**: 검출에는 PLY 불필요. 단 `commit-final` 영속화에는 refined PLY 가 여전히 필요하므로, 기존 `prepare` 의 선업로드를 **commit 시점으로 미룬다**(검출 병목 제거, commit 지연은 소폭 증가 — §7 트레이드오프).

---

## 2. 목표 데이터 흐름

```
[브라우저 / PlayCanvas]  (다듬기 완료: A' 폴리곤 + ceiling/floor Y + raw→A' 회전 보유)
  ① 벽 정면 고정 뷰셋 계산 (raw PLY 프레임에서)
  ② 각 뷰 오프스크린 렌더(256px, upright) → PNG
  ③ 각 뷰 K(OpenCV) + c2w(OpenCV, raw 프레임) 수집
        │  multipart (이미지들 + 포즈 + A' 방기하)  ≈ 수 MB 이하
        ▼  POST /uploads/sam3/detect-temp-image   (신규, 동기)
[backend]  인증/검증 후 relay
        ▼  POST {DOOR_ML_URL}/detect_image  (multipart)
[door-ml]
  - 렌더(Phase 0~2) SKIP, prerendered 입력 사용
  - 카메라/ray 를 raw→A' 변환(bake_rotation_matrix)
  - 뷰별 SAM3 (검증된 단건 경로)
  - Phase 7~11 재사용: quad/ordering → world ray(upright, no vflip) → ray∩wall(A') → A' 코너
        ▼
  A' 코너 반환  → backend → 프론트(현행 detect-temp 응답 스키마 그대로) → wallAngle 적용
```

---

## 3. 계약 명세 (정정 핵심)

### 3.1 카메라 — OpenCV `c2w`, raw 프레임
- 파이프라인은 `CameraView.c2w`(4×4, **OpenCV cam-to-world**: x→right, y→down, z→forward)와 OpenCV `K` 를 소비한다(`camera_sampler.py:24`, `ray.py:44`).
- PlayCanvas 카메라는 우수좌표(x→right, y→**up**, z→**backward**). 변환:
  ```
  R_pc = [right | up | -forward]            # PlayCanvas 카메라 basis (열벡터, world 기준)
  R_cv = [right | -up | forward] = R_pc · diag(1,-1,-1)
  c2w  = [[R_cv, cam_pos],[0,0,0,1]]        # OpenCV cam-to-world
  ```
- **프레임**: 클라가 splat 을 로드한 **raw PLY 프레임** 그대로(다듬기 detect 시점 뷰어 프레임). 서버가 raw→A' 변환을 책임진다(§3.4).

### 3.2 Intrinsics `K` (OpenCV 픽셀)
```
cx = w/2, cy = h/2
fy = (h/2) / tan(fov_v/2)        # PlayCanvas camera.fov(세로 FOV) 기준
fx = fy                          # 정사각 픽셀, aspect=1 (w=h=256)
K  = [[fx,0,cx],[0,fy,cy],[0,0,1]]
```
PlayCanvas projection 행렬에서 직접 역산해도 동일. **w=h=256 고정**(서버 dev_pjh 해상도 일치).

### 3.3 이미지 — upright(비-flip), prerendered 는 `pixel_rotate` 생략
- 서버 자체 렌더 경로는 gsplat 출력을 `np.flipud` 로 저장하고 `pixel_rotate_cw_to_orig()` 로 역변환한다(`ray.py:30`).
- 브라우저 `canvas.toBlob()` 캡처는 **이미 upright**(상단=장면 위, 좌측=장면 좌측; 픽셀 원점 top-left, +v 아래 = OpenCV 픽셀 규약과 일치).
- 따라서 **prerendered 모드는 `pixel_rotate_cw_to_orig` 를 적용하지 않고 항등(identity)** 으로 둔다. SAM3 코너 픽셀 → `pixel_to_world_ray(u, v, K, c2w)` 직접 사용.
- 회귀 방지: prerendered 분기는 별도 플래그로 분리해 기존 서버-렌더 경로의 vflip 처리를 건드리지 않는다.

### 3.4 방 기하 — A' 프레임 (현행 detect-temp 와 동일)
- known-room 은 **A' 프레임** wall_polygon(A' X-Z), floor_y, ceiling_y, raw→A' 회전(rot_x, rot_z)을 기대한다(`module_register.py:112`, `pipeline.py:322`, `wall_planes.py:14`).
- ⚠️ `buildFinalSurfacePlanes()` 는 **wallAngle 을 적용해 A'+Y** 로 돌리므로 **사용하지 않는다**. 대신 현재 detect-temp 가 이미 보내는 값(프론트 `getRemainingRotationToAY()` + A' 폴리곤/천장/바닥)을 그대로 재사용.
- 서버: `rot_raw_to_ap = bake_rotation_matrix(rot_x, rot_z)`(이미 존재) 로 **카메라 c2w 와 ray(origin/dir)를 raw→A' 변환** 후 A' 벽 평면과 교차. (현행 known-room 이 렌더용으로 A'→raw(`cam_rot=Rᵀ`)를 쓰는 것의 역방향.)

### 3.5 API
**프론트 → backend** `POST /uploads/sam3/detect-temp-image` (multipart, 동기):
| 필드 | 타입 | 설명 |
|------|------|------|
| `views` | file[] PNG | `view_{idx:04d}.png`, 모두 256×256 upright |
| `meta` | file JSON | `{ image_size:[256,256], views:[{idx,K,c2w}], prompt }` (c2w=raw 프레임) |
| (body) | | 기존 detect-temp 와 동일한 A' known-room 필드: `rot_x,rot_z,floor_y,ceiling_y,wall_polygon,bake_rotation,prompt` |

**backend → door-ml** `POST {DOOR_ML_URL}/detect_image` (multipart): 위 `views`+`meta`+known-room params 를 relay.

**응답**: 현행 `Sam3DetectTempResponse`(A' `corners` 4점 + 메타) **그대로** → 프론트 변경 최소화.

---

## 4. 구현 — door-ml(서버)

### 4.1 `/detect_image` 핸들러 (`door_ml/main.py`)
- multipart 파싱 → `renders/view_*.png` 레이아웃으로 tmp 저장.
- `meta.views[].K/c2w` → `CameraView` 객체로 주입(렌더 생략).
- known-room params → 기존 경로와 동일하게 `PipelineConfig`/A' room 입력 구성.

### 4.2 파이프라인 prerendered 분기 (`core/door_detection/pipeline.py`)
- 신규 진입 `run_from_prerendered(renders_dir, cameras, room_known(A'), prompt, config)`:
  - **Phase 0~2(샘플링/렌더) SKIP**.
  - **pixel 매핑 = identity**(`pixel_rotate_cw_to_orig` 미적용, §3.3).
  - **카메라/ray raw→A' 변환**(§3.4) 후 Phase 9 ray 생성.
  - Phase 3 SAM3: `load_sam3_model_and_processor` + `run_sam3_single_with_model`(검증 완료) 재사용.
  - Phase 7·8·9·10·11(quad/ordering/ray/ray∩wall/코너) **그대로 재사용**.
  - 뷰 선택: 클라가 벽 정면 고정셋을 보내므로 iterative 루프 불필요. `all_corners_visible` 평가만 유지해 best view 선정.

### 4.3 SH degree 0
- 1차: 클라 **full-SH** 렌더로 SAM3(실측상 score 0.8 검출).
- 부족 시: 클라에서 `gsplatData` 의 `f_rest_*` 0으로 둔 별도 렌더패스(앱이 이미 `getProp` 편집 보유) → 변형 sibling 제공, 서버 `_run_sam3_for_image_variants` 가 활용.

---

## 5. 구현 — 프론트엔드

### 5.1 뷰셋 생성기 (신규 `frontend/src/lib/gs/doorViewSet.ts`)
- 입력: **A' 폴리곤 + ceiling/floor Y**(다듬기 보유) → 벽 정면 카메라 N개 `{position,target,up,fov}` (raw 프레임으로 환산).
- 서버 `sample_wall_facing_cameras`(standoff×1.2, eye-height) 규약 포팅. 결정적 → 반복 렌더 불필요.

### 5.2 `renderViewsForDoor` (`SplatViewerCore` 확장, snapshotTopdown 일반화)
```ts
renderViewsForDoor(views: CameraSpec[], opts?: {size?:number}):
  Promise<{ idx:number; blob:Blob; K:number[][]; c2w:number[][] }[]>
```
- 뷰마다: perspective 카메라 설정 → 2 RAF 대기(기존 패턴) → `canvas.toBlob`(upright) → K/c2w 계산(§3.1·3.2). 캡처 후 카메라 원복(기존 저장/복원 재사용).

### 5.3 배선 (`UnifiedSplatEditor` detect 분기)
- 현행 detect-temp 호출부(`UnifiedSplatEditor.tsx` ~1323, `getRemainingRotationToAY()` + A' 필드 전송)를 **피처 플래그 `CLIENT_RENDER_SAM3`** 로 분기:
  - ON → `renderViewsForDoor` 결과(이미지+포즈) + 동일 A' known-room 필드를 `/uploads/sam3/detect-temp-image` 로 POST. **prepare 의 PLY 선업로드 생략**.
  - OFF → 기존 PLY forward 경로(fallback).
- 응답 코너 처리(wallAngle 적용 등)는 **현행 로직 그대로**.

---

## 6. 작업 순서

1. **서버 prerendered 코어**: `pipeline.run_from_prerendered`(Phase 7~11 재사용 + identity pixel + raw→A' 변환) + `/detect_image`.
2. **backend relay**: `/uploads/sam3/detect-temp-image`(인증/검증 → door-ml `/detect_image`).
3. **프론트 `renderViewsForDoor`**(K/c2w OpenCV 직렬화) + **뷰셋 생성기**.
4. **배선 + 피처 플래그**(prepare PLY 선업로드 우회, commit-final 시 업로드).
5. **파리티 검증**: 동일 장면 (PLY 경로) vs (이미지 경로) **A' 코너 world 오차(cm)** 비교 → 임계 내 확인. 초과 시 §3.1 축 부호 / §3.3 upright / §3.4 raw→A' 점검.
6. **롤아웃**: 플래그 ON 기본, PLY 경로 fallback 유지.

---

## 7. 영향 / 리스크 / 트레이드오프

- **이득**: 검출용 임시 PLY 업로드 제거(수십~수백 MB → 이미지셋 수 MB↓), 서버 GPU 렌더 부하 제거(SAM3만), 클라 GPU 비용 미미.
- **트레이드오프(결정 C)**: refined PLY 업로드가 prepare(백그라운드) → commit-final 로 이동 → commit 체감 지연 소폭 증가. 필요 시 commit 직전 백그라운드 업로드로 완화.
- **리스크**: ① 렌더 파리티(§6-5 로 닫음) ② 좌표/축 부호(§3) ③ WebGL2 SH0(§4.3 fallback).
- **롤백**: 피처 플래그 OFF → 기존 경로 즉시 복귀(기존 코드 보존).

---

## 8. 변경 파일 요약

신규:
- `frontend/src/lib/gs/doorViewSet.ts` — 벽 정면 뷰셋(raw 프레임)
- `door_ml/main.py` — `POST /detect_image`
- `backend/app/api/...` — `POST /uploads/sam3/detect-temp-image`(relay)
- `core/door_detection/pipeline.py` — `run_from_prerendered`(identity pixel + raw→A')

수정:
- `frontend/src/components/viewer/SplatViewerCore.tsx` — `renderViewsForDoor`(K/c2w OpenCV)
- `frontend/src/components/viewer/UnifiedSplatEditor.tsx` — 피처 플래그 분기(prepare 우회)
- `core/door_detection/segmentation/sam3_runner.py` — prerendered 호출(단건 함수 기존)

범위 외(후속): basemap `/uploads/sam3/start` + `sam3_door_ml.py` + Celery, 브라우저 직통 door-ml.
