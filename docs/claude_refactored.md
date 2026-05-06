# CLAUDE.md — 3DGS Digital Twin Platform

## Overview

A web platform that creates digital twins of building interiors using 3D Gaussian Splatting.

Flow: 사용자가 외부에서 학습한 `.ply` 업로드 → 브라우저에서 정제·정합 → 서버에 결과 저장 → 웹 뷰어 서빙.

컴퓨트 책임 분배:
- 클라이언트(사용자 하드웨어): PLY 파싱·편집, Shell 정제, 텍스처 베이크 (WebGPU), 문 정합, 렌더링 — SuperSplat Editor 방식
- 서버: 인증, MinIO 객체 스토리지 릴레이(프리사인드 URL), 메타데이터 CRUD, 실시간 알림
- GPU 서버(학습용): 현재 스코프 밖. 사용자가 외부 도구로 학습한 PLY 결과물을 직접 업로드함. 학습 파이프라인 코드는 기능만 남겨두고 미사용.

## Tech Stack

| Role        | Technology                                 |
| ----------- | ------------------------------------------ |
| Frontend    | Next.js (App Router, TypeScript, Tailwind) |
| 3DGS Engine | PlayCanvas Engine + 자체 PLY 파서/라이터 (전 속성 접근) |
| Backend     | FastAPI + SQLAlchemy (async) + Alembic     |
| Database    | PostgreSQL                                 |
| Cache       | Redis                                      |
| Storage     | MinIO (S3-compatible object storage)       |
| Map         | KakaoMap API                               |
| Auth        | Google OAuth 2.0 + JWT                     |
| Proxy       | Nginx                                      |

(docker-compose 에 rabbitmq/flower 서비스가 살아있지만 현재 SOG 변환·GPU 학습 파이프라인은 비활성 — 재활성화 시 참고용으로 컨테이너만 유지.)

## Deployment

```
[PC] docker compose
├── nginx        :80/443
├── frontend     :3000
├── backend      :8000
├── postgres     :5432
├── redis        :6379
├── rabbitmq     :5672
├── minio        :9000
└── flower       :5555
```

## Coordinate Conventions ⚠ 매번 헷갈리는 곳

### 프레임 (3종류)

세 좌표계가 동시에 살아있어 코드를 만질 때 *지금 어느 프레임에 있는지* 항상 의식해야 한다.

1. **Raw PLY 프레임** — `splatData.posX/Y/Z` 의 값. PLY 파일 그대로의 좌표. 추가 변환 안 됨.
2. **A' 프레임 (= raw + pendingRotation)** — 다듬기 단계의 `pendingRotation` (CeilingFloorModal 이 설정하는 rotX/rotZ) 만 적용된 좌표. 텍스처 베이크 입력은 이 프레임에서 계산 (`bakeTextureForPlane` 등). 메시 corners·UVs 도 이 프레임에 저장. WallModal 의 `wallAngle` (Y축 회전) 은 이 시점엔 적용 안 되고 `surfacePlanesFromRoom` 의 평면 정의에만 사용됨 — **문 설정 완료 시점 (`commitRefinedToServer` in useRefineTool)** 에 비로소 PLY 좌표/메시 corners 에 베이크. ※ `saveRefined` 는 단순 transition (mode 변경) 이고 실제 PLY 직렬화/업로드는 `commitRefinedToServer` 에서 수행.
3. **World (렌더) 프레임** — 사용자가 화면에서 보는 좌표. `splatEntity.getWorldTransform()` 적용 결과. 카메라 (`cameraEntity.getPosition()`, `.forward`) 도 이 프레임.

세 프레임 사이 변환 규약:
- `A' → World`: `splatEntity` 에 **Z-180** local euler (`setLocalEulerAngles(0, 0, 180)`) 부여 → `(x, y, z) → (-x, -y, z)`. 이건 SOG/Supersplat 호환을 위해 선택한 컨벤션.
- 메시 엔티티 (`createWallMeshEntity`, `createWallMeshFromPersisted`) 는 corners 가 A' 프레임이라 **메시도 Z-180 만 부여하고 `app.root` 에 직접 부착**. `splatEntity` 의 자식으로 붙이면 `pendingRotation` 이 이중 적용된다.

