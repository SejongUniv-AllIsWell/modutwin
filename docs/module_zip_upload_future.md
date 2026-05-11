# Module ZIP Upload (Current vs Future)

## Current behavior (2026-05-09)

- Backend accepts `.zip` uploads (`application/zip`, `application/x-zip-compressed`).
- `POST /uploads/complete` stores the uploaded ZIP object and marks the upload as `completed`.
- No worker task is dispatched for ZIP files.
- Response message indicates the ZIP is saved for later processing.

## Planned future behavior

- Parse ZIP package contents (images + optional COLMAP artifacts).
- Validate required folder/file layout.
- Dispatch worker pipeline for COLMAP preprocessing/reconstruction as needed.
- Produce normalized scene outputs and metadata for downstream module/basemap flows.

This document is intentionally scoped as a status note so frontend/API contracts can proceed before COLMAP worker support is implemented.
