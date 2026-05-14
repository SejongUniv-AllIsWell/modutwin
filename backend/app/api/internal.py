"""워커 → 백엔드 내부 콜백.

워커가 파이프라인 단계 완료 시 이 엔드포인트를 호출해 DB 상태를 갱신한다.
공유 시크릿 (X-Internal-Token) 으로 보호한다.
"""
from datetime import datetime, timezone
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.models import Upload, UploadStatus, Task, TaskStatus

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

    if body.status == "failed":
        upload.status = UploadStatus.failed
    elif body.stage == "gsplat":
        # 최종 단계: 업로드 완료 처리 + 결과 PLY 경로 저장
        upload.status = UploadStatus.completed
        if body.ply_key:
            upload.gsplat_ply_path = body.ply_key
    else:
        # COLMAP 단계만 끝났으면 아직 GS 학습 진행 중이라 processing 유지
        upload.status = UploadStatus.processing

    # 동일 celery_task_id 의 Task row 가 있으면 함께 갱신
    if body.celery_task_id:
        task_result = await db.execute(
            select(Task).where(Task.celery_task_id == body.celery_task_id)
        )
        task = task_result.scalar_one_or_none()
        if task is not None:
            if body.status == "failed":
                task.status = TaskStatus.failed
                task.error_message = body.error_message
            else:
                task.status = TaskStatus.completed
                task.progress = 100
                task.completed_at = now

    await db.commit()
    return {
        "ok": True,
        "upload_id": str(upload_id),
        "stage": body.stage,
        "status": body.status,
    }