### Z-180 으로 인한 시각/코드 라벨 불일치

PLY 의 `+Y` 축이 World 의 `-Y` 가 되므로:
- 코드 surfaceId `'ceiling'` (PLY +Y 면) = 화면상 **방 바닥**
- 코드 surfaceId `'floor'` (PLY -Y 면) = 화면상 **방 천장**

UI 라벨에서 swap 하지만 **코드에서 surfaceId 직접 다룰 때는 의도한 게 PLY 프레임의 ceiling/floor 인지 visual 인지 매번 확인**.

### PlayCanvas 카메라 / lookAt

PlayCanvas 는 right-handed Y-up. 카메라는 **자신의 -Z 방향을 향함** (즉 카메라 forward 는 localZ 의 음수 방향). `entity.lookAt(target, up)` 의 결과 basis:

```
localZ = -(target - pos)           # back vector (-forward)
localY = up                        # 입력값
localX = cross(localY, localZ)     # right
```

→ `up` 의 부호 하나로 화면 좌우/상하가 통째로 뒤집힐 수 있음. 특히 **위에서 아래로 내려다보는 카메라** (top-down floorplan 등) 의 경우:

`up = (0, 0, -1)` 로 설정하면:
- `localZ = (0, 1, 0)`, `localY = (0, 0, -1)` → `localX = cross((0,0,-1),(0,1,0)) = (1, 0, 0)` → camera right = **+X world** (정상)
- screen up (framebuffer +Y) = `localY` = -Z world → framebuffer top = world minZ
- WebGL framebuffer 를 `gl.readPixels` 로 읽고 Y-flip 해서 Canvas 로 옮기면: canvas (0, 0) = world (minX, _, minZ). 미니맵의 `(pos.x - minX) * ppm`, `(pos.z - minZ) * ppm` 매핑과 정확히 일치.

`up = (0, 0, +1)` 로 잘못 잡으면 `localX = (-1, 0, 0)` 이 되어 **X 미러** + Y-flip 후 **Z 미러** = 사실상 **180° 회전**된 이미지가 나온다. (실제로 미니맵 구현하면서 한 번 박은 함정. `frontend/src/lib/gs/floorplan.ts` 주석 참고.)

### 카메라 방향 정보

- `cameraEntity.getPosition()` → World 프레임의 카메라 위치 (`pc.Vec3`)
- `cameraEntity.forward` → World 프레임에서 카메라가 향하는 단위 벡터 (= -localZ). 미니맵 화살표는 `(forward.x, forward.z)`.
- `cameraEntity.right`, `cameraEntity.up` → 카메라 local basis 의 world 표현.
- 카메라의 forward 가 **world** 인지 헷갈리지 말 것 (PC entity 의 forward 는 world space 단위 벡터).

## Core Rules

### Authentication

- Google OAuth → JWT (Access 30min / Refresh 7days)
- Admin: `users.role = 'admin'` → basemap 승인/수정 권한

### MinIO Object Keys

- `users/{user_id}/{building_name}/web_input/` — 원본 PLY 업로드 (private)
- `users/{user_id}/{building_name}/refined/{session_id}/` — 한 번의 정제 결과를 묶는 디렉토리 (PLY + mesh.json + tex_*.png 들이 같이 들어감)
  - `final.ply` — 정제된 가우시안 PLY (회전 적용: pendingRotation rotX/rotZ + wallAngle Y, flatten 마스크 적용, 브러시 삭제 적용)
  - `mesh.json` — wall mesh 메타데이터 (각 면 corners[4][3], uvs[4][2], normalInward, textureFilename)
  - `tex_{surfaceId}.png` — 면별 베이크 텍스처 (ceiling/floor/w1a/w1b/w2a/w2b)
- `users/{user_id}/{building_name}/refined/{timestamp}_aligned.ply` — 정합 단계 (DoorAlignModal `applyAndSave`) 결과. session_id 없이 업로드되는 legacy timestamp 경로. 새 SceneOutput 은 만들지 않고 즉시 뷰어가 그 URL 로 reload (one-shot).
- Upload: Multipart + presigned PUT URL (클라이언트가 MinIO로 직접 업로드)
- Download: presigned GET URL

### Refine 결과 저장 (SceneOutput)

