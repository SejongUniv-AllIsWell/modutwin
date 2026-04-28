# CLAUDE.md — 3DGS Digital Twin Platform

## Overview

A web platform that creates digital twins of building interiors using 3D Gaussian Splatting.

Flow: 사용자가 외부에서 학습한 `.ply` 업로드 → 브라우저에서 정제·정합 → 서버에 결과 저장 → 웹 뷰어 서빙.

컴퓨트 책임 분배:
- 클라이언트(사용자 하드웨어): PLY 파싱·편집, Shell 정제, 문 정합(4꼭짓점 Kabsch 또는 SVD/RANSAC), 렌더링 — SuperSplat Editor 방식
- 서버: 인증, MinIO 객체 스토리지 릴레이(프리사인드 URL), 메타데이터 CRUD, 실시간 알림, SOG 변환
- GPU 서버(학습용): 현재 스코프 밖. 사용자가 외부 도구로 학습한 PLY 결과물을 직접 업로드함. 학습 파이프라인 코드는 기능만 남겨두고 미사용.

## Web page

https://splat.wiki/

## Tech Stack

| Role        | Technology                                 |
| ----------- | ------------------------------------------ |
| Frontend    | Next.js (App Router, TypeScript, Tailwind) |
| 3DGS Engine | PlayCanvas Engine + 자체 PLY 파서/라이터 (전 속성 접근) |
| Backend     | FastAPI + SQLAlchemy (async) + Alembic     |
| Database    | PostgreSQL                                 |
| Cache       | Redis                                      |
| Storage     | MinIO (S3-compatible object storage)       |
| Queue       | RabbitMQ (Celery broker) — SOG 변환 전용       |
| GPU Worker  | Celery (스코프 밖, 비활성)                        |
| Map         | KakaoMap API                               |
| Auth        | Google OAuth 2.0 + JWT                     |
| Proxy       | Nginx                                      |

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

