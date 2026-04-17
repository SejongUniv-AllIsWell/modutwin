"""
가우시안 정제(refine) API.

클라이언트에서 처리한 PLY를 올릴 수 있는 presigned URL 발급과
최종 정제 결과를 SceneOutput에 기록하는 엔드포인트를 제공.

실제 정제 연산(clip/flatten/align)은 전부 클라이언트에서 수행하므로
서버는 릴레이 역할만 한다.
"""

import os
import re
import time
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import User, Upload, Task, SceneOutput, TaskType, TaskStatus
from app.services.minio_service import get_minio_service

router = APIRouter(prefix="/refine", tags=["refine"])


class RefinedUploadUrlRequest(BaseModel):
    upload_id: UUID
    filename: str = "refined.ply"


class RefinedUploadUrlResponse(BaseModel):
    put_url: str
    get_url: str
    key: str


@router.post("/refined-upload-url", response_model=RefinedUploadUrlResponse)
async def refined_upload_url(
    body: RefinedUploadUrlRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """클라이언트가 정제한 PLY를 직접 업로드할 presigned PUT/GET URL 발급."""
    result = await db.execute(
        select(Upload).where(Upload.id == body.upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    # path traversal 방지
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", body.filename) or "refined.ply"
    base_dir = os.path.dirname(upload.minio_path)
    key = f"{base_dir}/refined/{int(time.time() * 1000)}_{safe_name}"

    minio = get_minio_service()
    return RefinedUploadUrlResponse(
        put_url=minio.get_presigned_simple_upload_url(key, expires=3600),
        get_url=minio.get_presigned_download_url(key, expires=3600),
        key=key,
    )


class SaveRequest(BaseModel):
    upload_id: UUID
    source_key: str      # 최종 정제된 PLY의 MinIO key


class SaveResponse(BaseModel):
    scene_id: UUID
    message: str


@router.post("/save", response_model=SaveResponse)
async def save_refined(
    body: SaveRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    정제 결과를 확정하여 SceneOutput으로 저장한다.
    이후 문 정합 등에서 이 씬을 사용할 수 있다.
    """
    from datetime import datetime, timezone

    # 업로드 조회
    result = await db.execute(
        select(Upload).where(Upload.id == body.upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    # 정제 파일 존재 확인
    minio = get_minio_service()
    if not minio.object_exists(body.source_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="정제 파일을 찾을 수 없습니다.")

    # Task 생성 (정제 완료 상태)
    task = Task(
        upload_id=upload.id,
        user_id=user.id,
        task_type=TaskType.door_alignment,
        status=TaskStatus.completed,
        progress=100,
        completed_at=datetime.now(timezone.utc),
    )
    db.add(task)
    await db.flush()

    # SceneOutput 생성
    scene = SceneOutput(
        task_id=task.id,
        user_id=user.id,
        module_id=upload.module_id,
        ply_path=body.source_key,
        sog_path=body.source_key,   # PLY도 뷰어에서 로드 가능
        is_aligned=False,
    )
    db.add(scene)
    await db.commit()

    return SaveResponse(scene_id=scene.id, message="정제 결과가 저장되었습니다.")
