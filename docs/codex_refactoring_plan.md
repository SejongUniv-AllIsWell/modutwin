# Codex Refactoring Plan - Current State and Remaining Work

Last updated: 2026-05-05
Scope: `refactored_modutwin/`

The original full-codebase refactoring plan has been executed in smaller
batches. The completed batch history is now tracked in
`docs/refactoring_batches_roadmap.md`. This document keeps the current
engineering intent and the remaining work, not the stale pre-refactor findings.

## Current Summary

The refactor focused on stabilizing the end-to-end flow:

```text
upload/register -> refine -> door setup -> alignment -> scene output
```

The most important outcomes:

- Cookie-only app auth replaced localStorage/Bearer app tokens.
- OAuth state, PKCE, nonce, and Google ID token validation were added.
- Backend guardrails around ownership and MinIO key prefixes were improved.
- Viewer helper code was partially extracted.
- Refine-mode canvas handlers no longer leak into door/alignment stages.
- SAM3 dispatch is feature-flagged off by default until a real worker/callback
  path exists.
- CI and validation docs were added.
- Runtime deployment now uses the `refactored_modutwin` compose project and
  `refactored_modutwin_*` volumes.

## Current Architecture Intent

### Backend

Keep routers as API adapters and move reusable policy/storage behavior into:

- `backend/app/core/authorization.py`
- `backend/app/core/storage_keys.py`
- `backend/app/services/storage_paths.py`
- service modules under `backend/app/services/`

Do not accept client-supplied MinIO keys without normalization and prefix
validation.

### Frontend

Keep `UnifiedSplatEditor` as the stage orchestrator, but isolate per-stage
behavior so hidden tools cannot affect the active stage. Refine, door setup,
and alignment state should not leak through shared canvas listeners.

### Worker / SAM3

Training/alignment scaffolding remains present. SAM3 remains future work:

- `ENABLE_SAM3_DISPATCH=false` is the safe default.
- `worker/tasks/sam3.py` is not implemented.
- callback/polling state transitions are documented but not active.

### Operations

Use `docker compose` from `refactored_modutwin/` without `-p modutwin` for the
new canonical project identity.

## Completed Objectives

| Objective | Status |
| --- | --- |
| Auth token storage hardening | Completed |
| OAuth state/PKCE/nonce | Completed |
| Google ID token validation | Completed |
| Backend storage key guardrails | Completed for critical refine/upload paths |
| SAM3 dispatch protection | Completed |
| Viewer helper extraction | Partially completed |
| Stage isolation bug fixes | Completed for known refine -> door/alignment leak |
| CI/validation docs | Completed |
| Compose project migration | Completed |

## Remaining Work

### 1. Viewer Decomposition

`useRefineTool.tsx` and `DoorAlignModal.tsx` are still large. Future work should
split them by behavior rather than by arbitrary helper extraction:

- refine mode hooks: plane, brush/select, bbox/rect, transparent, save
- door setup state and persistence
- alignment state and transform preview
- PlayCanvas boundary types

Risk: high browser interaction regression. Require manual QA or browser tests.

### 2. Backend Domain Layering

The most critical guardrails are in place, but routers still contain domain
logic. Future work can move query/transaction code to services/repositories by
domain:

1. uploads/refine/scenes
2. buildings/basemaps
3. tasks/notifications/ws

Preserve route paths and response shapes unless explicitly approved.

### 3. SAM3 Worker Completion or Removal

Choose one:

- Implement the real worker/callback flow described in
  `docs/sam3_worker_callback_plan.md`.
- Or remove inactive SAM3 UI/backend/compose references and keep manual door
  selection only.

Do not enable `ENABLE_SAM3_DISPATCH` in production until this is resolved.

### 4. Test Coverage

Add browser-level coverage for:

- auth callback/session refresh
- viewer load
- refine stage transition
- door selection save/reload
- alignment preview/save

Frontend `npm test` is currently typecheck-only.

### 5. Production Hardening

Remaining operations work:

- container non-root users
- image size and dependency audit policy
- trusted proxy policy for `CF-Connecting-IP`
- explicit TLS/certificate ownership policy
- GPU compose validation if GPU worker becomes active

## Decision Gates

Before future broad changes, decide:

1. Is SAM3 a committed product path or an experimental placeholder?
2. Should building/floor/module creation stay all-auth or become admin/scoped?
3. Should public scene reads remain allowed anywhere?
4. Which browser interactions deserve Playwright coverage first?

## Success Criteria for Future Work

- No 500s on fresh DB/MinIO volumes after migration.
- Auth/session flows pass manual and automated checks.
- Viewer stages are isolated: inactive tools do not receive canvas input.
- Public API response shapes remain stable.
- `npm run typecheck`, `npm run build`, backend compile, and backend tests pass.