- 다듬기 결과 저장 시 `Task` (door_alignment, completed) + `SceneOutput` (ply_path = final.ply 키) 생성.
- mesh.json 과 PNG 들은 ply_path 의 디렉토리(`{base}/refined/{session_id}/`) 에 함께 위치 — 별도 DB 컬럼 없음.
- 같은 upload 에 여러 번 저장 시: 가장 최근 SceneOutput 이 활성 (created_at desc, limit 1).

### Door Alignment

- basemap은 고정. module 의 가우시안 좌표에 4×4 rigid transform 을 클라이언트에서 적용한 결과 PLY 를 통째로 MinIO 에 업로드 (`aligned.ply`). 행렬만 따로 저장하는 엔드포인트는 없음.
- 4점 수동 클릭 → Kabsch(3×3 SVD)로 rigid transform 추정 (`DoorAlignModal` + `lib/alignment/kabsch.ts`). 추후 segmentation 자동 입력 연동 예정.
- 같은 모달의 "문 경계 정제하기" 토글: 사용자가 찍은 4점 직사각형의 4 edge plane 에 걸친 가우시안을 boundary 위치 기준으로 두 개로 분할 (`lib/gs/doorTrim.ts` 의 `decomposeBoundaryGaussians`) → 메인 PLY GPU 의 boundary slot 은 wall-side sub 로 in-place 갱신, door-side sub 들은 별도 GaussianScene → blob URL → `useAdditionalGsplats` 로 추가 splat group. wall mesh 의 도어 영역 텍셀은 alpha=0 punch, 도어 영역만 별도 베이크해서 도어 mesh 엔티티 생성. 슬라이더 (베이크 시작 / 안전 margin) 변경 시 600ms 디바운스 후 자동 재적용.
- `lib/alignment/`에는 Kabsch 외에 RANSAC rigid(`ransacRigid`), 평면 RANSAC fit(`ransacPlaneFit`), OBB 4꼭짓점 추출(`fitOrientedRectangle`) 등 보조 유틸이 함께 들어있음 (일부는 Python에서 포팅).

### Basemap

- 초기에는 관리자가 생성, 기본적으로 불변
- 변경 시: 전역 변환 행렬 계산 → 기존 정합된 모든 모듈에 전파 적용

### Notifications

- 사용자 온라인: WebSocket 푸시 (Redis `ws:online:{user_id}`)
- 사용자 오프라인: PostgreSQL `notifications` 저장 → 재접속 시 전달

## Editor Workflow (4-stage)

`UnifiedSplatEditor` 의 `EditorMode = 'refine' | 'door' | 'align' | null`. 사이드바 4탭: 업로드 / 다듬기 / 문 설정 / 정합.

진행은 **단방향 lock** (`UnifiedSplatEditor` 의 `lockedStages`):
- 다듬기 완료 → `upload` + `refine` 잠금 (사이드바 탭 클릭 차단 + 취소선/회색).
- 문 설정 완료 → `door` 추가 잠금. 정합 단계로 진입.
- 잠긴 이유: 이전 단계를 되돌리면 후속 단계 의존성이 깨짐 (예: 경계면 변경 시 베이크된 텍스처/mesh/문 corners 가 모두 무효).

이탈 보호 (`refine`/`door` 모드 활성 중):
- 브라우저 새로고침/닫기 → `beforeunload` 경고.
- 사이드바 탭 변경 → `window.confirm("저장되지 않은 변경사항이 있습니다...")`. 완료 버튼 (force=true) 만 bypass.

**모든 서버 영속은 문 설정 완료 시점에 일괄 처리** — 다듬기 단계는 메모리/localStorage 만, 다듬기 완료는 단순 mode transition.

## Refine Pipeline (씬 정제 순서)

사용자가 업로드한 PLY를 정렬/정제하는 파이프라인. **전부 브라우저에서 수행.**

