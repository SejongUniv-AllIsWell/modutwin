# CLAUDE.md — 3DGS Digital Twin Platform

## Overview

A web platform that creates digital twins of building interiors using 3D Gaussian Splatting.
Video upload → GPU server 3DGS training → door-based alignment → web viewer serving.

## Web page

https://splat.wiki/

## Tech Stack

| Role        | Technology                                 |
| ----------- | ------------------------------------------ |
| Frontend    | Next.js (App Router, TypeScript, Tailwind) |
| Backend     | FastAPI + SQLAlchemy (async) + Alembic     |
| Database    | PostgreSQL                                 |
| Cache       | Redis                                      |
| Storage     | MinIO (S3-compatible object storage)       |
| Queue       | RabbitMQ (Celery broker)                   |
| GPU Worker  | Celery (separate physical machine)         |
| 3DGS Viewer | PlayCanvas Engine (SOG format)             |
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

[GPU Server] separate machine
└── celery worker  ← connects to PC's RabbitMQ/Redis/MinIO over network
```

## Directory Structure

```
/
├── frontend/           # Next.js
│   ├── src/app/        # Page routing
│   ├── src/components/
│   │   ├── viewer/
│   │   │   ├── SplatViewerCore.tsx   # PlayCanvas 엔진 래퍼 (GPU 텍스처 접근)
│   │   │   ├── SplatViewer.tsx       # 편집 모드 UI (선택/변환/문 애니메이션)
│   │   │   ├── RefineViewer.tsx      # 정제(refine) 전용 뷰어
│   │   │   └── tools/               # 도구 hooks
│   │   │       ├── useGaussianSelector.tsx  # 브러쉬/BBox 가우시안 선택
│   │   │       ├── useTransformTool.ts      # 이동/회전 기즈모
│   │   │       ├── useRefineTool.tsx         # 평면 기반 벽면 정제
│   │   │       ├── useDoorAnimation.ts      # 문 열림 애니메이션
│   │   │       ├── usePivotEditor.ts        # 힌지 축 편집
│   │   │       ├── gpuSync.ts               # GPU 텍스처 동기화
│   │   │       └── quatUtils.ts             # 쿼터니언 연산
│   │   ├── map/, upload/, dashboard/
│   ├── src/lib/        # API client, WebSocket, Auth
│   └── src/types/
├── backend/            # FastAPI
│   ├── app/main.py
│   ├── app/core/       # config, security, database
│   ├── app/api/        # auth, uploads, tasks, scenes, basemaps, ws, refine
│   ├── app/models/     # SQLAlchemy ORM
│   ├── app/schemas/    # Pydantic
│   ├── app/services/   # minio_service, celery_service, notification_service
│   ├── app/middleware/  # access_log
│   └── alembic/
├── core/               # Python 핵심 알고리즘
│   ├── refine_module/  # 벽면 정제 (clip, flat_opaque)
│   ├── select_gaussians/ # 가우시안 선택 (SAM3 auto, manual)
│   ├── door_alignment/ # 문 기반 정합 (RANSAC+SVD)
│   └── grouping/       # 시맨틱 그룹핑 (학습 시 per-Gaussian identity)
├── worker/             # Celery (deployed on GPU server)
│   ├── tasks/          # training.py, alignment.py
│   ├── pipeline/       # base.py, runner.py, sog_converter.py (ffmpeg/colmap/gsplat은 별도 설치)
│   └── celery_app.py
├── utilities/          # 공용 유틸리티 (ply_io)
├── nginx/nginx.conf
├── docker-compose.yml
└── .env
```

## Core Rules

### Pipeline Modules

- All modules MUST inherit `PipelineModule(ABC)` with `run(input_path) → output_path` interface
- Inter-module communication via file paths (directories) ONLY. No direct imports between modules
- Replacing any module MUST NOT affect adjacent modules
- Pipeline: FFmpeg → BlurDetection → COLMAP → gsplat → SOG conversion

### PlayCanvas Viewer

- `SplatViewerCore.tsx`: PlayCanvas 2.x 엔진 래퍼 (GPU 텍스처 접근, 카메라 제어)
- `SplatViewer.tsx`: 편집 모드 UI (가우시안 선택/변환/문 애니메이션/피벗 편집)
- `RefineViewer.tsx`: 정제(refine) 전용 뷰어 (평면 기반 벽면 정제)
- Viewer page modes: `?mode=refine` → RefineViewer, `?mode=align` or default → SplatViewer

### Authentication

- Google OAuth → JWT (Access 30min / Refresh 7days)
- Admin: `users.role = 'admin'` → basemap approval/modification privileges

### MinIO Object Keys

- `users/{user_id}/{building_name}/web_input/` — raw uploads (private)
- `users/{user_id}/{building_name}/3dgs_output/` — training results (private)
- `users/{user_id}/{building_name}/3dgs_output/refined/` — 정제된 PLY (private)
- `buildings/{building_id}/{floor_id}/modules/{module_id}_{name}/alignment/` — 정합 결과
- `buildings/{building_id}/{floor_id}/modules/{module_id}_{name}/web_output/` — 웹 뷰어용 SOG
- Upload: Multipart + presigned PUT URL (client uploads directly to MinIO)
- Download: presigned GET URL

### Basemap

- Initially created by admin, fundamentally immutable
- On change: compute transform matrix → apply to all existing aligned modules

### Notifications

- User online: WebSocket push (Redis `ws:online:{user_id}`)
- User offline: save to PostgreSQL `notifications` → deliver on next login

### Networking

- Inter-container communication: use docker service names (`postgres`, `redis`, etc.)
- GPU server: connects to PC via `PC_HOST_IP` environment variable
- External exposure: Nginx 80/443 only. RabbitMQ/Redis/MinIO allow GPU server IP only

## DB Tables

users, access_logs, sessions, uploads, tasks, scene_outputs, basemaps, notifications

## Environment Variables

```env
# docker compose (.env)
POSTGRES_USER=3dgs
POSTGRES_PASSWORD=changeme
POSTGRES_DB=3dgs_platform
DATABASE_URL=postgresql+asyncpg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
REDIS_URL=redis://redis:6379/0
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672//
MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=changeme
MINIO_BUCKET=3dgs-platform
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
JWT_SECRET_KEY=...
JWT_ALGORITHM=HS256
NEXT_PUBLIC_API_URL=/api
NEXT_PUBLIC_KAKAO_MAP_KEY=...

# GPU Worker (.env — uses PC's external IP)
# RABBITMQ_URL=amqp://guest:guest@<PC_IP>:5672//
# REDIS_URL=redis://<PC_IP>:6379/0
# MINIO_ENDPOINT=<PC_IP>:9000
```

## Pages

| Path                      | Description                                         | Auth     |
| ------------------------- | --------------------------------------------------- | -------- |
| `/`                       | Landing page                                        | None     |
| `/login`                  | Google login                                        | None     |
| `/dashboard`              | Upload/task list                                    | Required |
| `/upload`                 | Video upload                                        | Required |
| `/door-select/{scene_id}` | Door selection (edit mode)                          | Required |
| `/viewer`                 | KakaoMap + viewer (readonly, `?mode=refine\|align`) | None     |
| `/admin/basemaps`         | Basemap management                                  | Admin    |

## Commands

```bash
docker-compose up -d                          # Start all services
docker-compose up -d --build frontend backend # Rebuild
docker-compose logs -f backend                # View logs
docker-compose exec backend alembic upgrade head  # DB migration
docker-compose exec backend pytest            # Backend tests
docker-compose exec frontend npm test         # Frontend tests

# GPU server
celery -A celery_app worker -Q training,alignment -c 1
```
