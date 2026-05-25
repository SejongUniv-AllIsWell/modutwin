# CLAUDE.md — 3DGS Digital Twin Platform

## Overview

A web platform that creates digital twins of building interiors using 3D Gaussian Splatting.

Flow: 사용자가 외부에서 학습한 `.ply` 업로드 → 브라우저에서 정제·정합 → 서버에 결과 저장 → 웹 뷰어 서빙.

컴퓨트 책임 분배:
- 클라이언트(사용자 하드웨어): PLY 파싱·편집, 외부 가우시안 제거 + 경계면 정제, 텍스처 베이크 (WebGPU), 문 정합, 렌더링 — SuperSplat Editor 방식.
- 서버: 인증, MinIO 객체 스토리지 릴레이(프리사인드 URL), 메타데이터 CRUD, 실시간 알림. COLMAP→3DGS 전처리 파이프라인은 Celery 워커가 처리.
- GPU 서버(학습용): 사용자가 외부 도구로 학습한 PLY 결과물을 직접 업로드하는 경로 / COLMAP zip 업로드 시 worker 가 COLMAP→3DGS 자동 수행. 둘 다 지원.

## Tech Stack

| Role        | Technology                                 |
| ----------- | ------------------------------------------ |
| Frontend    | Next.js (App Router, TypeScript, Tailwind) |
| 3DGS Engine | PlayCanvas Engine + 자체 PLY 파서/라이터 (전 속성 접근) |
| Backend     | FastAPI + SQLAlchemy (async) + Alembic     |
| Database    | PostgreSQL                                 |
| Cache       | Redis                                      |
| Storage     | MinIO (S3-compatible object storage)       |
| Worker      | Celery (RabbitMQ broker) — COLMAP/3DGS 파이프라인 |
| Map         | KakaoMap API                               |
| Auth        | Google OAuth 2.0 + JWT                     |
| Proxy       | Nginx                                      |

## Deployment

```
[PC] docker compose
├── nginx           :80/443
├── frontend        :3000
├── backend         :8000
├── worker          (gsplat 학습 워커)
├── colmap-worker   (COLMAP 전처리 워커)
├── postgres        :5432
├── redis           :6379
├── rabbitmq        :5672
├── minio           :9000
└── flower          :5555 (옵션: --profile monitoring)
```

## Coordinate Conventions ⚠ 매번 헷갈리는 곳

### 프레임 (4종류)

네 좌표계가 동시에 살아있어 코드를 만질 때 *지금 어느 프레임에 있는지* 항상 의식해야 한다.

1. **Raw PLY 프레임** — `splatData.posX/Y/Z` 의 값. PLY 파일 그대로의 좌표.
2. **A' 프레임 (= raw + pendingRotation rotX/rotZ)** — `splatEntity` 의 local rotation 으로 적용 (`applyEntityRotation` in useRefineTool). 다듬기 화면에서 사용자가 보는 좌표 = Z-180 · A'. 텍스처 베이크의 source scene (`buildRotatedScene`) 도 이 프레임으로 회전된 사본을 사용 → mesh corners 는 A' 프레임. WallModal 의 `wallAngle` (Y축 회전) 은 화면 entity 에는 적용 안 되고 평면 정의 (`surfacePlanesFromPolygon` / surface normal) 에만 들어감.
3. **A'+Y 프레임 (= raw + pendingRotation + wallAngle Y)** — 문 설정 완료 시점 `commitRefinedToServer` 에 PLY 와 mesh corners, doors corners 모두 이 프레임으로 베이크되어 서버에 저장. 재진입 시 splatEntity 에 default Z-180 만 부여해도 정렬 상태 표시됨.
4. **World (렌더) 프레임** — 사용자가 화면에서 보는 좌표. `splatEntity.getWorldTransform()` 적용 결과. 카메라 (`cameraEntity.getPosition()`, `.forward`) 도 이 프레임.