1. 사용자 수동 정렬 — Y축 up 회전/반전 + 천장/바닥(CeilingFloorModal, 히스토그램 자동 후보) + X/Z 벽면 정렬(WallModal). 추후 문 segmentation 으로 자동화 예정.
2. 외부 가우시안 제거 (`lib/gs/floaters.ts`) — 각 경계면 바깥 `margin_out` (안전거리, 슬라이더로 조정) 초과 가우시안 삭제. `near_protect` 이내 표면 본체는 항상 보호. ※ 이전엔 `lib/gs/shell.ts` 에 있었으나 floaters/clipping 으로 분리됨.
3. Wall mesh + 텍스처 베이크 (`lib/gs/textureBake.ts`, `textureBakeGPU.ts`, `wallMesh.ts`) — 각 경계면을 정사영 + alpha 컴포지팅으로 텍스처에 굽고, paint 위치에 텍스처 입힌 quad 메시로 표시. **얇은 막(가우시안 패치) 방식은 폐기됨**.
4. 경계면 정제 (`lib/gs/clipping.ts`) — 방 경계면 바깥으로 뻗어나가는 가우시안 scale 을 shrink (f = |sd| / 3σ). 시점 회전 시 가우시안 결 회전 artifact 완화.
5. **다듬기 완료** → 문 설정 단계로 transition (서버 통신 없음).
6. 문 설정 (`DoorAlignModal` setup view) — SAM3 프롬프트 팝업 (자동 문 지정 / 문 수동 지정 분기) → 4 점 수동 클릭 → 문 추출 (boundary split + wall mesh α punch + 도어 mesh 별도) → 회전축/각도/방향.
7. **문 설정 완료** → register-local (로컬 파일이면 모듈 정보 모달) → refined PLY + mesh.json + tex_*.png + doors.json 일괄 업로드 → 정합 단계 진입.
8. 정합 (`DoorAlignModal` align view) — 4점 수동 클릭 → Kabsch → 행렬을 PLY 좌표에 적용 → `aligned.ply` 업로드 후 뷰어 reload.

### Wall mesh 베이크 세부

- 각 면의 sd 히스토그램 (1cm 빈, opacity 가중) 으로 paint plane 자동 검출 (paintSd). 진단/로깅용으로 활용.
- **메시 위치 = `MESH_PLANE_INSET = 0` (`textureBake.ts`).** 사용자가 모달(CeilingFloorModal/WallModal) 에서 정의한 경계면(sd=0) 에 정확히 막 배치. 6면 동일 오프셋이라 직육면체 코너에서 인접 면과 정확히 만남. 경계 코너 extend (`planeBakeInputForSurface`) 도 같은 0 기반.
- **베이크 시작(depthGate)** 도 사용자 경계면 기준. `bakeInnerGate` 슬라이더 default 0 = 베이크가 사용자 경계면(sd=0) 에서 시작. 막 위치와 일치 → 막 ↔ 원본 splat 사이 깊이 차로 인한 "층 두 개" 잔상 제거.
- **autoGate 자동 확장** (`bakeTextureForPlane` 의 `opts.autoMargin`):
  - `autoMargin > 0`: paintSd 기반으로 안쪽까지 자동 확장 (기존 동작). DoorAlignModal 의 도어 베이크는 default 0.05 유지.
  - `autoMargin = 0`: paintSd 무관하게 `depthGate` 그대로 사용 (strict). useRefineTool 의 `bakeWallMeshTest` 가 명시적으로 0 전달 → 사용자 경계면이 그대로 베이크 시작점.
- 사용자 경계면이 실제 가우시안 paint slab 과 어긋나 있으면 텍스처 컨텐츠가 비거나 부분적이 될 수 있음 → 사용자가 모달에서 경계면을 정확히 잡는 게 중요. 슬라이더로 안쪽까지 확장 가능.
- GPU 컴퓨트 셰이더 (16×16 workgroup_size) + **타일 기반 binning** (`textureBakeGPU.ts`): 16×16 텍셀 타일마다 영향받을 splat 인덱스 리스트 사전 계산 → 픽셀당 ~10 splat 만 순회. 큰 면 (281k splats × 14M pixels) 도 수 초 내. WebGPU 실패 시 CPU 폴백 존재.
- 좌표 규약: bake 입력은 raw PLY 프레임 (Z-180 적용 전). 메시 엔티티는 app.root 에 직접 부착하고 Z-180 만 부여 (splatEntity child 로 붙이면 pendingRotation 이중 적용).
- **PLY 프레임 좌표계 주의**: 코드의 `'ceiling'` surfaceId 가 시각적으로는 **방 바닥**, `'floor'` 가 **방 천장** 에 대응 (Z-180 회전 때문). UI 라벨에서 swap 처리됨 — 코드 surfaceId 직접 다룰 때 헷갈리지 않게 주의.

