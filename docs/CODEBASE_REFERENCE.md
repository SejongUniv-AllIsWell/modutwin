# 3DGS Digital Twin Platform - Codebase Reference

Last updated: 2026-05-05
Canonical scope: `refactored_modutwin/`

This document is the short architecture reference for the current refactored
codebase. It replaces older review notes and duplicate references that
described the pre-refactor state.

## Current Runtime Identity

- Compose project: `refactored_modutwin`
- Working directory: `/home/pjhserver/refactored_modutwin`
- Fixed container names remain `3dgs-*` because `container_name` is set in
  `docker-compose.yml`.
- Active named volumes:
  - `refactored_modutwin_pgdata`
  - `refactored_modutwin_redisdata`
  - `refactored_modutwin_rabbitmqdata`
  - `refactored_modutwin_miniodata`
- Standard startup command:

```bash
cd ~/refactored_modutwin
docker compose up -d --build
docker compose exec backend alembic upgrade head
```

## System Overview

The platform lets authenticated users upload or register 3D Gaussian Splatting
assets, refine them in the browser, mark door geometry, align the module to a
basemap, and publish scene outputs.

| Layer | Current role |
| --- | --- |
| Frontend | Next.js App Router UI, PlayCanvas viewer, browser-side PLY/refine/door/alignment logic |
| Backend | FastAPI API, auth/session handling, metadata CRUD, ownership checks, MinIO presigned URLs |
| PostgreSQL | users, sessions, uploads, tasks, scene outputs, buildings/floors/modules, basemaps |
| Redis | OAuth state/code storage, WebSocket tickets, Celery result backend |
| RabbitMQ | Celery broker for training/alignment and future SAM3 worker paths |
| MinIO | Original/refined/aligned PLY, mesh sidecars, basemap assets, `doors.json` |
| Nginx | Reverse proxy for frontend, backend API, WebSocket, and MinIO path proxy |

The browser still owns the expensive 3D viewer/refine/alignment interactions.
The backend should remain a policy, metadata, and storage-boundary layer.

## Frontend Structure

Important paths:

```text
frontend/src/app/                  # Next.js pages
frontend/src/components/viewer/    # Viewer shell and editor orchestration
frontend/src/components/viewer/tools/
frontend/src/lib/api.ts            # Cookie/session aware API client
frontend/src/lib/ply/              # PLY parse/write helpers
frontend/src/lib/gs/               # Gaussian and mesh processing helpers
```

Viewer refactor status:

- `SplatViewerCore.tsx` still owns PlayCanvas setup and the imperative viewer
  ref API.
- `UnifiedSplatEditor.tsx` orchestrates upload/refine/door/align mode
  transitions.
- `useRefineTool.tsx` remains large, but pure helpers were extracted to
  `refineMath.ts`, `refineTypes.ts`, and `refineSceneTransforms.ts`.
- `DoorAlignModal.tsx` remains the main door/alignment UI, with persistence,
  door JSON, and math helpers extracted.
- Refine canvas handlers are active only in `mode === 'refine'`, so brush state
  cannot leak into door selection/alignment mode.

Frontend validation:

```bash
cd frontend
npm run typecheck
npm test       # currently aliases typecheck
npm run build
```

## Backend Structure

Important paths:

```text
backend/app/api/             # FastAPI routers
backend/app/core/            # config, security, auth cookies, authorization, storage key guards
backend/app/models/          # SQLAlchemy models and enums
backend/app/schemas/         # Shared request/response schemas where extracted
backend/app/services/        # MinIO, Celery, OAuth state/code, SAM3, storage paths, WS tickets
backend/alembic/versions/    # DB migrations
```

Key refactor results:

- Cookie-based auth is the active contract.
- App access/refresh tokens are no longer stored in browser `localStorage`.
- OAuth uses state, PKCE, nonce, and Google ID token validation.
- CSRF is enforced for cookie-authenticated unsafe requests.
- Storage key checks were centralized around normalized MinIO keys and allowed
  prefixes.