프레임 사이 변환:
- 다듬기 단계: `A' → World` = `splatEntity` 에 **Z-180** + pendingRotation local rotation. wallAngle 은 entity 에 안 들어가고 평면/메시 corners 정의에만 영향.
- 정합 단계 (또는 재진입): `A'+Y → World` = `splatEntity` 에 **Z-180** 만 부여.
- 메시 엔티티 (`createWallMeshEntity`, `createWallMeshFromPersisted`) 는 corners 가 A' (다듬기 도중) 또는 A'+Y (재진입) 프레임. **메시는 Z-180 만 부여하고 `app.root` 에 직접 부착** — `splatEntity` 자식으로 붙이면 pendingRotation 이중 적용.
- SOG/Supersplat 호환을 위해 baseline Z-180 (`setLocalEulerAngles(0, 0, 180)`) 컨벤션. `(x, y, z) → (-x, -y, z)`.

### Z-180 으로 인한 시각/코드 라벨 불일치

PLY 의 `+Y` 축이 World 의 `-Y` 가 되므로:
- 코드 surfaceId `'ceiling'` (PLY +Y 면) = 화면상 **방 바닥**
- 코드 surfaceId `'floor'` (PLY -Y 면) = 화면상 **방 천장**

UI 라벨에서 swap 하지만 **코드에서 surfaceId 직접 다룰 때는 PLY 프레임의 ceiling/floor 인지 시각 기준인지 확인**.

### PlayCanvas 카메라 / lookAt

PlayCanvas 는 right-handed Y-up. 카메라는 **자신의 -Z 방향을 향함**. `entity.lookAt(target, up)`:

```
localZ = -(target - pos)
localY = up
localX = cross(localY, localZ)
```

`up` 의 부호 하나로 화면 좌우/상하가 통째로 뒤집힐 수 있음. 위에서 아래로 내려다보는 카메라 (top-down floorplan 등) 는 `up = (0, 0, -1)` 사용 — `frontend/src/lib/gs/floorplan.ts` 주석 참고.

### 카메라 방향 정보

- `cameraEntity.getPosition()` → World 프레임 카메라 위치.
- `cameraEntity.forward` → World 프레임 단위 벡터 (= -localZ). 미니맵 화살표는 `(forward.x, forward.z)`.
- `cameraEntity.right`, `cameraEntity.up` → 카메라 local basis 의 world 표현.

## Core Rules

### Authentication

- Google OAuth → JWT (Access 30min / Refresh 7days).
- Admin: `users.role = 'admin'` → basemap 승인/수정 권한.

### MinIO Object Keys

실제 경로 구조 (`services/storage_paths.py:module_base_path`):

- `buildings/{building_id}/{floor_id}/modules/{module_id}_{module_name}/alignment/{uuid}_local.ply` — placeholder 원본 PLY 키 (register-local 정책).
- `buildings/{building_id}/{floor_id}/modules/{module_id}_{module_name}/alignment/refined/{session_id}/`
  - `final.ply` — 정제된 가우시안 PLY (회전 적용: pendingRotation rotX/rotZ + wallAngle Y, flatten/brush 마스크 적용).
  - `mesh.json` — wall mesh 메타 (corners[4][3], uvs[4][2], normalInward, textureFilename).
  - `tex_{surfaceId}.png` — 면별 베이크 텍스처 (현재 6면 고정: ceiling/floor/w1a/w1b/w2a/w2b).
- `buildings/{building_id}/{floor_id}/modules/{module_id}_{module_name}/alignment/refined/doors.json` — refined 디렉토리 직속. 도어 corners + 메타 + (basemap 한정) doorMesh/doorSplat 자산 참조.
- `buildings/{building_id}/{floor_id}/modules/{module_id}_{module_name}/alignment/refined/tex_<doorId>.png`, `<doorId>.ply` — basemap 도어별 mesh 텍스처 + 가우시안 PLY.

업로드 정책:
- 모듈 등록 — `POST /uploads/commit-final` multipart 1회 (정합 완료 시 atomic 일괄).
- 베이스맵 등록 — `POST /refine/refined-multipart-init` / `complete` (PLY) + `POST /refine/refined-upload-url` (mesh/tex/도어 자산).
- COLMAP zip 업로드 — `complete_upload` 단계에서 `dispatch_colmap_task` → worker 가 처리.

`aligned.ply` 는 **저장하지 않음** — `final.ply` + `module.alignment_transform` 으로 재계산 가능.

### Refine 결과 저장 (SceneOutput)