[GPU Server] 스코프 밖
└── (비활성) 학습 파이프라인은 사용자가 외부 도구로 대체
```

## Core Rules

### Compute Boundary

- 서버에서 하지 않는 것: 가우시안 편집, 평면 clip, 벽면 정제, 문 정합 연산, 변환 행렬 계산
- 서버에서 하는 것: 파일 저장/전달, DB I/O, 인증, 알림 릴레이, SOG 변환(CPU-bound)
- 원칙: SuperSplat Editor처럼 사용자 하드웨어가 무거운 연산을 맡는다. 서버는 가볍게.

### Authentication

- Google OAuth → JWT (Access 30min / Refresh 7days)
- Admin: `users.role = 'admin'` → basemap 승인/수정 권한

### MinIO Object Keys

- `users/{user_id}/{building_name}/web_input/` — 원본 PLY 업로드 (private)
- `users/{user_id}/{building_name}/refined/` — 클라이언트에서 Shell 정제한 결과 PLY (private)
- `buildings/{building_id}/{floor_id}/modules/{module_id}_{name}/alignment/` — 정합 결과(행렬 + 메타)
- `buildings/{building_id}/{floor_id}/modules/{module_id}_{name}/web_output/` — 웹 뷰어용 SOG
- Upload: Multipart + presigned PUT URL (클라이언트가 MinIO로 직접 업로드)
- Download: presigned GET URL

### Door Alignment

- basemap은 고정. module의 가우시안에 4×4 변환 행렬만 적용해 접합
- 행렬은 클라이언트에서 계산해 서버에는 값만 저장(~64 bytes)
- 현재 사용: 4점 수동 클릭 → Kabsch(3×3 SVD)로 rigid transform 추정 (`DoorAlignModal` + `lib/alignment/kabsch.ts`). 추후 segmentation 자동 입력 연동 예정
- `lib/alignment/`에는 Kabsch 외에 RANSAC rigid(`ransacRigid`), 평면 RANSAC fit(`ransacPlaneFit`), OBB 4꼭짓점 추출(`fitOrientedRectangle`) 등 보조 유틸이 함께 들어있음 (일부는 Python에서 포팅)

### Basemap

- 초기에는 관리자가 생성, 기본적으로 불변
- 변경 시: 전역 변환 행렬 계산 → 기존 정합된 모든 모듈에 전파 적용

### Notifications

- 사용자 온라인: WebSocket 푸시 (Redis `ws:online:{user_id}`)
- 사용자 오프라인: PostgreSQL `notifications` 저장 → 재접속 시 전달

### Networking

- 컨테이너 간 통신: docker service name 사용 (`postgres`, `redis`, ...)
- 외부 노출: Nginx 80/443만. RabbitMQ/Redis/MinIO는 GPU 서버 IP만 허용 (GPU 비활성 중이지만 방화벽 설정은 유지)

## Refine Pipeline (씬 정제 순서)

사용자가 업로드한 PLY를 정렬/정제하는 파이프라인. **전부 브라우저에서 수행.**

1. 세로방향 벡터 추출 — 추후 문 segmentation 연동 예정. 현재는 사용자가 수동으로 방향 지정
2. Y축 정렬 회전 — 세로방향이 Y축과 나란하도록 전체 씬 회전
3. Y축 반전 — 스캔 방향에 따라 뒤집힐 수 있으므로 반전 옵션 제공
4. 히스토그램 기반 천장/바닥 추정 — Y축 히스토그램으로 자동 감지, CeilingFloorModal에서 사용자 확인 (현재 작업 중)
5. X/Z축 방 방향 정렬 — 벽면이 X/Z축과 나란하도록 회전 (WallModal)
6. Shell 단계 (`lib/gs/shell.ts`) — 각 경계면 바깥 `margin_out` 초과 가우시안 삭제. `near_protect` 이내 표면 본체는 항상 보호. 색 샘플링·패치 생성은 이 단계에 포함되지 않음
7. Membrane 단계 (`lib/gs/membrane.ts`, `membraneGPU.ts`) — 각 경계면을 격자 패치로 새로 덮음
   - 패치 위치마다 주변 원본 가우시안의 KNN(k=8)을 찾아 `f_dc_*` median을 색으로 사용 (WebGPU 컴퓨트 + CPU 폴백)
   - 격자 위에서 [1,2,1]/4 separable Gaussian blur로 색 스무딩 (KNN median이 패치마다 독립적이라 인접 색이 튀는 걸 완화)
   - 패치 모양: scale_xy = `patchRadius`, scale_z = `patchThickness` 인 납작한 가우시안. SH=0 단색, opacity는 옵션 (디폴트 0.25)
8. 문 정합 — 4점 수동 클릭 → Kabsch → 4×4 행렬 서버 저장

구 파이프라인(서버 측 벽면 수직투영)은 폐기됨. 기존 `core/refine_module/flat_opaque.py` 접근은 실패로 판명.

## Frontend Client Modules

- `frontend/src/lib/ply/` — PLY 전 속성 파서/라이터
- `frontend/src/lib/gs/planes.ts` — 방 6면 평면 정의 / signed distance
- `frontend/src/lib/gs/transform.ts` — 씬 회전·반전 등 강체 변환
- `frontend/src/lib/gs/shell.ts` — 외부 가우시안 삭제 (`margin_out` 초과)
- `frontend/src/lib/gs/membrane.ts`, `membraneGPU.ts` — 격자 패치 생성 + KNN median 채색 + 2D Gaussian blur 스무딩 (WebGPU 컴퓨트 + CPU 폴백)
- `frontend/src/lib/alignment/` — Kabsch, RANSAC rigid, 평면 RANSAC fit, OBB 4꼭짓점, mat3/SVD 유틸
- `frontend/src/lib/refine/persistence.ts` — 정제 상태 저장/복원
- `frontend/src/components/viewer/tools/` — 각 도구 UI 컴포넌트 (CeilingFloorModal, WallModal, DoorAlignModal, …)

## Commands

```bash
docker-compose up -d                          # Start all services
docker-compose up -d --build frontend backend # Rebuild
docker-compose logs -f backend                # View logs
docker-compose exec backend alembic upgrade head  # DB migration
docker-compose exec backend pytest            # Backend tests
docker-compose exec frontend npm test         # Frontend tests

# GPU server (비활성, 참고용)
# celery -A celery_app worker -Q training,alignment -c 1
```
