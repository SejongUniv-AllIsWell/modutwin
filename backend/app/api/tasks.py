import json
from uuid import UUID
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from datetime import datetime
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import redis.asyncio as aioredis

from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import get_current_user
from app.models import User, Task, TaskStatus

router = APIRouter(prefix="/tasks", tags=["tasks"])
settings = get_settings()


class TaskResponse(BaseModel):
    id: UUID
    upload_id: UUID
    task_type: str
    status: str
    progress: int
    error_message: Optional[str] = None
    created_at: datetime
    completed_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class TaskProgressResponse(BaseModel):
    task_id: UUID
    progress: int
    module: str
    status: str


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """내 태스크 목록 조회"""
    result = await db.execute(
        select(Task)
        .where(Task.user_id == user.id)
        .order_by(Task.created_at.desc())
    )
    return result.scalars().all()


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """태스크 상세 조회"""
    result = await db.execute(
        select(Task).where(Task.id == task_id, Task.user_id == user.id)
    )
    task = result.scalar_one_or_none()
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="태스크를 찾을 수 없습니다.")
    return task


@router.get("/{task_id}/progress", response_model=TaskProgressResponse)
async def get_task_progress(
    task_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """태스크 실시간 진행률 조회 (Redis)"""
    # DB에서 태스크 확인
    result = await db.execute(
        select(Task).where(Task.id == task_id, Task.user_id == user.id)
    )
    task = result.scalar_one_or_none()
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="태스크를 찾을 수 없습니다.")

    # Redis에서 실시간 진행률 조회
    redis_client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        data = await redis_client.get(f"task:progress:{task.celery_task_id}")
        if data:
            progress_data = json.loads(data)
            return TaskProgressResponse(
                task_id=task.id,
                progress=progress_data.get("progress", task.progress),
                module=progress_data.get("module", ""),
                status=task.status.value,
            )
    finally:
        await redis_client.aclose()

    return TaskProgressResponse(
        task_id=task.id,
        progress=task.progress,
        module="",
        status=task.status.value,
    )
