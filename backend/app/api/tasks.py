from uuid import UUID
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from datetime import datetime
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import User, Task
from app.services.task_progress_service import read_task_progress

router = APIRouter(prefix="/tasks", tags=["tasks"])


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
    progress_data = await read_task_progress(task.celery_task_id)
    if progress_data:
        return TaskProgressResponse(
            task_id=task.id,
            progress=progress_data.get("progress", task.progress),
            module=progress_data.get("module", ""),
            status=task.status.value,
        )

    return TaskProgressResponse(
        task_id=task.id,
        progress=task.progress,
        module="",
        status=task.status.value,
    )