- Refine save validates that `source_key` is under the owning upload's refined
  prefix.
- SAM3 dispatch is protected by `ENABLE_SAM3_DISPATCH=false` by default.

Backend validation:

```bash
cd backend
python -m compileall app tests
python -m pytest -q
```

## Main User Flows

### Auth

1. `GET /api/auth/login` creates OAuth state/PKCE/nonce and redirects to Google.
2. `GET /api/auth/callback` verifies OAuth response and Google ID token.
3. Backend sets HttpOnly access/refresh cookies plus a readable CSRF cookie.
4. Frontend calls APIs with `credentials: include` and CSRF headers for unsafe
   methods.
5. `POST /api/auth/refresh` rotates/refreshes session state.
6. `POST /api/auth/ws-ticket` issues short-lived WebSocket tickets.

Login sessions are reset whenever the PostgreSQL volume is recreated. Users
must log in again after a fresh `refactored_modutwin_pgdata` volume is created.

### Upload / Register Local

- Multipart upload uses MinIO presigned URLs.
- Local file flow can create an upload row through `/api/uploads/register-local`
  before refined assets are uploaded.
- Uploads are scoped to authenticated users.

### Refine / Door / Alignment

1. User opens a PLY/SOG scene in `/viewer`.
2. Refine mode edits points, wall meshes, textures, and sidecars in the browser.
3. "다듬기 완료" switches to door setup without committing alignment data early.
4. Door setup saves `doors.json` under the upload path.
5. Alignment loads the refined bundle only after entering align mode.
6. Alignment transform is persisted through upload/module APIs.

Important stability fixes:

- Door sync is skipped before a valid `upload_id` exists.
- Refined bundle loading is delayed until align mode to avoid expected early
  `404`s.
- Refine brush/rect/transparent handlers are disabled outside refine mode.

## SAM3 Status

SAM3 is not a completed production worker path yet.

Current safe state:

- Backend API and DB columns exist.
- Feature flag defaults to `ENABLE_SAM3_DISPATCH=false`.
- When disabled, the system should fall back to manual door selection/alignment.
- `worker/` currently has `training` and `alignment` tasks, but no
  `worker/tasks/sam3.py`.
- `door_ml/` is not present, so `docker-compose.gpu.yml` is not a default
  deploy target.

Canonical SAM3 details are in `docs/sam3_worker_callback_plan.md`.

## Storage Layout

Representative MinIO keys:

```text
buildings/{building_id}/floors/{floor_number}/modules/{module_folder}/...
buildings/{...}/refined/{session_id}/refined_*.ply
buildings/{...}/refined/{session_id}/mesh.json
buildings/{...}/refined/{session_id}/tex_*.png
buildings/{...}/refined/doors.json
basemaps/{building_id}/{floor_id}/...
```

The exact key must be generated or validated through backend storage helpers.
Do not accept arbitrary client-supplied MinIO keys without prefix validation.

## Database

Migrations are Alembic-managed. A new volume starts empty and must be migrated:

```bash
docker compose exec backend alembic upgrade head
```

Current important entities:

- `users`, `sessions`
- `buildings`, `floors`, `modules`
- `uploads`
- `tasks`
- `scene_outputs`
- `basemaps`
- `notifications`

## Operations

Standard service checks:

```bash
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
docker logs 3dgs-backend --since 2m
docker logs 3dgs-frontend --since 2m
docker logs 3dgs-nginx --since 2m
curl -i http://127.0.0.1/api/buildings?has_output=true
```

Expected empty fresh-state response:

```text
HTTP/1.1 200 OK
[]
```

## Remaining Engineering Risks

- Frontend automated test coverage is still mostly typecheck/build.
- `useRefineTool.tsx` and `DoorAlignModal.tsx` are still large interaction
  modules and need browser QA for regressions.
- SAM3 worker/callback remains future work.
- `docker-compose.gpu.yml` is not validated as part of default deployment.
- Container hardening and full TLS ownership policy are not complete refactors.
