from datetime import datetime, timezone
import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.storage_keys import normalize_minio_key
from app.models import (
    Floor,
    Module,
    SceneOutput,
    Task,
    TaskStatus,
    TaskType,
    Upload,
    UploadStatus,
)

router = APIRouter(prefix="/internal/worker", tags=["internal-worker"])
settings = get_settings()


class WorkerTaskSuccessRequest(BaseModel):
    celery_task_id: str
    upload_id: UUID | None = None
    ply_key: str | None = None
    sog_key: str | None = None
    web_sog_key: str | None = None
    metadata_key: str | None = None


class WorkerTaskFailureRequest(BaseModel):
    celery_task_id: str
    upload_id: UUID | None = None
    error_message: str | None = None


class WorkerTaskCallbackResponse(BaseModel):
    task_id: UUID
    scene_id: UUID | None = None
    status: str


def _require_worker_token(x_worker_token: str | None = Header(default=None, alias="X-Worker-Token")) -> None:
    configured_token = settings.WORKER_CALLBACK_TOKEN
    if not configured_token:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Worker callback token is not configured.",
        )
    if not x_worker_token or not secrets.compare_digest(x_worker_token, configured_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid worker callback token.",
        )


def _normalize_path(value: str | None, field_name: str) -> str | None:
    if value is None:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    try:
        return normalize_minio_key(candidate)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {field_name}: {exc}",
        ) from exc


def _summarize_error_message(error_message: str | None, max_len: int = 500) -> str:
    message = (error_message or "Worker task failed.").strip()
    if len(message) <= max_len:
        return message
    return f"{message[: max_len - 3].rstrip()}..."


async def _get_task_by_celery_id(db: AsyncSession, celery_task_id: str) -> Task:
    result = await db.execute(
        select(Task)
        .where(Task.celery_task_id == celery_task_id)
        .order_by(Task.created_at.desc())
        .limit(1)
    )
    task = result.scalar_one_or_none()
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found.")
    return task


@router.post("/tasks/success", response_model=WorkerTaskCallbackResponse)
async def worker_task_success(
    body: WorkerTaskSuccessRequest,
    _auth: None = Depends(_require_worker_token),
    db: AsyncSession = Depends(get_db),
):
    task = await _get_task_by_celery_id(db, body.celery_task_id)

    if body.upload_id is not None and body.upload_id != task.upload_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="upload_id does not match the task upload.",
        )

    ply_key = _normalize_path(body.ply_key, "ply_key")
    sog_key = _normalize_path(body.web_sog_key, "web_sog_key") or _normalize_path(body.sog_key, "sog_key") or ply_key
    metadata_key = _normalize_path(body.metadata_key, "metadata_key")
    if not ply_key and not sog_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one of ply_key/sog_key/web_sog_key must be provided.",
        )
    if not ply_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ply_key is required to persist SceneOutput.",
        )

    upload_result = await db.execute(select(Upload).where(Upload.id == task.upload_id))
    upload = upload_result.scalar_one_or_none()
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found.")

    scene_result = await db.execute(
        select(SceneOutput)
        .where(SceneOutput.task_id == task.id)
        .limit(1)
    )
    scene = scene_result.scalar_one_or_none()
    if scene is None:
        scene = SceneOutput(
            task_id=task.id,
            user_id=task.user_id,
            module_id=upload.module_id,
            ply_path=ply_key,
            # Worker completion is the path that can provide the optional
            # viewer-optimized SOG alongside the canonical PLY.
            sog_path=sog_key,
            metadata_path=metadata_key,
            is_aligned=(task.task_type == TaskType.door_alignment),
        )
        db.add(scene)
        await db.flush()
    else:
        scene.user_id = task.user_id
        scene.module_id = upload.module_id
        scene.ply_path = ply_key
        scene.sog_path = sog_key
        scene.metadata_path = metadata_key
        scene.is_aligned = task.task_type == TaskType.door_alignment

    task.status = TaskStatus.completed
    task.progress = 100
    task.error_message = None
    task.completed_at = datetime.now(timezone.utc)

    upload.status = UploadStatus.completed

    floor_id_result = await db.execute(
        select(Module.floor_id).where(Module.id == upload.module_id)
    )
    floor_id = floor_id_result.scalar_one_or_none()
    if floor_id is not None:
        await db.execute(
            sa_update(Floor)
            .where(Floor.id == floor_id)
            .values(overview_dirty=True)
        )

    return WorkerTaskCallbackResponse(
        task_id=task.id,
        scene_id=scene.id,
        status=task.status.value,
    )


@router.post("/tasks/failure", response_model=WorkerTaskCallbackResponse)
async def worker_task_failure(
    body: WorkerTaskFailureRequest,
    _auth: None = Depends(_require_worker_token),
    db: AsyncSession = Depends(get_db),
):
    task = await _get_task_by_celery_id(db, body.celery_task_id)

    if body.upload_id is not None and body.upload_id != task.upload_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="upload_id does not match the task upload.",
        )

    task.status = TaskStatus.failed
    task.error_message = _summarize_error_message(body.error_message)
    task.completed_at = datetime.now(timezone.utc)

    if task.task_type == TaskType.training_3dgs:
        upload_result = await db.execute(select(Upload).where(Upload.id == task.upload_id))
        upload = upload_result.scalar_one_or_none()
        if upload is not None:
            upload.status = UploadStatus.failed

    return WorkerTaskCallbackResponse(
        task_id=task.id,
        scene_id=None,
        status=task.status.value,
    )
