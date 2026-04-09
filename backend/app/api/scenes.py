import json
from uuid import UUID
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import (
    User, SceneOutput, Module, Floor, Task, Basemap,
    TaskType, TaskStatus,
)
from app.schemas.uploads import SceneResponse, SceneDownloadResponse
from app.services.minio_service import get_minio_service
from app.services.celery_service import dispatch_alignment_task

router = APIRouter(prefix="/scenes", tags=["scenes"])


@router.get("", response_model=list[SceneResponse])
async def list_scenes(
    building_id: Optional[UUID] = Query(None),
    floor_id: Optional[UUID] = Query(None),
    module_id: Optional[UUID] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """건물/층/모듈별 씬 목록 조회 (공개)"""
    query = (
        select(SceneOutput)
        .join(Module, SceneOutput.module_id == Module.id)
        .join(Floor, Module.floor_id == Floor.id)
        .where(SceneOutput.is_aligned == True)
    )

    if module_id:
        query = query.where(SceneOutput.module_id == module_id)
    elif floor_id:
        query = query.where(Module.floor_id == floor_id)
    elif building_id:
        query = query.where(Floor.building_id == building_id)

    query = query.order_by(SceneOutput.created_at.desc())

    result = await db.execute(query)
    return result.scalars().all()


@router.get("/{scene_id}", response_model=SceneResponse)
async def get_scene(
    scene_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """씬 상세 조회"""
    result = await db.execute(
        select(SceneOutput).where(SceneOutput.id == scene_id)
    )
    scene = result.scalar_one_or_none()

    if scene is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="씬을 찾을 수 없습니다.")

    return scene


@router.get("/{scene_id}/download", response_model=SceneDownloadResponse)
async def download_scene(
    scene_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """SOG 파일 presigned GET URL 반환"""
    result = await db.execute(
        select(SceneOutput).where(SceneOutput.id == scene_id)
    )
    scene = result.scalar_one_or_none()

    if scene is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="씬을 찾을 수 없습니다.")

    minio = get_minio_service()

    if not minio.object_exists(scene.sog_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SOG 파일을 찾을 수 없습니다.")

    expires = 3600
    url = minio.get_presigned_download_url(scene.sog_path, expires)

    return SceneDownloadResponse(url=url, expires_in=expires)


# ── Door Position ──

class DoorPositionRequest(BaseModel):
    module_door_indices: list[int]
    basemap_door_indices: Optional[list[int]] = None


@router.post("/{scene_id}/door-position")
async def set_door_position(
    scene_id: UUID,
    body: DoorPositionRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """문 위치를 저장하고 정합 태스크를 시작한다."""
    # 씬 조회
    result = await db.execute(
        select(SceneOutput).where(SceneOutput.id == scene_id)
    )
    scene = result.scalar_one_or_none()
    if scene is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="씬을 찾을 수 없습니다.")

    # 모듈 → 층 → 건물 계층 조회
    mod_result = await db.execute(select(Module).where(Module.id == scene.module_id))
    module = mod_result.scalar_one()
    floor_result = await db.execute(select(Floor).where(Floor.id == module.floor_id))
    floor = floor_result.scalar_one()

    # 활성 basemap 조회
    bm_result = await db.execute(
        select(Basemap).where(
            Basemap.floor_id == floor.id,
            Basemap.is_active == True,
        )
    )
    basemap = bm_result.scalar_one_or_none()
    if basemap is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이 층에 활성 basemap이 없습니다. 관리자에게 문의하세요.",
        )

    minio = get_minio_service()

    # door_position.json을 MinIO에 저장
    door_data = body.model_dump()
    door_json = json.dumps(door_data, ensure_ascii=False)

    import tempfile, os
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write(door_json)
        tmp_path = f.name

    base_path = os.path.dirname(scene.ply_path)
    door_key = f"{base_path}/door_position.json"
    try:
        minio.upload_from_file(door_key, tmp_path, content_type="application/json")
    finally:
        os.unlink(tmp_path)

    # Task + Upload 조회 (upload_id 확보)
    task_result = await db.execute(select(Task).where(Task.id == scene.task_id))
    parent_task = task_result.scalar_one()

    # 정합 태스크 발행
    celery_task_id = dispatch_alignment_task(
        upload_id=str(parent_task.upload_id),
        user_id=str(user.id),
        ply_key=scene.ply_path,
        door_position_key=door_key,
        basemap_key=basemap.minio_path,
        building_id=str(floor.building_id),
        floor_id=str(floor.id),
        module_id=str(module.id),
        module_name=module.name,
    )

    # Task 레코드 생성
    alignment_task = Task(
        upload_id=parent_task.upload_id,
        user_id=user.id,
        task_type=TaskType.door_alignment,
        celery_task_id=celery_task_id,
        status=TaskStatus.pending,
    )
    db.add(alignment_task)
    await db.commit()

    return {"message": "문 위치가 저장되었습니다. 정합 작업이 시작됩니다.", "task_id": str(alignment_task.id)}