### 영속화 + 정합 연결 흐름

- 다듬기 단계는 메모리 + localStorage (`refine_state_v4_{uploadId}`) 만 사용 — 평면/벽면 각도/선택된 면 등이 다음 단계에서 평면 6개 복원에 쓰임. 서버 통신 없음.
- **문 설정 완료** 버튼 (DoorAlignModal) 이 모든 서버 영속을 일괄 트리거:
  1. `ensureUploadId` — 로컬 파일이면 모듈 정보 모달 → `register-local` API → 새 `upload_id` 반환. 서버 진입이면 기존 `upload_id` 그대로 재사용.
  2. `commitRefinedToServer` — refined PLY + mesh.json + tex_*.png 6장 일괄 업로드 (`/refine/refined-upload-url` + PUT) → `/refine/save` 로 `Task` + `SceneOutput` 생성.
  3. `persistDoorsToServer` — doors.json 업로드 (corners + 회전 메타 + boundary split 파라미터).
  4. `lockedStages` 에 `'door'` 추가 + `setMode('align', { force: true })`.
- 같은 모달의 재방문 (정합 → 사이드바 클릭은 lock 으로 막힘이지만 다른 경로로 복귀 시) 마다 `문 설정 완료` 누르면 1~3 재실행 (덮어쓰기) 가능.
- `/viewer?upload_id=X` 베이스 뷰어 — `useRefinedMeshLoader` 가 가장 최근 SceneOutput 의 PLY + mesh + tex 자동 로드.
- `/viewer?upload_id=X&mode=align` — 대시보드의 "정합" 진입 경로. `initialMode = 'align'`.
- 라우팅 변경 없음: 문 설정 완료 → 정합은 같은 페이지에서 `setMode('align')` 만 (URL 변경 X).
- DoorAlignModal 마운트 시 서버 corners 가 있으면 1회 자동 문 추출 (`autoExtractedRef`) — 재진입 시 회전 즉시 가능.

## TODO (미완)

1. **가우시안 경계 clipping** — `lib/gs/clipping.ts` 1차 구현 완료 (단순 shrink: scale 을 `f = |sd| / 3σ_extent` 로 곱, 6평면 중 가장 제약 큰 f 적용).
   - **남은 작업**: 효과 검증 + 사용자 슬라이더 노출 정리. 시점 회전 시 결 artifact 가 충분히 완화되는지 실측.
2. **문 경계 SAGS-style decomposition** — https://github.com/XuHu0529/SAGS 참고.
   - 분할 구현 완료: `lib/gs/doorTrim.ts` 의 `decomposeBoundaryGaussians` + `lib/gs/doorDecompose.ts` (SAGS 방식 별도) — boundary 위치 기준 비대칭 분할 (door-side / wall-side sub).
   - **남은 작업**: 도어 회전 애니메이션 (`useDoorAnimation`) 과 wire-up. 도어 그룹 = (도어 영역 안 원본 + door-side sub 들 in additional splat) 가 함께 변환되도록 연결. 회전 시 sub-gaussian 들이 자기 영역 안에서만 움직여 boundary tail artifact 제거.
3. **창문 segmentation + 투명 텍스처** — 텍스처 베이크 시:
   - 창문 영역 자동 segmentation (SAM3 등 활용 검토).
   - 해당 영역 텍스처 알파를 0 으로 → 창문 너머 보이게 (또는 별도 처리).
4. **SAM3 자동 문 지정 wire-up** — `Sam3PromptModal` UI 만 존재. 자동 문 지정 클릭 시 백엔드 SAM3 호출 + 4코너 자동 채움까지 연결 미구현.

## Commands

```bash
docker-compose up -d                          # Start all services
docker-compose up -d --build frontend backend # Rebuild
docker-compose logs -f backend                # View logs
docker-compose exec backend alembic upgrade head  # DB migration
docker-compose exec backend pytest            # Backend tests
docker-compose exec frontend npm test         # Frontend tests
```