- `Task` (door_alignment, completed) + `SceneOutput` (ply_path = `final.ply` 키) 생성.
- mesh.json 과 PNG 들은 `ply_path` 의 디렉토리 (`{base}/refined/{session_id}/`) 에 같이 위치 — 별도 DB 컬럼 없음.
- 같은 upload 에 여러 번 저장 시: 가장 최근 SceneOutput 이 활성 (created_at desc, limit 1).

### Door Alignment

- basemap 은 고정. module 의 정합은 **4×4 rigid transform 행렬을 `modules.alignment_transform` 에 저장**. 뷰어가 렌더 시 transform 적용. `aligned.ply` 저장 X.
- **rectFit** (`lib/alignment/rectFit.ts`) — 사용자 픽이 `normalizeDoorRect` 로 완벽한 직사각형이 보장되므로 SVD 기반 Kabsch 대신 두 사각형의 직교 basis 비교로 R, t 를 한 번에 산출. 180° 매칭 모호성 없음.
  - `dstForcedN` 옵션: dst basis 의 n 을 외부에서 지정 → cornerpick winding 무관하게 deterministic 결과. basemap door 의 `normalInward` 메타가 ground truth.
- **gap 의미**: basemap 도어와 module 도어는 **각자 자기 facade 위에 그대로** 위치해야 하고, 정합 후 두 facade 가 `gap = max(1.7cm, doorHeight × 2.3%)` 만큼 평행 이격됨. 그 사이 공간(= 벽/도어 두께) 은 `createDoorFrameMesh` ([AlignPanel.tsx](frontend/src/components/viewer/tools/AlignPanel.tsx)) 가 module 4코너 ↔ basemap 4코너를 잇는 4면 quad mesh 로 채움.
  - 구현: rectFit 의 dst (basemap door corners, world) 를 `pushN = -dstN` (= basemap_outward = module 방 안쪽) 방향으로 `gap` 밀어 fit. 결과 transform 적용 시 module facade 가 basemap facade 로부터 `gap·pushN` 떨어진 평행 평면에 놓임. module door = module facade, basemap door = basemap facade, 두 도어 사이 4면 frame mesh 가 두께를 형성.
  - frame mesh 는 `doorPivotGroup` 의 자식 — 도어 열기 슬라이더 회전 시 양 facade 도어 + frame 이 한 묶음으로 회전.
- 자동 검출은 SAM3 (door-ml HTTP) — 모듈 흐름은 임시 PLY 보관 후 동기 forward (`POST /uploads/sam3/detect-temp`).
- `DoorAlignModal` 의 "문 경계 정제하기" 토글: 4점 직사각형의 4 edge plane 에 걸친 가우시안을 boundary 위치 기준 분할 (`lib/gs/doorTrim.ts::decomposeBoundaryGaussians`) → 메인 PLY GPU 의 boundary slot 은 wall-side sub 로 in-place 갱신, door-side sub 들은 별도 GaussianScene → `useAdditionalGsplats` 추가 splat. wall mesh 의 도어 영역 텍셀은 alpha=0 punch, 도어 영역만 별도 베이크해서 도어 mesh 엔티티 생성. 슬라이더 변경 시 600ms 디바운스 자동 재적용.
- `lib/alignment/` 에는 rectFit 외 RANSAC rigid(`ransacRigid`), 평면 RANSAC fit(`ransacPlaneFit`), OBB 4꼭짓점 추출(`fitOrientedRectangle`), Kabsch (보조) 등 유틸이 있음.

### 도어 계층 구조 (정합 시 통합 회전 단위)

```
Door (정합 후 doorPivotGroup, AlignPanel 이 생성/회전)
├── ModuleDoor (entity 이름 'moduleDoor', wrapper)
│   ├── door mesh quad (createWallMeshEntity)
│   └── 도어 영역 가우시안 splat (additional layer)
└── BasemapDoor (entity 이름 'basemapDoor_<doorId>', wrapper, 호수별 N개)
    ├── door mesh quad
    └── 도어 영역 가우시안 splat (additional layer)
```

