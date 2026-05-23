# Documentation Index

Last updated: 2026-05-05

This directory keeps only current, repository-facing documents. Historical
review notes, one-off prompts, duplicated translations, and outdated narrow
plans were removed or merged.

## Current Documents

| Document | Purpose |
| --- | --- |
| `CODEBASE_REFERENCE.md` | Current architecture, runtime identity, main modules, data flows, and remaining risks. |
| `DEVELOPMENT.md` | Local/prod-like startup, environment setup, migrations, validation, and GPU notes. |
| `validation_and_qa.md` | Repeatable checks, smoke tests, manual QA matrix, and rollback notes. |
| `frontend_pages.md` | Current frontend App Router pages and shared shell components. |
| `refactoring_batches_roadmap.md` | Completed refactoring batch history and remaining refactoring opportunities. |
| `codex_refactoring_plan.md` | Current refactoring intent and future work after completed batches. |
| `sam3_worker_callback_plan.md` | Canonical SAM3 feature-flag, worker, callback, and manual fallback plan. |

## Removed or Merged

| Removed document | Reason |
| --- | --- |
| `CODEBASE_REFERENCE_KOR.md` | Duplicate of the architecture reference; current canonical reference is `CODEBASE_REFERENCE.md`. |
| `how_to_run.md` | Merged into `DEVELOPMENT.md`. |
| `gpu_worker.md` | Duplicated and partially corrupted; useful notes merged into `DEVELOPMENT.md` and `sam3_worker_callback_plan.md`. |
| `nginx_conf_guide.md` | General nginx directive tutorial, not project-specific. |
| `codex_review.md` | Pre-refactor findings; resolved/remaining items are reflected in roadmap and current plan. |
| `recatroing_plan.md` | Stale duplicate plan with typo in filename. |
| `batch3_viewer_refactor_plan.md` | Batch-specific historical plan; outcome summarized in `refactoring_batches_roadmap.md`. |
| `sam3_alignment_pipeline.md` | Merged into `sam3_worker_callback_plan.md`. |
| `codex_refactoring_prompt.md` | One-off agent prompt, not a project document. |
| `다듬기.md` | Refine save/SAM3 service notes merged into `sam3_worker_callback_plan.md`. |
