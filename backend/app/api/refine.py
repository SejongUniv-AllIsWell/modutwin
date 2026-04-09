"""
가우시안 정제(refine) API.

단일 평면 기준으로 clip + align 처리 후 결과 presigned URL 반환.
"""

import os
import tempfile
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


class PlaneData(BaseModel):
    normal: list[float]   # [nx, ny, nz]
    d: float


class AlignRequest(BaseModel):
    upload_id: UUID
    source_key: str | None = None    # 이전 정제 결과의 MinIO key (없으면 원본 사용)
    plane: PlaneData
    thickness: float = 0.05


class AlignResponse(BaseModel):
    url: str             # presigned download URL
    source_key: str      # 다음 호출 시 사용할 MinIO key


@router.post("/align", response_model=AlignResponse)
async def align_to_plane(
    body: AlignRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    단일 평면 기준으로 가우시안을 정렬한다.

    1. source_key가 있으면 해당 파일, 없으면 upload의 원본 파일 사용
    2. clip (바깥 가우시안 삭제) + align (벽면 스냅/flatten/회전/SH/opacity)
    3. 결과를 MinIO에 저장하고 presigned URL 반환
    """
    import numpy as np
    from core.refine_module.flat_opaque import align_single_plane

    # 원본 업로드 조회
    result = await db.execute(
        select(Upload).where(Upload.id == body.upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    minio = get_minio_service()

    # 소스 파일 결정
    source_key = body.source_key or upload.minio_path
    if not minio.object_exists(source_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="소스 파일을 찾을 수 없습니다.")

    normal = np.array(body.plane.normal, dtype=np.float64)
    d = body.plane.d

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = os.path.join(tmpdir, "input.ply")
            output_path = os.path.join(tmpdir, "output.ply")

            # 다운로드
            minio.download_to_file(source_key, input_path)

            # 바깥 가우시안 전부 평면에 투영
            align_single_plane(input_path, normal, d, output_path)

            # 결과 업로드
            base_dir = os.path.dirname(upload.minio_path)
            result_key = f"{base_dir}/refined/{upload.id}_refined.ply"
            minio.upload_from_file(result_key, output_path)

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"정제 처리 실패: {str(e)}",
        )

    # presigned URL 반환
    url = minio.get_presigned_download_url(result_key, expires=3600)

    return AlignResponse(url=url, source_key=result_key)


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
