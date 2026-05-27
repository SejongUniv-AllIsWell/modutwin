# CLAUDE.md — 3DGS Digital Twin Platform

## Overview

A web platform that creates digital twins of building interiors using 3D Gaussian Splatting.

Flow: 사용자가 외부에서 학습한 `.ply` 업로드 → 브라우저에서 정제·정합 → 서버에 결과 저장 → 웹 뷰어 서빙.

컴퓨트 책임 분배:
- 클라이언트: PLY 파싱·편집, 외부 가우시안 제거 + 경계면 정제, 텍스처 베이크 (WebGPU), 문 정합, 렌더링.
- 서버: 인증, MinIO 객체 스토리지 릴레이(프리사인드 URL), 메타데이터 CRUD, 실시간 알림. COLMAP→3DGS 전처리는 Celery 워커.
- GPU 서버: 사용자가 외부에서 학습한 PLY 직접 업로드 / COLMAP zip 업로드 시 worker 가 자동 수행.

## Tech Stack

| Role        | Technology                                 |
| ----------- | ------------------------------------------ |
| Frontend    | Next.js (App Router, TypeScript, Tailwind) |
| 3DGS Engine | PlayCanvas Engine + 자체 PLY 파서/라이터 |
| Backend     | FastAPI + SQLAlchemy (async) + Alembic     |
| Database    | PostgreSQL                                 |
| Cache       | Redis                                      |
| Storage     | MinIO (S3-compatible)                      |
| Worker      | Celery (RabbitMQ broker)                   |
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

### 프레임 (런타임 2종 + 디스크 1종)

- **Raw** — 디스크 PLY 파일의 원본 좌표. 런타임 코드는 거의 안 만짐 (서버 저장 시점에만 등장).
- **A'** — `splatData.posX/Y/Z` (메모리) + 모든 모듈 작업 좌표 (`picked.pos`, `moduleDoorCorners`, `wallPolygon`, `planes`, `ceilingY`, `floorY` 등). 모듈의 작업 좌표계.
- **World** — `splatEntity.getWorldTransform()` 적용 결과 = Z-180 · A' = 사용자 화면.
- **A'+Y** = A' + wallAngle Y. 서버 저장 (PLY + doors.json) 시점에만 적용. baseline = A' (런타임 모든 코드의 시각).

### A' 확립 시점

