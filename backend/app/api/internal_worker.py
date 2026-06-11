from datetime import datetime, timezone
import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete, select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.storage_keys import normalize_minio_key
from app.services.minio_service import get_minio_service
from app.services.storage_access import delete_storage_best_effort
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
    task_type: str | None = None
    ply_key: str | None = None
    sog_key: str | None = None
    web_sog_key: str | None = None
    metadata_key: str | None = None


class WorkerTaskFailureRequest(BaseModel):
    celery_task_id: str
    upload_id: UUID | None = None
    task_type: str | None = None
    error_message: str | None = None


class WorkerSogReadyRequest(BaseModel):
    scene_id: UUID
    sog_key: str


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


def _callback_task_type(value: str | None, fallback: TaskType) -> TaskType:
    if not value:
        return fallback
    try:
        return TaskType(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid task_type: {value}",
        ) from exc


def _missing_callback_storage_fields(minio, field_keys: dict[str, str | None]) -> list[str]:
    missing: list[str] = []
    for field_name, key in field_keys.items():
        if not key:
            continue
        try:
            exists = bool(minio.object_exists(key))
        except Exception:
            exists = False
        if not exists:
            missing.append(field_name)
    return missing


async def _get_or_create_task_by_celery_id(
    db: AsyncSession,
    celery_task_id: str,
    upload_id: UUID | None,
    task_type: TaskType,
) -> Task:
    result = await db.execute(
        select(Task)
        .where(Task.celery_task_id == celery_task_id)
        .order_by(Task.created_at.desc())
        .limit(1)
    )
    task = result.scalar_one_or_none()
    if task is not None:
        return task

    if upload_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found.")

    upload = await db.get(Upload, upload_id)
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found.")

    task = Task(
        upload_id=upload.id,
        user_id=upload.user_id,
        task_type=task_type,
        celery_task_id=celery_task_id,
        status=TaskStatus.pending,
        progress=0,
    )
    db.add(task)
    await db.flush()
    return task


@router.post("/tasks/success", response_model=WorkerTaskCallbackResponse)
async def worker_task_success(
    body: WorkerTaskSuccessRequest,
    _auth: None = Depends(_require_worker_token),
    db: AsyncSession = Depends(get_db),
):
    fallback_task_type = TaskType.door_alignment if (body.metadata_key or body.web_sog_key) else TaskType.training_3dgs
    task = await _get_or_create_task_by_celery_id(
        db,
        body.celery_task_id,
        body.upload_id,
        _callback_task_type(body.task_type, fallback_task_type),
    )

    if body.upload_id is not None and body.upload_id != task.upload_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="upload_id does not match the task upload.",
        )

    ply_key = _normalize_path(body.ply_key, "ply_key")
    raw_sog_key = _normalize_path(body.sog_key, "sog_key")
    web_sog_key = _normalize_path(body.web_sog_key, "web_sog_key")
    sog_key = web_sog_key or raw_sog_key or ply_key
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

    minio = get_minio_service()
    missing_fields = _missing_callback_storage_fields(
        minio,
        {
            "ply_key": ply_key,
            "sog_key": raw_sog_key,
            "web_sog_key": web_sog_key,
            "metadata_key": metadata_key,
        },
    )
    if missing_fields:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Callback storage object not found: {', '.join(missing_fields)}",
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

    await db.commit()

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
    task = await _get_or_create_task_by_celery_id(
        db,
        body.celery_task_id,
        body.upload_id,
        _callback_task_type(body.task_type, TaskType.training_3dgs),
    )

    if body.upload_id is not None and body.upload_id != task.upload_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="upload_id does not match the task upload.",
        )

    if task.status == TaskStatus.completed:
        return WorkerTaskCallbackResponse(
            task_id=task.id,
            scene_id=None,
            status=task.status.value,
        )

    task.status = TaskStatus.failed
    task.error_message = _summarize_error_message(body.error_message)
    task.completed_at = datetime.now(timezone.utc)

    scene_rows = await db.execute(
        select(SceneOutput.id, SceneOutput.ply_path, SceneOutput.sog_path, SceneOutput.metadata_path)
        .where(SceneOutput.task_id == task.id)
    )
    scene_ids: list[UUID] = []
    keys: set[str] = set()
    for scene_id, ply_path, sog_path, metadata_path in scene_rows.all():
        scene_ids.append(scene_id)
        for key in (ply_path, sog_path, metadata_path):
            if key:
                keys.add(key)
    if scene_ids:
        await db.execute(sa_delete(SceneOutput).where(SceneOutput.id.in_(scene_ids)))

    if task.task_type in (TaskType.training_3dgs, TaskType.door_alignment):
        upload_result = await db.execute(select(Upload).where(Upload.id == task.upload_id))
        upload = upload_result.scalar_one_or_none()
        if upload is not None:
            upload.status = UploadStatus.failed

    await db.commit()
    if keys:
        delete_storage_best_effort(get_minio_service(), set(), keys)

    return WorkerTaskCallbackResponse(
        task_id=task.id,
        scene_id=None,
        status=task.status.value,
    )


@router.post("/scenes/sog-ready", response_model=WorkerTaskCallbackResponse)
async def worker_scene_sog_ready(
    body: WorkerSogReadyRequest,
    _auth: None = Depends(_require_worker_token),
    db: AsyncSession = Depends(get_db),
):
    """refined PLY → SOG 변환 완료 통지. 기존 SceneOutput 의 sog_path 만 채운다."""
    sog_key = _normalize_path(body.sog_key, "sog_key")
    if not sog_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="sog_key is required.",
        )

    scene = await db.get(SceneOutput, body.scene_id)
    if scene is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SceneOutput not found.")

    minio = get_minio_service()
    if not minio.object_exists(sog_key):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="SOG object not found in storage.",
        )

    scene.sog_path = sog_key
    await db.commit()

    return WorkerTaskCallbackResponse(
        task_id=scene.task_id,
        scene_id=scene.id,
        status="completed",
    )