- wrapper.enabled 토글 한 번에 자식 mesh + splat 동시 hide/show. LayerPanel 의 토글 핸들러가 wrapper 부모 감지해서 cascade.
- `enterAlignmentMode` 가 `moduleDoor` wrapper 도 alignmentGroup 으로 reparent 대상에 포함.
- AlignPanel 의 도어 열기 슬라이더 — 정합 대상 basemap 도어 ID (`basemapTargetDoorId` prop) 만 doorPivotGroup 에 묶음. 다른 호수의 basemapDoor_* wrapper 는 제자리 유지.

### Basemap

- 초기에는 관리자가 생성, 기본적으로 불변.
- 변경 시: 전역 변환 행렬 계산 → 기존 정합된 모든 모듈에 전파 적용.

### Notifications

- 사용자 온라인: WebSocket 푸시 (Redis `ws:online:{user_id}`).
- 사용자 오프라인: PostgreSQL `notifications` 저장 → 재접속 시 전달.

## Editor Workflow (4-stage)

`UnifiedSplatEditor` 의 `EditorMode = 'refine' | 'door' | 'align' | null`. 사이드바 4탭: 업로드 / 다듬기 / 문 설정 / 정합.

단방향 lock (`lockedStages`):
- 다듬기 완료 → `upload` + `refine` 잠금 (취소선/회색).
- 문 설정 완료 → `door` 추가 잠금. 정합 단계로 진입.
- 잠긴 이유: 이전 단계를 되돌리면 후속 의존성 깨짐 (경계면 변경 시 베이크된 텍스처/mesh/문 corners 모두 무효).

이탈 보호 (`refine`/`door` 모드 활성 중):
- 브라우저 새로고침/닫기 → `beforeunload` 경고.
- 사이드바 탭 변경 → confirm. 완료 버튼 (force=true) 만 bypass.

서버 영속 타이밍 (흐름별):

