# SAM3 Door Detection and Callback Plan

Last updated: 2026-05-05
Status: feature flag OFF by default; real worker/callback not implemented

This is the canonical SAM3 document. It replaces the older separate alignment
pipeline, GPU worker notes, and refine-save service notes.

## Current Runtime State

Implemented:

- DB columns for refined/SAM3 state.
- Backend endpoints for starting SAM3, polling status, reading/writing
  `doors.json`, and saving alignment.
- Frontend prompt/manual door setup flow.
- Feature flag default: `ENABLE_SAM3_DISPATCH=false`.

Not implemented:

- `worker/tasks/sam3.py`
- a running `sam3` Celery consumer
- backend callback endpoints for worker success/failure
- `door_ml/` service directory

Safe operating rule: keep `ENABLE_SAM3_DISPATCH=false` until the worker and
callback/polling state transition path exists.

## Intended Product Flow

The user flow should remain a single path:

```text
refine -> door setup -> alignment
```

SAM3, when available, only pre-populates module door corners. It should not
create a separate automatic-vs-manual alignment mode. If SAM3 is unavailable or
fails, the user manually picks door corners and proceeds.

## Current Refine Save Sequence

When the user completes door setup, the frontend performs these operations:

1. Optional local-file registration through `POST /api/uploads/register-local`.
2. Presigned upload URL requests through `POST /api/refine/refined-upload-url`.
3. Browser uploads refined PLY, `mesh.json`, and `tex_*.png` directly to MinIO.
4. Backend scene output registration through `POST /api/refine/save`.
5. Door JSON persistence through `PUT /api/uploads/{upload_id}/doors`.
6. Alignment later reads refined sidecars through
   `GET /api/refine/refined-bundle?upload_id=...`.

Important current behavior:

- The refined bundle is loaded only after entering align mode.
- Door sync is skipped until a valid `upload_id` exists.
- Refine canvas tools are inactive outside refine mode.

## Backend API Contract

Current relevant endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/uploads/{upload_id}/sam3/start` | Start SAM3 dispatch if enabled. |
| `GET /api/uploads/{upload_id}/sam3` | Return DB-backed SAM3 status. |
| `GET /api/uploads/{upload_id}/doors` | Read `doors.json`. |
| `PUT /api/uploads/{upload_id}/doors` | Replace `doors.json`. |
| `POST /api/uploads/{upload_id}/alignment` | Save alignment transform/matching metadata. |
| `POST /api/refine/refined-upload-url` | Issue presigned PUT URL under refined prefix. |
| `POST /api/refine/save` | Create task/scene output for refined PLY. |
| `GET /api/refine/refined-bundle` | Return refined PLY/mesh/texture bundle URLs. |

## DB State Contract

`uploads` stores the SAM3/refined state:

| Column | Meaning |
| --- | --- |
| `refined_ply_path` | MinIO key for the refined PLY. |
| `door_corners_json_path` | MinIO key for `doors.json`, nullable. |
| `sam3_status` | `pending`, `running`, `done`, or `failed`. |
| `sam3_prompt` | User prompt text. |

`tasks` stores async task tracking. For future SAM3 work, use
`task_type=sam3_door_detection`.

## Future Worker Task Contract

Celery task:

```text
name: tasks.sam3.run_door_detection
queue: sam3
```

Current backend dispatch payload uses positional args:

```text
upload_id
user_id
refined_ply_key
prompt
building_id
floor_id
floor_number
module_id
module_name
```

Recommended future change: move to kwargs with `schema_version` to avoid order
dependency.

Worker responsibilities:

1. Validate payload and ownership-safe key prefixes.
2. Download `refined_ply_key` from MinIO.
3. Run SAM3 door detection.
4. Serialize `doors.json`.
5. Upload `doors.json` under the upload/refined path.
6. Notify backend through callback or a polling-compatible result record.

Suggested `doors.json` shape:

```json
{
  "doors": [
    {
      "id": "door_1",
      "corners": [[0, 0, 0], [1, 0, 0], [1, 2, 0], [0, 2, 0]]
    }
  ]
}
```

## Future Callback API

Recommended endpoints:

- `POST /internal/sam3/callback/success`
- `POST /internal/sam3/callback/failure`

Required protections:

- `X-Worker-Token` shared secret or stronger HMAC signature.
- Network allowlist where possible, preferably private/Tailscale path.
- Idempotent update keyed by `celery_task_id`.

Success body:

```json
{
  "upload_id": "uuid",
  "celery_task_id": "string",
  "door_corners_json_path": "buildings/.../refined/doors.json",
  "error_message": null
}
```

On success:

- `uploads.sam3_status = done`
- `uploads.door_corners_json_path = <doors.json key>`
- matching `tasks` row becomes `completed`, `progress=100`

On failure:

- `uploads.sam3_status = failed`
- matching `tasks` row becomes `failed`
- `error_message` is stored in summarized form

## GPU Worker Deployment Notes

Current default stack does not start a GPU worker.

If implementing the future GPU worker:

- Use a private network path such as Tailscale for Redis/RabbitMQ/MinIO.
- Keep `.env` secrets identical between web server and GPU worker.
- Validate reachability before starting worker containers:

```bash
nc -zv <PC_HOST_IP> 5673
nc -zv <PC_HOST_IP> 6379
nc -zv <PC_HOST_IP> 9000
```

Current `docker-compose.gpu.yml` should be treated as a future draft because it
references `./door_ml`, which is not present in the repository.

## Interim QA

With `ENABLE_SAM3_DISPATCH=false`:

1. Start from a fresh migrated DB.
2. Upload/register a scene.
3. Complete refine and door setup manually.
4. Confirm no unusable SAM3 worker is required.
5. Confirm `GET /api/refine/refined-bundle?upload_id=...` is called only in
   align mode.
6. Confirm manual alignment still saves.

## Future QA

With worker/callback implemented and `ENABLE_SAM3_DISPATCH=true`:

1. `sam3/start` creates a `tasks.sam3_door_detection` row.
2. Worker logs show receipt of `tasks.sam3.run_door_detection`.
3. MinIO receives `doors.json`.
4. Callback updates DB to `done/completed`.
5. `GET /uploads/{id}/sam3` returns `has_doors_json=true`.
6. Viewer displays detected door corners and allows manual correction.
7. Failure cases move to `failed` and keep manual fallback usable.

## Remaining Risks

- Enabling dispatch before worker/callback exists will create stuck or failed
  work.
- Callback security is not implemented.
- GPU compose is not validated in default CI.
- Door detection quality and coordinate-frame guarantees are not yet proven by
  automated tests.
