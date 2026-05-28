# Validation and QA Guide

Last updated: 2026-05-27

This is the validation contract for the current codebase. It covers local
checks, container smoke checks, and manual QA for the high-risk browser flows.

## Automated Checks

### Backend

From `backend/`:

```bash
python -m compileall app tests
python -m pytest -q
```

Container fallback:

```bash
docker build -t modutwin-backend ./backend
docker run --rm --env-file .env \
  -v "$PWD/backend:/app" \
  -v "$PWD/core:/app/core:ro" \
  -v "$PWD/utilities:/app/utilities:ro" \
  modutwin-backend python -m pytest -q
```

### Frontend

From `frontend/`:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` currently aliases `npm run typecheck`. Do not report it as UI or
browser interaction coverage.

### Compose

The normal project name is the directory-derived `modutwin` when the checkout
directory is named `modutwin`.

```bash
docker compose config
docker compose -f docker-compose.yml -f docker-compose.local.yml config
```

For rollout:

```bash
docker compose up -d --build
docker compose exec backend alembic upgrade head
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
```

## Smoke Checks

Run after deployment or container recreation:

```bash
docker logs 3dgs-backend --since 2m
docker logs 3dgs-frontend --since 2m
docker logs 3dgs-nginx --since 2m
curl -i http://127.0.0.1/api/buildings?has_output=true
curl -i http://127.0.0.1/api/auth/me
```

Expected fresh-state results:

- `GET /api/buildings?has_output=true` -> `200 OK []`
- `GET /api/auth/me` without cookies -> `401 Unauthorized`

## Environment Matrix

| Mode | Command | Notes |
| --- | --- | --- |
| Local HTTP | `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build` | Uses `nginx.local.conf`; run migrations after startup. |
| Production-like | `docker compose up -d --build` | Uses base compose and `.env` values such as `PUBLIC_BASE_URL`. |
| Backend isolated test | `docker run --rm --env-file .env ... python -m pytest -q` | Useful when host Python lacks pytest. |
| GPU worker | `docker compose -f docker-compose.gpu.yml config` | Optional; used for GPU/door-ml related services. |

Required environment checks:

- `PUBLIC_BASE_URL` matches externally visible scheme and host.
- `DEV_MODE=false` outside isolated development.
- Keep `ENABLE_SAM3_DISPATCH=false` unless the legacy async SAM3 worker/callback
  path is intentionally deployed.
- Redis/RabbitMQ/MinIO host bindings stay scoped to `PC_HOST_IP`.
- New DB volumes always receive `alembic upgrade head`.

## Manual QA Checklist

| Area | Expected behavior | Edge cases |
| --- | --- | --- |
| Auth login | Google OAuth redirects to `/login/callback`, then user is authenticated. | Invalid state, invalid nonce, invalid ID token, missing `PUBLIC_BASE_URL`. |
| Session refresh | Hard reload keeps valid sessions through cookies; expired access cookie refreshes. | Revoked/expired refresh cookie returns 401 and frontend clears session state. |
| Logout | `/auth/logout` revokes server session and clears cookies. | Access cookie expired but refresh cookie valid. |
| Explore | Unauthenticated user can open explore; protected calls show expected 401 only where auth is required. | Empty fresh DB returns no buildings without 500. |
| Dashboard | Authenticated user sees own uploads/scenes only. | Old browser localStorage tokens should not authenticate. |
| Upload | Multipart upload and local register flow work with cookie credentials. | Invalid size, missing metadata, foreign/invalid object keys. |
| Viewer | Server scene and local file loading work. | Additional layer add/remove/promote, WebSocket ticket after login. |
| Refine | Plane/wall/brush/bbox/transparent/refined save flows still work. | Refine brush must not affect door/alignment mode after stage transition. |
| Basemap registration | Refine complete -> door setup -> door extraction -> registered doors save to `doors.json`; completion modal appears centered. | Missing `doors.json`, invalid corners, stale room picker state, backend restart during upload. |
| Basemap edit | Existing registered doors hydrate without opening the room picker; extraction is disabled until four corners are picked; locked aligned rooms remain read-only. | Duplicate room labels from older bugs, deleting unaligned doors, CPU RGBA cache restoration for wall texture punch. |
| Module registration | Refine complete bakes rotation/deletion into canonical in-memory PLY; door setup and alignment use that canonical scene. | Door extraction must not resurrect deleted splats or double-rotate the main splat. |
| Alignment | Module align complete submits `final.ply`, `mesh.json`, wall textures, `doors.json`, and `alignment_transform` through `POST /uploads/commit-final`. | Missing refined bundle, hidden building/floor/module, invalid basemap JSON, `sog_path` nullable migration not applied. |
| Floor overview | Active basemap plus aligned modules load together; wall mesh, door mesh/splat, and doorFrame are visible. | Multiple heavy modules may hit browser memory limits; see `ROADMAP.md` before changing load policy. |
| SAM3 disabled | Feature flag OFF does not enqueue unusable SAM3 work; manual fallback remains possible. | User enters prompt, worker absent, no `doors.json`. |
| Deployment | Nginx routes `/`, `/_next`, `/api`, `/api/ws`, and MinIO proxy paths. | Backend restart race may create a short 502; it should recover. |

## Rollback Notes

For code rollback, prefer `git revert` of the specific recent commit(s) over
destructive history rewrites. For deployment rollback:

```bash
git log --oneline -10
git revert <bad_commit>
docker compose up -d --build
docker compose exec backend alembic upgrade head
```

For data rollback, do not run `docker compose down -v` unless intentionally
discarding PostgreSQL, Redis, RabbitMQ, and MinIO data.

## Remaining Risks

- Frontend browser interaction tests are still manual.
- OAuth callback requires live Google/browser QA.
- The legacy async SAM3 worker/callback path is disabled unless explicitly enabled.
- GPU compose path is not part of default CI validation.
- TLS/DNS/certificate correctness cannot be proven by compose config rendering.
