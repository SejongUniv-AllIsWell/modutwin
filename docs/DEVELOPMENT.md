# Development and Deployment Guide

Last updated: 2026-05-27

This guide is for running the `modutwin` repository.

## Requirements

- Docker and Docker Compose
- Node.js 20 if running frontend checks locally
- Python 3.11 if running backend checks locally
- Kakao Developers app keys
- Google OAuth client ID/secret for non-dev login

## Environment

Create `.env` from the example:

```bash
cd ~/modutwin
cp .env.example .env
```

Minimum values to review:

```env
POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_DB=3dgs_platform

PC_HOST_IP=127.0.0.1

REDIS_PASSWORD=...
RABBITMQ_DEFAULT_USER=...
RABBITMQ_DEFAULT_PASS=...

MINIO_ACCESS_KEY=...
MINIO_SECRET_KEY=...
MINIO_BUCKET=3dgs-platform
MINIO_PUBLIC_ENDPOINT=localhost:9000
MINIO_PUBLIC_SECURE=false

JWT_SECRET_KEY=...
PUBLIC_BASE_URL=http://localhost
DEV_MODE=false
ENABLE_SAM3_DISPATCH=false

NEXT_PUBLIC_API_URL=/api
KAKAO_REST_API_KEY=...
NEXT_PUBLIC_KAKAO_MAP_KEY=...

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

For local-only development, `DEV_MODE=true` enables `/api/auth/dev-login`.
Do not use `DEV_MODE=true` in shared or production-like environments.

## Kakao Map Keys

1. Open https://developers.kakao.com.
2. Select the project app.
3. Enable Kakao Map.
4. Add the local domain, for example `http://localhost`, to the JavaScript SDK
   allowed domains.
5. Copy the REST API key and JavaScript key into `.env` (`KAKAO_REST_API_KEY`, `NEXT_PUBLIC_KAKAO_MAP_KEY`).

## Running the Stack

Default production-like stack:

```bash
docker compose up -d --build && docker compose exec backend alembic upgrade head
```

Local HTTP override:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
docker compose exec backend alembic upgrade head
```

The local override mounts `nginx/nginx.local.conf`, which listens on HTTP and
allows local API docs access. Because Compose merges `ports`, the `443` mapping
from the base file may still appear, but the local nginx config serves HTTP.

Compose derives the project name from the checkout directory by default. Keep the
directory name as `modutwin`, or pass `-p modutwin` intentionally when a stable
project name is required.

## Fresh Volumes

If you intentionally reset all local service data:

```bash
cd ~/modutwin
docker compose down -v
docker compose up -d --build
docker compose exec backend alembic upgrade head
docker exec 3dgs-backend python -c "from app.services.minio_service import get_minio_service; get_minio_service().ensure_bucket()"
```

This deletes PostgreSQL, Redis, RabbitMQ, and MinIO data for the active Compose
project. Browser sessions will be invalid and users must log in again.

Expected active volumes:

```text
modutwin_pgdata
modutwin_redisdata
modutwin_rabbitmqdata
modutwin_miniodata
```

## Access URLs

| Service | URL |
| --- | --- |
| Frontend | http://localhost |
| API docs, local override | http://localhost/api/docs |
| MinIO console | http://localhost:9001 |
| RabbitMQ console | http://localhost:15673 |
| Flower, monitoring profile | http://localhost:5555 |

MinIO and RabbitMQ credentials come from `.env`.

## Validation

Backend:

```bash
cd backend
python -m compileall app tests
python -m pytest -q
```

Frontend:

```bash
cd frontend
npm ci
npm run typecheck
npm test
npm run build
```

Compose config:

```bash
docker compose config
docker compose -f docker-compose.yml -f docker-compose.local.yml config
```

## Operational Smoke Checks

```bash
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
docker logs 3dgs-backend --since 2m
docker logs 3dgs-frontend --since 2m
docker logs 3dgs-nginx --since 2m
curl -i http://127.0.0.1/api/buildings?has_output=true
curl -i http://127.0.0.1/api/auth/me
```

For a fresh unauthenticated environment:

- `/api/buildings?has_output=true` should return `200 OK` and `[]`.
- `/api/auth/me` should return `401 Unauthorized`.

## GPU Worker Notes

The PC web stack runs no Celery worker. The DGX Spark is the sole GPU worker and
runs `training` + `alignment` (COLMAP preprocessing, gsplat training, door
alignment, SOG conversion) via `docker-compose.gpu-remote.yml`.

Current status:

- `worker/` contains `training` and `alignment` Celery tasks (built into the DGX
  worker image; the PC base `docker-compose.yml` no longer defines a worker).
- Viewer automatic door designation uses the door-ml/SAM3 HTTP path when the
  service is available.
- `core/door_detection` contains the SAM3-based door detection pipeline used by
  the door-ml side of the feature.
- The older async worker/callback SAM3 path remains optional; keep
  `ENABLE_SAM3_DISPATCH=false` unless that path is intentionally deployed.

The DGX Spark reaches the PC's Redis/RabbitMQ/MinIO over Tailscale via
`PC_HOST_IP`. Keep secrets identical on both machines, and validate connectivity
before starting the worker:

```bash
nc -zv <PC_HOST_IP> 5673
nc -zv <PC_HOST_IP> 6379
nc -zv <PC_HOST_IP> 9000
```

The detailed SAM3 worker/callback contract is in
`docs/sam3_worker_callback_plan.md`.

## Project Layout

```text
/
├── frontend/                  # Next.js app and PlayCanvas viewer
├── backend/                   # FastAPI, Alembic, SQLAlchemy models
├── worker/                    # Celery training/alignment scaffolding
├── core/                      # Python 3DGS helpers used by worker/backend
├── utilities/                 # Shared PLY/file helpers
├── nginx/
│   ├── nginx.conf             # default/prod-like proxy
│   └── nginx.local.conf       # local HTTP proxy
├── docker-compose.yml
├── docker-compose.local.yml
└── docker-compose.gpu.yml     # future/optional; not default-ready
```