- **모듈 등록 (`purpose=module`)**:
  - 다듬기 + 문 설정 메모리 유지.
  - 사이드바 다듬기 완료 시점에 `ensure-registration-context` + `register-local` 호출 → uploadId 발급 (모달 없이 자동 — `initialRegistrationContext` 가 채워져 있을 때).
  - 정합 완료 시점에 `POST /uploads/commit-final` 로 modules/uploads/tasks/scene_outputs + MinIO 자산을 atomic 일괄 영속화.
  - SAM3 자동 검출은 파일 선택 직후 백그라운드 임시 업로드 + 동기 forward (`/uploads/sam3/prepare` → `/uploads/sam3/detect-temp`).
  - 자세한 단계별 흐름은 본 문서의 [모듈 등록 흐름](#모듈-등록-흐름) 섹션 참고.
- **베이스맵 등록 (`purpose=basemap`)**:
  - 다듬기 단계는 메모리 + localStorage (`refine_state_v5_{uploadId}`) 기반.
  - "Basemap 등록 완료" 시점에 `register-local-basemap` + `commitRefinedToServer` + 도어별 영속화 + `/basemaps/register` 일괄 처리.
  - 정합 단계는 베이스맵 자체엔 의미가 없어 진입하지 않음.

## Refine Pipeline (씬 정제 순서)

브라우저에서 수행:

1. 사용자 수동 정렬 — Y축 up 회전/반전 + 천장/바닥 (`CeilingFloorModal`, 히스토그램 자동 후보) + **벽면 폴리곤** (`WallModal`).
2. 외부 가우시안 제거 (`lib/gs/floaters.ts`) — 각 경계면 바깥 `margin_out` 초과 가우시안 삭제. `near_protect` 이내 표면 본체는 보호.
3. Wall mesh + 텍스처 베이크 (`lib/gs/textureBake.ts`, `textureBakeGPU.ts`, `wallMesh.ts`) — 각 경계면 정사영 + alpha 컴포지팅으로 텍스처에 굽고, paint 위치에 텍스처 입힌 quad 메시로 표시.
4. 경계면 정제 (`lib/gs/clipping.ts`) — 방 경계면 바깥으로 뻗어나가는 가우시안 scale shrink (`f = |sd| / 3σ`).
5. **다듬기 완료** → 모듈 흐름은 이 시점에 `register-local` 호출. 문 설정 단계로 transition.
6. 문 설정 (`DoorAlignModal` setup view) — SAM3 프롬프트 → 4점 클릭 → 문 추출 (boundary split + wall mesh α punch + 도어 mesh 별도) → 회전축/각도/방향.
7. **문 설정 완료** — 흐름별 분기:
   - 모듈: 메모리 유지 + `onSetupSaveDone(uploadId, doorCorners)` 콜백으로 부모에 4 corners 전달 (A'+Y 프레임). 서버 영속 X.
   - 베이스맵: refined PLY + mesh.json + tex_*.png + doors.json + 도어 자산 백그라운드 일괄 업로드.
   둘 다 정합 단계로 transition (베이스맵은 dashboard redirect).
8. 정합 (`AlignPanel`) — 4점 자동/수동 → rectFit → 행렬 산출 → 흐름별 분기:
   - 모듈: `POST /uploads/commit-final` 멀티파트로 PLY+mesh+tex+doors+alignment_transform 일괄. 덮어쓰기 시 기존 자산 청소.
   - 베이스맵: 해당 단계 없음.

### WallModal 폴리곤 모드

`WallModal` 은 폴리곤 단일 모드:
- 캔버스에 점을 좌클릭으로 추가, 직전 선택점과 자동 edge 연결.
- 기존 점 좌클릭 드래그 (document mousemove/up 추적) — 캔버스 밖으로 나가도 끊김 없음.
- 우클릭 — 마지막 조작 (점/edge/이동) 1단계 undo.
- edge 점들로 `wallsFromPath` 가 eigenvector 기반 회전 + 4벽 (axis-aligned bbox) derive.

⚠️ 현재 출력은 `(angleDeg, [a1, b1, a2, b2])` — axis-aligned 4벽. 다운스트림 텍스처 베이크/문 픽킹이 이 형식을 가정. N-각형 폴리곤 그대로 텍스처 베이크는 향후 작업 ([TODOLIST.md](TODOLIST.md) 참고).

### Wall mesh 베이크 세부

- 각 면의 sd 히스토그램 (1cm 빈, opacity 가중) 으로 paint plane 자동 검출 (paintSd). 진단/로깅용.
- **메시 위치 = `MESH_PLANE_INSET = 0`.** 사용자가 모달에서 정의한 경계면(sd=0) 에 정확히 배치. 6면 동일 오프셋이라 직육면체 코너에서 인접 면과 정확히 만남.
- **베이크 시작(depthGate)** 도 사용자 경계면 기준. `bakeInnerGate` 슬라이더 default 0 = 경계면(sd=0) 에서 시작.
- **autoGate 자동 확장** (`bakeTextureForPlane::opts.autoMargin`):
  - `autoMargin > 0`: paintSd 기반으로 안쪽까지 자동 확장. DoorAlignModal 도어 베이크 default 0.05.
  - `autoMargin = 0`: paintSd 무관하게 `depthGate` 그대로 (strict). useRefineTool `bakeWallMeshTest` 가 명시적으로 0 전달.
- GPU 컴퓨트 셰이더 (16×16 workgroup) + 타일 binning (`textureBakeGPU.ts`): 텍셀 타일마다 영향받을 splat 인덱스 사전 계산 → 픽셀당 ~10 splat 만 순회. WebGPU 실패 시 CPU 폴백.
- bake 입력은 raw PLY 프레임 (Z-180 적용 전). 메시 엔티티는 app.root 에 직접 부착하고 Z-180 만 부여.

### 영속화 + 정합 연결 흐름

#### 모듈 등록 흐름
1. 사용자 호수 휠 피커 (floor 페이지) → 본인이 이미 그 호수에 등록한 모듈 있으면 confirm → /viewer 진입 (`initialRegistrationContext.purpose='module'`).
2. 파일 선택 직후 백그라운드 `POST /uploads/sam3/prepare` — PLY 를 백엔드 임시 디스크 (`/var/lib/sam3-temp`) 저장. 30분 TTL 자동 청소.
3. 다듬기 완료 시점에 `requestMetadata` 가 `autoFinalizeFromContext` 호출:
   - `ensure-registration-context` → building/floor/module 확정 (필요 시 생성).
   - `register-local` → Upload 행 생성, uploadId 발급.
4. 자동 문 검출 시 `POST /uploads/sam3/detect-temp` 동기 호출 → 임시 PLY 를 door-ml `/detect` 로 forward → corners 반환 (베이크 회전 적용된 좌표계).
5. 문 설정 완료 — `DoorAlignModal.onSetupSaveDone(uploadId, cornersForParent)` 가 corners 를 부모에 직접 전달 → `moduleDoorCorners` 즉시 세팅. 서버 doors.json fetch 불필요.
6. 정합 완료 (`AlignPanel.saveResult`) — `onCommitFinal` 콜백. `refine.gatherRefinedAssets()` 로 메모리에서 PLY+mesh+tex 6장 빌드 + setupDoorCornersRef 로 doors.json 직렬화 + alignment matrix → `POST /uploads/commit-final` multipart 일괄. 백엔드가 atomic 처리.
7. 성공 응답의 `was_overwrite` 가 true 면 사용자에게 알림 + 층 페이지로 이동.

#### 베이스맵 등록 흐름 (다중 도어)
1. 진입 모달 (`/buildings/[name]/page.tsx`) — basemap 전체 이름 입력 안 받음. 호수는 도어별 unitName 으로 부여.
2. 다듬기 (천장/바닥/벽 폴리곤 + 외부 가우시안 제거 + 벽 메시 베이크).
3. 문 설정 단계 — 자동 검출 또는 수동 4점:
   - 4점 픽 완료 → `applyDoorRefine` 자동 실행 → 도어 추출 + 메시/splat 생성 + alpha=0 punch.
   - 추출 직후 메모리 도어 리스트 (`inMemoryDoors`) push + 호수 휠 피커 모달 자동 오픈.
   - 사용자가 호수 (N01~N99) 선택 → 도어 unitName 부여.
   - picked 자동 초기화 → 다음 도어 4점 픽 가능 (다중 도어 반복).
4. 도어 목록 박스:
   - 호수 설정됨: 🚪 `601호` + X 삭제.
   - 호수 미설정: 노란 강조 + ⚠️ + 클릭 시 휠 피커 재오픈.
   - X 클릭 → `basemapDoor_<doorId>` wrapper destroy (mesh+splat cascade) + outline 정리 + 벽 텍스처 alpha=0 punch 복원.
5. "Basemap 등록 완료" (호수 미설정 도어 있으면 비활성) → 일괄 영속:
   - `ensureUploadId` → `/uploads/register-local-basemap`.
   - `onCommitRefined` → basemap PLY (multipart) + mesh.json + tex_*.png 업로드.
   - 각 도어: `tex_<doorId>.png` + `<doorId>.ply` 업로드 (`/refine/refined-upload-url`).
   - `PUT /uploads/{id}/doors` — 모든 도어 메타 (corners + doorMesh + doorSplat 참조).
   - `/basemaps/register` (활성화).
6. 완료 모달 — 메인/건물/대시보드 이동 선택.

#### 공통
- `/viewer?upload_id=X` 베이스 뷰어 — `useRefinedMeshLoader` 가 가장 최근 SceneOutput 의 PLY + mesh + tex + 도어 자산 자동 로드.
- `/viewer?upload_id=X&mode=align` — 대시보드의 "정합" 진입 경로. `initialMode = 'align'`.
- 라우팅 변경 없음: 문 설정 완료 → 정합은 같은 페이지에서 `setMode('align')` 만.
- DoorAlignModal 마운트 시 서버 corners 가 있으면 1회 자동 문 추출 — 재진입 시 회전 즉시 가능.
- 호수별 도어 필터: 정합 단계에서 `useRefinedMeshLoader` 의 `onlyDoorUnitName` 옵션으로 매칭된 호수의 basemap 도어만 레이어 패널에 표시 (`meta.hiddenInPanel`). 디스플레이는 모든 도어 유지.

## Commands

```bash
docker-compose up -d                                  # Start all services
docker-compose up -d --build frontend backend         # Rebuild
docker-compose logs -f backend                        # View logs
docker-compose exec backend alembic upgrade head      # DB migration
docker-compose exec backend pytest                    # Backend tests
docker-compose exec frontend npm test                 # Frontend tests
```

향후 작업 목록은 [TODOLIST.md](TODOLIST.md) 참고.
