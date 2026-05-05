# Development and Deployment Guide

Last updated: 2026-05-05

This guide is for running the refactored codebase from
`/home/pjhserver/refactored_modutwin`. The old `modutwin` compose project and
old volumes are no longer the expected runtime baseline.

## Requirements

- Docker and Docker Compose
- Node.js 20 if running frontend checks locally
- Python 3.11 if running backend checks locally
- Kakao Developers app keys
- Google OAuth client ID/secret for non-dev login

## Environment

Create `.env` from the example:

```bash
cd ~/refactored_modutwin
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
NEXT_PUBLIC_KAKAO_REST_API_KEY=...
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
5. Copy the REST API key and JavaScript key into `.env`.

## Running the Stack

Default production-like stack:

```bash
cd ~/refactored_modutwin
docker compose up -d --build
docker compose exec backend alembic upgrade head
```

Local HTTP override:

```bash
cd ~/refactored_modutwin
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
docker compose exec backend alembic upgrade head
```

The local override mounts `nginx/nginx.local.conf`, which listens on HTTP and
allows local API docs access. Because Compose merges `ports`, the `443` mapping
from the base file may still appear, but the local nginx config serves HTTP.

Do not add `-p modutwin` unless you intentionally want to reuse the old compose
project name. The expected project name for this folder is `refactored_modutwin`.

## Fresh Volumes

If you intentionally reset all local service data:

```bash
cd ~/refactored_modutwin
docker compose down -v
docker compose up -d --build
docker compose exec backend alembic upgrade head
docker exec 3dgs-backend python -c "from app.services.minio_service import get_minio_service; get_minio_service().ensure_bucket()"
```

This deletes PostgreSQL, Redis, RabbitMQ, and MinIO data for the
`refactored_modutwin` project. Browser sessions will be invalid and users must
log in again.

Expected active volumes:

```text
refactored_modutwin_pgdata
refactored_modutwin_redisdata
refactored_modutwin_rabbitmqdata
refactored_modutwin_miniodata
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

The default web stack does not require the GPU worker.

Current status:

- `worker/` contains `training` and `alignment` Celery tasks.
- SAM3 dispatch is disabled by default with `ENABLE_SAM3_DISPATCH=false`.
- `worker/tasks/sam3.py` does not exist yet.
- `door_ml/` does not exist in the current repository, so
  `docker-compose.gpu.yml` is not considered a ready default deployment file.

If a separate GPU machine is prepared later, expose Redis/RabbitMQ/MinIO through
`PC_HOST_IP` on a private interface such as Tailscale, keep secrets identical on
both machines, and validate connectivity before starting workers:

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
