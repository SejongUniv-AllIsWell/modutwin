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

## Core Rules

### Pipeline Modules

- All modules MUST inherit `PipelineModule(ABC)` with `run(input_path) → output_path` interface
- Inter-module communication via file paths (directories) ONLY. No direct imports between modules
- Replacing any module MUST NOT affect adjacent modules
- Pipeline: FFmpeg → BlurDetection → COLMAP → gsplat → SOG conversion

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

## Refine Pipeline (벽면 정제 순서)

스캔된 3DGS 씬을 정렬하는 파이프라인. 현재 4단계까지 작업 중.

1. **문 segmentation 기반 세로방향 벡터 추출** — 다른 팀원이 문 segmentation 결과 제공 예정. 이를 기반으로 세로(수직) 방향 벡터를 구함
2. **세로방향 → Y축 정렬 회전** — 추출된 세로방향이 Y축과 나란하게 전체 씬을 회전
3. **Y축 반전 기능** — 스캔 방향에 따라 씬이 뒤집혀 있을 수 있으므로 Y축 반전 기능 제공
4. **히스토그램 기반 천장/바닥 추정** — Y축 히스토그램으로 천장/바닥 자동 감지. CeilingFloorModal 팝업으로 사용자 확인/조정. 3D 뷰어에서 반투명 평면으로 미리보기 **(현재 작업 중)**
5. **X/Z축에 방 방향 맞추기** — 천장/바닥 정렬 완료 후, 방의 벽면 방향을 X/Z축에 나란하게 정렬 **(방법 미정)**

정렬 완료 후 각 벽면에 대해 `core/refine_module/`의 clip → flat_opaque 파이프라인으로 벽면 수직투영 처리.

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
