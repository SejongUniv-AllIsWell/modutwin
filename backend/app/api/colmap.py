from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import User, Upload, Task, TaskType, TaskStatus, PlyTarget
from app.services.minio_service import get_minio_service
from app.services.celery_service import dispatch_gs_training_from_colmap_task

router = APIRouter(prefix="/uploads", tags=["colmap"])


class ColmapResultResponse(BaseModel):
    upload_id: UUID
    status: str          # "pending" | "processing" | "completed" | "failed"
    result_url: str | None = None   # presigned URL to colmap_result.json
    error: str | None = None


def _colmap_result_key(user_id: str, upload_id: str) -> str:
    """Worker가 결과를 업로드하는 MinIO 키 (deterministic)."""
    return f"users/{user_id}/colmap/{upload_id}/colmap_result.json"


@router.get("/{upload_id}/colmap-result", response_model=ColmapResultResponse)
async def get_colmap_result(
    upload_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """COLMAP 전처리 결과 조회.

    완료 시 colmap_result.json presigned URL 반환.
    Worker가 결과를 업로드한 후에 URL이 채워진다.
    """
    upload_result = await db.execute(
        select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id)
    )
    upload = upload_result.scalar_one_or_none()
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    if upload.ply_target != PlyTarget.colmap:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="COLMAP 업로드가 아닙니다.")

    task_result = await db.execute(
        select(Task)
        .where(Task.upload_id == upload_id, Task.task_type == TaskType.colmap_preprocessing)
        .order_by(Task.created_at.desc())
        .limit(1)
    )
    task = task_result.scalar_one_or_none()

    if task is None:
        return ColmapResultResponse(upload_id=upload_id, status="pending")

    if task.status == TaskStatus.failed:
        return ColmapResultResponse(
            upload_id=upload_id,
            status="failed",
            error=task.error_message,
        )

    if task.status != TaskStatus.completed:
        return ColmapResultResponse(upload_id=upload_id, status=task.status.value)

    # 완료 — presigned URL 발급
    result_key = _colmap_result_key(str(user.id), str(upload_id))
    minio = get_minio_service()
    try:
        url = minio.get_presigned_download_url(result_key, expires=3600)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="COLMAP 결과 파일을 찾을 수 없습니다. 처리 중일 수 있습니다.",
        )

    return ColmapResultResponse(upload_id=upload_id, status="completed", result_url=url)


class TrainingBoundsSchema(BaseModel):
    minX: float; maxX: float
    minY: float; maxY: float
    minZ: float; maxZ: float


class StartTrainingRequest(BaseModel):
    bounds: TrainingBoundsSchema


class StartTrainingResponse(BaseModel):
    upload_id: UUID
    task_id: str
    status: str = "dispatched"


@router.post("/{upload_id}/start-training", response_model=StartTrainingResponse)
async def start_gs_training(
    upload_id: UUID,
    body: StartTrainingRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """COLMAP 결과 + bounding box → GS 학습 태스크 시작."""
    upload_result = await db.execute(
        select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id)
    )
    upload = upload_result.scalar_one_or_none()
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    if upload.ply_target != PlyTarget.colmap:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="COLMAP 업로드가 아닙니다.")

    # COLMAP 전처리가 완료됐는지 확인
    task_result = await db.execute(
        select(Task)
        .where(Task.upload_id == upload_id, Task.task_type == TaskType.colmap_preprocessing)
        .order_by(Task.created_at.desc())
        .limit(1)
    )
    colmap_task = task_result.scalar_one_or_none()
    if colmap_task is None or colmap_task.status != TaskStatus.completed:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="COLMAP 전처리가 완료되지 않았습니다.")

    celery_task_id = dispatch_gs_training_from_colmap_task(
        upload_id=str(upload_id),
        user_id=str(user.id),
        zip_minio_key=upload.ply_path,
        bounds=body.bounds.model_dump(),
    )

    new_task = Task(
        upload_id=upload_id,
        celery_task_id=celery_task_id,
        task_type=TaskType.training_3dgs,
        status=TaskStatus.pending,
    )
    db.add(new_task)
    await db.commit()

    return StartTrainingResponse(upload_id=upload_id, task_id=celery_task_id)