다듬기 단계 `다듬기 완료` 클릭 시 `saveRefined()` 가 `bakeSplatRotation()` 을 호출 — `pendingRotation` (CeilingFloor 모달의 rotX/rotZ) 을 `splatData` 에 in-place 적용 + GPU 텍스처 동기화. 이후:
- `splatData` 메모리 = A'
- `splatEntity` local rotation = Z-180 만
- `pendingRotationRef.current = {0, 0}`, `bakedRotationRef.current = {적용된 회전}` 보관
- 다듬기 단계 동안 작성되었던 `wallPolygon`, `planes` (이미 A' 좌표) 도 그대로 일관

페이지 재로드 시 `bakedRotation` 이 localStorage 에서 복원되어 splatData 마운트 직후 동일 in-place 적용 → A' 상태 복원.

### Baseline Z-180 컨벤션

SOG/Supersplat 호환을 위해 splatEntity local rotation 의 베이스. `world = Z-180 · A'` 즉 `(x, y, z) → (-x, -y, z)`.

### 변환 행렬

- **A' → World**: `splatEntity.getWorldTransform()`. (호출자가 매뉴얼로 Z-180 적용해도 동일 결과.)
- **A' → A'+Y**: `aToAY(point, {wallAngleRad})` ([coordFrames.ts](frontend/src/lib/refine/coordFrames.ts)). 서버 저장 시.
- **Raw → A'+Y**: `rawToAY(point, {rotX, rotZ, wallAngleRad})`. 서버 PLY 저장 시 raw 원본을 베이크하는 용도.

메시 엔티티는 **`app.root` 직접 부착 + Z-180 만 부여**. splatEntity 자식으로 붙이면 splatEntity 의 추가 회전 (있다면) 이중 적용.

### Z-180 으로 인한 시각/코드 라벨 불일치

PLY 의 `+Y` 가 World 의 `-Y` 가 되므로:
- 코드 surfaceId `'ceiling'` (PLY +Y) = 화면상 **방 바닥**
- 코드 surfaceId `'floor'` (PLY -Y) = 화면상 **방 천장**

UI 라벨에서 swap 하지만 **코드에서 surfaceId 직접 다룰 때는 PLY 프레임의 ceiling/floor 인지 시각 기준인지 확인**.

### PlayCanvas 카메라 / lookAt

PlayCanvas 는 right-handed Y-up. 카메라는 **자신의 -Z 방향을 향함**. `entity.lookAt(target, up)`:
```
localZ = -(target - pos),  localY = up,  localX = cross(localY, localZ)
```
`up` 의 부호 하나로 화면이 통째로 뒤집힐 수 있음. 위에서 내려다보는 카메라(top-down)는 `up = (0, 0, -1)` 사용. 카메라 정보는 `cameraEntity.getPosition()`, `.forward`, `.right`, `.up` 모두 World 프레임.

## Core Rules

### Authentication
- Google OAuth → JWT (Access 30min / Refresh 7days).
- Admin: `users.role = 'admin'` → basemap 승인/수정 권한.

### MinIO Object Keys

`buildings/{building_id}/{floor_id}/modules/{module_id}_{module_name}/alignment/`:
- `{uuid}_local.ply` — placeholder 원본 PLY 키 (register-local).
- `refined/{session_id}/`
  - `final.ply` — 정제 PLY (회전 + flatten/brush 마스크 적용).
  - `mesh.json` — wall mesh 메타 (corners, uvs, normalInward, textureFilename).
  - `tex_{surfaceId}.png` — 면별 베이크 텍스처 (ceiling/floor + `w0..w(N-1)`).
- `refined/doors.json` — 도어 corners + 메타 + (basemap 한정) doorMesh/doorSplat 자산 참조.
- `refined/tex_<doorId>.png`, `<doorId>.ply` — basemap 도어별 mesh 텍스처 + 가우시안 PLY.

업로드 정책:
- 모듈 등록 — `POST /uploads/commit-final` multipart 1회 (정합 완료 시 atomic 일괄).
- 베이스맵 등록 — `POST /refine/refined-multipart-init` / `complete` + `/refine/refined-upload-url`.
- COLMAP zip — `complete_upload` 단계에서 `dispatch_colmap_task` → worker.

`aligned.ply` **저장 안 함** — `final.ply` + `module.alignment_transform` 으로 재계산.

### Refine 결과 저장 (SceneOutput)
- `Task` (door_alignment, completed) + `SceneOutput` (ply_path = `final.ply`) 생성.
- mesh.json + PNG 들은 `ply_path` 디렉토리에 같이 — 별도 DB 컬럼 없음.
- 같은 upload 에 여러 번 저장 시: 가장 최근 SceneOutput 이 활성 (created_at desc, limit 1).

### Door Alignment

- basemap 고정. module 의 정합은 **4×4 similarity transform (R + uniform scale + t) 을 `modules.alignment_transform` 에 저장**. 뷰어가 렌더 시 transform 적용.
- **rectFit** (`lib/alignment/rectFit.ts`) — 사용자 픽이 `normalizeDoorRect` 로 완벽한 직사각형이 보장됨. R, s, t 를 직교 basis 비교로 한 번에 산출. SVD Kabsch 안 씀.
  - `dstForcedN`: dst basis n 을 외부 지정 → cornerpick winding 무관 deterministic. basemap door 의 `normalInward` 메타가 ground truth.
  - `withScale`: uniform 스케일 산출 — module 도어 크기를 basemap 도어 크기에 맞춤.
- **gap 의미**: basemap 도어와 module 도어는 **각자 자기 facade 위에 그대로**. 정합 후 두 facade 가 사용자 슬라이더 "정합 문 두께" (`alignDoorThickness`, default 5cm) 만큼 평행 이격. 그 사이 공간을 `createDoorFrameMesh` (`AlignPanel.tsx`) 의 4면 quad mesh 가 채움. frame 은 `doorPivotGroup` 의 자식 — 도어 열기 슬라이더 회전 시 양 도어 + frame 한 묶음.
- **DOOR_CORNER_MIRROR_MAP `[1, 0, 3, 2]`** — 양측이 각자 자기 방 안에서 CW [TL,TR,BR,BL] 픽 가정. 두 방 사이 도어는 양쪽에서 좌우 반전되어 보이므로 mirror.
- **picked.pos / moduleDoorCorners 프레임 = A'** (saveRefined 후 splatData = A' 이고 raycast 결과는 splatData 프레임). AlignPanel 의 `srcWorld = splatEntity.getWorldTransform() · A' = Z-180 · A'`.
- **도어 corner 픽 제약**: 하단 corner (BR=2, BL=3) 는 시각 바닥 (코드 `ceiling` 평면, A' Y = ceilingY) 보다 아래로 안 내려가도록 강제 클램프.
- 자동 검출은 SAM3 (door-ml HTTP). 모듈 흐름은 임시 PLY 동기 forward (`POST /uploads/sam3/detect-temp`).

### 도어 계층 구조 (wrapper 가 transform 단위)

**문 설정 단계** (DoorAlignModal 의 applyDoorRefine 직후 ~ 문 설정 완료):
```
app.root
└── moduleDoor (wrapper, local rotation = Z-180 [+ 도어 회전 시 hinge qR 합성])
    ├── doorMesh_<surfaceId>   (local = identity)
    └── add_splat_<uuid>        (local = identity, '도어 영역 가우시안')
```
도어 회전 (hingeEdge + swing + angleDeg) 은 wrapper 의 setLocalRotation 한 번에 적용 → 두 자식이 함께 따라감.
mesh/splat 에 직접 transform 거는 자리 없음 (gsplat 부모체인 전파 이슈 회피).

**정합 단계** (AlignPanel 의 doAlign 직후):
```
app.root
├── alignmentGroup (정합 transform: R + s + t)
│   ├── splat (모듈 메인)
│   ├── wallMesh_*
│   └── moduleDoor (wrapper 통째로 이동)
│       └── ...
└── doorPivotGroup (도어 열기 슬라이더 회전 보유)
    ├── moduleDoor (wrapper 가 alignmentGroup → doorPivotGroup 으로 다시 reparent)
    ├── basemapDoor_<doorId> (정합 대상 한 개)
    └── doorFrame (4면 quad mesh, frame)
```
정합 후 두 facade 가 `alignDoorThickness` (default 5cm) 만큼 평행 이격. 그 사이 `createDoorFrameMesh` 가 채움.

wrapper.enabled 토글로 자식 mesh+splat 동시 hide/show.

### Basemap
관리자 생성, 불변. 변경 시 전역 변환 행렬로 정합된 모듈에 전파 (구현 예정 — `docs/ROADMAP.md`).

### Notifications
온라인 = WebSocket (Redis `ws:online:{user_id}`). 오프라인 = PostgreSQL `notifications` → 재접속 시 전달.

## Editor Workflow (4-stage)

`UnifiedSplatEditor` 의 `EditorMode = 'refine' | 'door' | 'align' | null`. 사이드바 4탭: 업로드 / 다듬기 / 문 설정 / 정합.

단방향 lock (`lockedStages`) — 이전 단계를 되돌리면 후속 의존성 깨짐 (경계면 변경 시 베이크된 텍스처/mesh/문 corners 모두 무효):
- 다듬기 완료 → `upload` + `refine` 잠금 (회색 opacity-40 + disabled).
- 문 설정 완료 → `door` 추가 잠금.

이탈 보호 (`refine`/`door` 모드): `beforeunload` 경고 + 탭 변경 confirm. 완료 버튼 (force=true) 만 bypass.

서버 영속 타이밍:
- **모듈**: 다듬기·문 설정 메모리. 다듬기 완료 시 회전/삭제를 canonical PLY 메모리에 반영한다. 정합 완료 시 `POST /uploads/commit-final` 로 upload/module row, PLY, mesh, door, alignment 를 atomic 일괄 저장한다. SAM3 자동 검출은 백그라운드 임시 PLY.
- **베이스맵**: 다듬기 단계 localStorage `refine_state_v7_{uploadId}` (pendingRotation + bakedRotation + wallPolygon 등). "Basemap 등록 완료" 시 PLY + mesh + tex + doors + 도어 자산 + `/basemaps/register` 일괄. 정합 단계 없음.

자세한 함수 호출 순서는 `UnifiedSplatEditor.autoFinalizeFromContext` (모듈) / `DoorAlignModal` 의 `inMemoryDoors` commit (베이스맵) 참조.

## Refine Pipeline (씬 정제 순서)

브라우저에서 수행:

1. **사용자 수동 정렬** — Y축 up 회전/반전 + 천장/바닥 (`CeilingFloorModal`) + 벽면 폴리곤 (`WallModal`).
2. **외부 가우시안 제거** (`lib/gs/floaters.ts`) — 경계면 바깥 가우시안 삭제.
3. **Wall mesh + 텍스처 베이크** (`lib/gs/textureBake.ts`, `textureBakeGPU.ts`, `wallMesh.ts`) — 정사영 + alpha 컴포지팅. 메시는 사용자 경계 평면 (sd=0) 에 정확히 배치. GPU 컴퓨트 + 타일 binning, WebGPU 실패 시 CPU 폴백.
4. **경계면 정제** (`lib/gs/clipping.ts`) — 가우시안 scale shrink. **법선 방향 mahalanobis `kSigma · σ` 가 평면 안에 들어오게** 강제. default `kSigma = √12 + 0.001 ≈ 3.4651` — textureBake render hard cutoff (exponent<-6 → √12 ≈ 3.464σ) 보다 살짝 큼. 결과: 렌더 픽셀이 벽 평면을 안 넘음.
5. **다듬기 완료** → `bakeSplatRotation` 으로 `splatData` 메모리에 pendingRotation in-place 적용 (raw → A') 후 삭제 마스크까지 반영한 canonical PLY scene 을 만든다. 이후 문 설정/정합은 이 scene 을 기준으로 동작.
6. **문 설정** (`DoorAlignModal`) — SAM3 또는 수동 4점 → 문 추출 (boundary split + wall mesh α punch + wall 텍스처 crop 으로 도어 mesh) → 회전축/각도/방향.
7. **문 설정 완료** — 문 열린 상태였으면 자동 닫기 + `angleDeg=0` 강제. 모듈은 메모리 유지, 베이스맵은 백그라운드 일괄 업로드. 둘 다 정합 단계로 transition.
8. **정합** (`AlignPanel`) — 4점 자동/수동 → `rectFit(withScale)` → similarity transform. 모듈은 wallAngle bake 보정이 반영된 transform, doorFrame mesh, refined bundle 을 `commit-final` 로 일괄 저장한다. 베이스맵은 해당 단계 없음.

### WallModal 폴리곤 모드
N-각형 폴리곤 입력. 단일 cycle 완성 시 확인 활성. **평행화 모드**: 첫 선택 = 기준선 (시안 "기준" 라벨) → 이후 선택 = 평행화 대상 (주황 번호). 출력 `(angleDeg, polygon: PolygonPoint[])` — angleDeg 는 polygon PCA 주축 기반 베이크용 Y 회전.

## Commands

```bash
docker-compose up -d                                  # Start all services
docker-compose up -d --build frontend backend         # Rebuild
docker-compose logs -f backend                        # View logs
docker-compose exec backend alembic upgrade head      # DB migration
docker-compose exec backend pytest                    # Backend tests
docker-compose exec frontend npm test                 # Frontend tests
```

향후 작업 목록은 [docs/ROADMAP.md](docs/ROADMAP.md) 참고.
