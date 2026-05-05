# Refactoring Batches Roadmap

Last updated: 2026-05-05
Scope: `refactored_modutwin/`

This roadmap records what was actually completed. The current repository state
is authoritative; older review and prompt documents were folded into this file
or removed.

## Global Rules

- Preserve intended user-visible behavior.
- Do not preserve accidental or unsafe behavior as a long-term contract.
- Keep public APIs, DB schema, and deployment defaults stable unless a change is
  explicitly justified.
- Validate each batch before moving to the next one.
- Keep rollback possible through ordinary git commits.

## Completed Batches

| Batch | Status | Representative commits |
| --- | --- | --- |
| Batch 1 - Security/Stability Baseline | Completed in initial baseline | `3e14101` |
| Batch 2 - Backend Guardrails / Domain Cleanup | Completed | `5d25a9b` |
| Batch 3 - Viewer Modularization | Completed | `c35f306` |
| Batch 4 - Worker / SAM3 Preparation | Completed | `9d61be7` |
| Batch 5 - Auth Hardening / Cookie Migration | Completed through 5E | `c223192`, `68396b0`, `ed78799`, `6f53165`, `4b48668`, `c7414fa` |
| Batch 6 - Infra / DX / Final Stabilization | Completed | `d6ad3a4` |
| Post-batch QA fixes | Completed | `966a82c`, `8448314`, `172de50` |

## Batch 1 - Security / Stability Baseline

Completed in the first repository baseline.

Preserved:

- Existing upload/refine/viewer user flows.
- Existing all-auth user model.
- Training/alignment worker scaffolding.

Improved:

- Initial ownership and storage-key guardrails.
- Safer WebSocket ticket handling direction.
- Frontend dependency/security baseline.
- Basic validation commands and initial backend tests.

## Batch 2 - Backend Guardrails / Domain Cleanup

Completed in `5d25a9b`.

Applied:

- Shared authorization helpers.
- Shared storage key and storage path helpers.
- Focused backend tests around ownership/key validation.
- API route paths and response shapes preserved.

Deferred:

- Full repository/service layer rewrite.
- Full DB schema redesign.
- Broad permission model redesign for building/floor/module creation.

## Batch 3 - Viewer Modularization

Completed in `c35f306`.

Applied:

- `SplatViewerCore` camera math extraction.
- `UnifiedSplatEditor` source/layer helper extraction.
- `useRefineTool` pure math/types/scene transform helper extraction.
- `DoorAlignModal` persistence/door/math helper extraction.

Deferred:

- Full mode-specific hook split for `useRefineTool`.
- Full state-machine split for `DoorAlignModal`.
- Global viewer store introduction.
- Full PlayCanvas boundary type modeling.

Follow-up fix:

- `172de50` disables refine canvas handlers outside refine mode, preventing
  brush state from affecting door/alignment interactions.

## Batch 4 - Worker / SAM3 Preparation

Completed in `9d61be7`.

Applied:

- SAM3 dispatch feature flag defaults to OFF.
- SAM3 task contract and future callback/polling plan documented.
- Existing training/alignment paths were preserved.

Current state:

- Backend SAM3 API/DB columns exist.
- `worker/tasks/sam3.py` does not exist.
- `door_ml/` does not exist.
- Manual door selection/alignment remains the safe fallback.

## Batch 5 - Auth Hardening / Cookie Migration

Completed through 5E.

Applied:

- HttpOnly access/refresh cookies.
- CSRF cookie/header contract.
- OAuth state, PKCE S256, and nonce.
- Frontend cookie credentials and no localStorage app tokens.
- Cookie-only backend auth enforcement.
- Google ID token validation for signature, issuer, audience, expiry, nonce,
  subject, and email verification.

Important QA:

- Login callback.
- Session refresh after hard reload.
- Logout and browser cookie cleanup.
- WebSocket ticket after login.
- Unauthenticated expected 401 paths.

## Batch 6 - Infra / DX / Final Stabilization

Completed in `d6ad3a4`.

Applied:

- `docs/validation_and_qa.md`.
- GitHub Actions validation workflow.
- Compose config validation in CI.
- Manual QA checklist for high-risk flows.

Post-batch operational changes:

- Runtime compose project switched from old `modutwin` to
  `refactored_modutwin`.
- Old named volumes were removed by user request.
- Fresh DB migration and MinIO bucket initialization were verified.

## Post-batch QA Fixes

| Commit | Fix |
| --- | --- |
| `966a82c` | Skip door sync before a valid upload id exists. |
| `8448314` | Delay refined bundle loading until align mode. |
| `172de50` | Disable refine handlers outside refine mode. |

## Final Manual QA Matrix

| Area | Required checks |
| --- | --- |
| Auth | login, callback, refresh, logout, browser reload |
| Explore | empty DB returns `[]`, unauthenticated paths do not 500 |
| Dashboard | authenticated data and permission boundaries |
| Upload | multipart upload, local register, metadata selection |
| Viewer | server scene, local scene, layer add/remove/promote |
| Refine | plane/wall/brush/bbox/transparent/save |
| Door setup | prompt modal, corner pick, save/reload doors |
| Alignment | refined bundle load, basemap draft, preview, save transform |
| SAM3 disabled | no stuck queue work, manual fallback |
| Deployment | nginx, API, WebSocket, MinIO proxy, fresh migrations |

## Remaining Refactoring Opportunities

- Split `useRefineTool.tsx` into mode-specific hooks/components.
- Split `DoorAlignModal.tsx` into setup/alignment state modules.
- Add browser-level tests for viewer/refine/door/align interactions.
- Finish or remove the future SAM3 worker path.
- Harden Docker images and production TLS/trusted proxy policy.
