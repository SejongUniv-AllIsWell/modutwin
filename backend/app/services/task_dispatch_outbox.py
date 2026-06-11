from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session
from app.models import (
    Sam3Status,
    Task,
    TaskDispatchOutbox,
    TaskStatus,
    TaskType,
    Upload,
    UploadStatus,
)
from app.services.celery_service import SAM3_DOOR_ML_TASK_NAME, dispatch_task_payload

logger = logging.getLogger(__name__)

OUTBOX_PENDING = "pending"
OUTBOX_DISPATCHED = "dispatched"
OUTBOX_FAILED = "failed"
OUTBOX_CANCELLED = "cancelled"

DISPATCH_INTERVAL_SECONDS = 5
DISPATCH_BATCH_SIZE = 20
MAX_BACKOFF_SECONDS = 300


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def enqueue_task_dispatch(
    db: AsyncSession,
    *,
    celery_task_id: str,
    task_name: str,
    queue: str | None,
    args: list[Any] | None = None,
    kwargs: dict[str, Any] | None = None,
    task_id: UUID | None = None,
    upload_id: UUID | None = None,
    max_attempts: int = 20,
) -> TaskDispatchOutbox:
    row = TaskDispatchOutbox(
        task_id=task_id,
        upload_id=upload_id,
        celery_task_id=celery_task_id,
        task_name=task_name,
        queue=queue,
        args=args or [],
        kwargs=kwargs or {},
        status=OUTBOX_PENDING,
        attempts=0,
        max_attempts=max_attempts,
        next_attempt_at=_utcnow(),
    )
    db.add(row)
    await db.flush()
    return row


async def dispatch_outbox_by_id(outbox_id: UUID) -> bool:
    async with async_session() as db:
        result = await db.execute(
            select(TaskDispatchOutbox)
            .where(TaskDispatchOutbox.id == outbox_id)
            .with_for_update(skip_locked=True)
        )
        row = result.scalar_one_or_none()
        if row is None:
            return False
        dispatched = await _dispatch_one(db, row)
        await db.commit()
        return dispatched


async def dispatch_due_outbox(limit: int = DISPATCH_BATCH_SIZE) -> int:
    now = _utcnow()
    dispatched_count = 0
    async with async_session() as db:
        result = await db.execute(
            select(TaskDispatchOutbox)
            .where(
                TaskDispatchOutbox.status == OUTBOX_PENDING,
                TaskDispatchOutbox.next_attempt_at <= now,
            )
            .order_by(TaskDispatchOutbox.created_at.asc())
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        rows = list(result.scalars().all())
        for row in rows:
            if await _dispatch_one(db, row):
                dispatched_count += 1
        await db.commit()
    return dispatched_count


async def dispatch_outbox_loop() -> None:
    while True:
        try:
            await dispatch_due_outbox()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[task_dispatch_outbox] dispatch loop failed")
        await asyncio.sleep(DISPATCH_INTERVAL_SECONDS)


async def _dispatch_one(db: AsyncSession, row: TaskDispatchOutbox) -> bool:
    if row.status != OUTBOX_PENDING:
        return row.status == OUTBOX_DISPATCHED

    task = await db.get(Task, row.task_id) if row.task_id else None
    if row.task_id and task is None:
        row.status = OUTBOX_CANCELLED
        row.last_error = "Linked task was deleted before dispatch."
        return False
    if task and task.status in (TaskStatus.completed, TaskStatus.failed):
        row.status = OUTBOX_CANCELLED
        row.last_error = f"Linked task is already {task.status.value}."
        return False

    try:
        dispatched_task_id = dispatch_task_payload(
            task_name=row.task_name,
            args=row.args,
            kwargs=row.kwargs,
            queue=row.queue,
            task_id=row.celery_task_id,
        )
        row.status = OUTBOX_DISPATCHED
        row.dispatched_at = _utcnow()
        row.last_error = None
        if dispatched_task_id != row.celery_task_id:
            logger.warning(
                "[task_dispatch_outbox] dispatched id mismatch: row=%s expected=%s actual=%s",
                row.id,
                row.celery_task_id,
                dispatched_task_id,
            )
        await _mark_dispatched_state(db, row, task)
        return True
    except Exception as exc:
        await _mark_dispatch_failure(db, row, task, exc)
        return False


async def _mark_dispatched_state(
    db: AsyncSession,
    row: TaskDispatchOutbox,
    task: Task | None,
) -> None:
    if row.task_name != SAM3_DOOR_ML_TASK_NAME or task is None:
        return
    if task.status not in (TaskStatus.completed, TaskStatus.failed):
        task.status = TaskStatus.running
        task.error_message = None
        task.completed_at = None
    upload = await db.get(Upload, task.upload_id)
    if upload is not None and upload.sam3_status != Sam3Status.done:
        upload.sam3_status = Sam3Status.running


async def _mark_dispatch_failure(
    db: AsyncSession,
    row: TaskDispatchOutbox,
    task: Task | None,
    exc: Exception,
) -> None:
    row.attempts = int(row.attempts or 0) + 1
    row.last_error = str(exc)[:1000]
    if row.attempts >= row.max_attempts:
        row.status = OUTBOX_FAILED
        if task is not None:
            task.status = TaskStatus.failed
            task.progress = 0
            task.error_message = f"태스크 발행 실패: {row.last_error[:450]}"
            task.completed_at = _utcnow()
            upload = await db.get(Upload, task.upload_id)
            if upload is not None:
                if task.task_type == TaskType.sam3_door_detection:
                    upload.sam3_status = Sam3Status.failed
                elif task.task_type in (
                    TaskType.colmap_preprocessing,
                    TaskType.training_3dgs,
                    TaskType.door_alignment,
                ):
                    upload.status = UploadStatus.failed
        logger.exception(
            "[task_dispatch_outbox] dispatch permanently failed: row=%s task=%s",
            row.id,
            row.task_id,
        )
        return

    backoff_seconds = min(MAX_BACKOFF_SECONDS, 2 ** min(row.attempts, 8))
    row.next_attempt_at = _utcnow() + timedelta(seconds=backoff_seconds)
    logger.warning(
        "[task_dispatch_outbox] dispatch failed; will retry: row=%s attempt=%s/%s error=%s",
        row.id,
        row.attempts,
        row.max_attempts,
        row.last_error,
    )
