"""워커 → 백엔드 내부 콜백.

워커가 파이프라인 단계 완료 시 이 엔드포인트를 호출해 DB 상태를 갱신한다.
공유 시크릿 (X-Internal-Token) 으로 보호한다.
"""
from datetime import datetime, timezone
from typing import Literal, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.models import Upload, UploadStatus, Task, TaskStatus, TaskType
from app.services.celery_service import GS_FROM_COLMAP_TASK_NAME, TRAINING_QUEUE
from app.services.minio_service import get_minio_service
from app.services.storage_access import delete_storage_best_effort
from app.services.task_dispatch_outbox import dispatch_outbox_by_id, enqueue_task_dispatch

router = APIRouter(prefix="/internal", tags=["internal"])
settings = get_settings()


class UploadCompleteCallback(BaseModel):
    stage: Literal["colmap", "gsplat"]
    status: Literal["completed", "failed"] = "completed"
    ply_key: Optional[str] = None              # gsplat 단계에서 결과 PLY MinIO key
    celery_task_id: Optional[str] = None       # 매칭되는 Task row 가 있으면 progress/status 함께 갱신
    error_message: Optional[str] = None


def _check_token(x_internal_token: Optional[str]) -> None:
    if not settings.INTERNAL_API_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="INTERNAL_API_TOKEN 미설정 — 콜백 비활성 상태입니다.",
        )
    if x_internal_token != settings.INTERNAL_API_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid internal token")


def _failed_pipeline_cleanup_targets(upload: Upload, stage: str) -> tuple[set[str], set[str]]:
    """Return artifacts produced by a failed COLMAP pipeline stage."""
    prefixes: set[str] = set()
    keys: set[str] = set()
    if stage == "colmap":
        prefixes.add(f"users/{upload.user_id}/colmap/{upload.id}")
        prefixes.add(f"users/{upload.user_id}/gsplat/{upload.id}")
    elif stage == "gsplat":
        prefixes.add(f"users/{upload.user_id}/gsplat/{upload.id}")

    if upload.gsplat_ply_path:
        keys.add(upload.gsplat_ply_path)
        upload.gsplat_ply_path = None

    return prefixes, keys


def _task_type_for_stage(stage: str) -> TaskType:
    if stage == "colmap":
        return TaskType.colmap_preprocessing
    return TaskType.training_3dgs


async def _upsert_callback_task(
    db: AsyncSession,
    upload: Upload,
    body: UploadCompleteCallback,
    now: datetime,
) -> Task | None:
    """Update the task matching celery_task_id, or create a fallback row for legacy callbacks."""
    if not body.celery_task_id:
        return None

    task_result = await db.execute(
        select(Task).where(Task.celery_task_id == body.celery_task_id)
    )
    task = task_result.scalar_one_or_none()
    if task is None:
        task = Task(
            upload_id=upload.id,
            user_id=upload.user_id,
            task_type=_task_type_for_stage(body.stage),
            celery_task_id=body.celery_task_id,
        )
        db.add(task)

    if body.status == "failed":
        task.status = TaskStatus.failed
        task.error_message = body.error_message
        task.completed_at = now
    else:
        task.status = TaskStatus.completed
        task.progress = 100
        task.error_message = None
        task.completed_at = now

    return task


async def _prepare_gs_after_colmap(
    db: AsyncSession,
    upload: Upload,
) -> UUID | None:
    """Create the GS task/outbox rows after COLMAP succeeds and return outbox id.

    COLMAP used to chain GS inside the worker, which left no backend Task row for
    the GS stage. Keeping dispatch here makes status, failure, and retry state
    observable from the dashboard.
    """
    existing_result = await db.execute(
        select(Task)
        .where(
            Task.upload_id == upload.id,
            Task.task_type == TaskType.training_3dgs,
            Task.status.in_([TaskStatus.pending, TaskStatus.running, TaskStatus.completed]),
        )
        .order_by(Task.created_at.desc())
        .limit(1)
    )
    if existing_result.scalar_one_or_none() is not None:
        return None

    celery_task_id = str(uuid4())
    task = Task(
        upload_id=upload.id,
        user_id=upload.user_id,
        task_type=TaskType.training_3dgs,
        celery_task_id=celery_task_id,
        status=TaskStatus.pending,
        progress=0,
    )
    db.add(task)
    await db.flush()
    outbox = await enqueue_task_dispatch(
        db,
        task_id=task.id,
        upload_id=upload.id,
        celery_task_id=celery_task_id,
        task_name=GS_FROM_COLMAP_TASK_NAME,
        queue=TRAINING_QUEUE,
        args=[str(upload.id), str(upload.user_id), upload.minio_path, {}],
    )
    return outbox.id


@router.post("/uploads/{upload_id}/complete")
async def upload_pipeline_callback(
    upload_id: UUID,
    body: UploadCompleteCallback,
    x_internal_token: Optional[str] = Header(default=None, alias="X-Internal-Token"),
    db: AsyncSession = Depends(get_db),
):
    _check_token(x_internal_token)

    result = await db.execute(select(Upload).where(Upload.id == upload_id))
    upload = result.scalar_one_or_none()
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="upload not found")

    now = datetime.now(timezone.utc)
    cleanup_prefixes: set[str] = set()
    cleanup_keys: set[str] = set()
    gs_outbox_id: UUID | None = None

    if body.status == "failed" and body.celery_task_id:
        existing_task_result = await db.execute(
            select(Task).where(Task.celery_task_id == body.celery_task_id)
        )
        existing_task = existing_task_result.scalar_one_or_none()
        if existing_task is not None and existing_task.status == TaskStatus.completed:
            return {
                "ok": True,
                "upload_id": str(upload_id),
                "stage": body.stage,
                "status": existing_task.status.value,
                "ignored": "completed_task",
            }

    if body.status == "failed":
        cleanup_prefixes, cleanup_keys = _failed_pipeline_cleanup_targets(upload, body.stage)
        upload.status = UploadStatus.failed
    elif body.stage == "gsplat":
        # 최종 단계: 업로드 완료 처리 + 결과 PLY 경로 저장
        upload.status = UploadStatus.completed
        if body.ply_key:
            upload.gsplat_ply_path = body.ply_key
    else:
        # COLMAP 단계만 끝났으면 아직 GS 학습 진행 중이라 processing 유지
        upload.status = UploadStatus.processing

    await _upsert_callback_task(db, upload, body, now)

    if body.stage == "colmap" and body.status == "completed":
        gs_outbox_id = await _prepare_gs_after_colmap(db, upload)

    await db.commit()
    if cleanup_prefixes or cleanup_keys:
        delete_storage_best_effort(get_minio_service(), cleanup_prefixes, cleanup_keys)

    if gs_outbox_id:
        await dispatch_outbox_by_id(gs_outbox_id)

    return {
        "ok": True,
        "upload_id": str(upload_id),
        "stage": body.stage,
        "status": body.status,
    }
