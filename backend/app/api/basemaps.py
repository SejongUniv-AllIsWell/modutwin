from uuid import UUID
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user, require_admin
from app.models import User, Basemap, BasemapStatus, Floor, Building
from app.services.minio_service import get_minio_service

router = APIRouter(prefix="/admin/basemaps", tags=["basemaps"])


class BasemapResponse(BaseModel):
    id: UUID
    floor_id: UUID
    version: int
    status: str
    is_active: bool
    created_at: datetime
    approved_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BasemapUploadRequest(BaseModel):
    floor_id: UUID


class BasemapUploadResponse(BaseModel):
    basemap_id: UUID
    presigned_url: str
    message: str


@router.get("", response_model=list[BasemapResponse])
async def list_basemaps(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """basemap 목록 조회"""
    result = await db.execute(
        select(Basemap).order_by(Basemap.floor_id, Basemap.version.desc())
    )
    return result.scalars().all()


@router.post("/upload", response_model=BasemapUploadResponse)
async def upload_basemap(
    body: BasemapUploadRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """basemap 후보 업로드 (일반 사용자도 가능)"""
    # 층 존재 확인
    floor_result = await db.execute(select(Floor).where(Floor.id == body.floor_id))
    floor = floor_result.scalar_one_or_none()
    if not floor:
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")

    # 현재 최신 버전 조회
    result = await db.execute(
        select(Basemap)
        .where(Basemap.floor_id == body.floor_id)
        .order_by(Basemap.version.desc())
        .limit(1)
    )
    latest = result.scalar_one_or_none()
    next_version = (latest.version + 1) if latest else 1

    minio_path = (
        f"buildings/{floor.building_id}/{floor.id}"
        f"/basemap/candidates/v{next_version}.ply"
    )

    basemap = Basemap(
        floor_id=body.floor_id,
        minio_path=minio_path,
        version=next_version,
        uploaded_by=user.id,
        status=BasemapStatus.pending,
    )
    db.add(basemap)
    await db.flush()

    minio = get_minio_service()
    presigned_url = minio.get_presigned_simple_upload_url(minio_path, expires=3600)

    await db.commit()

    return BasemapUploadResponse(
        basemap_id=basemap.id,
        presigned_url=presigned_url,
        message="presigned URL로 ply 파일을 업로드하세요.",
    )


@router.put("/{basemap_id}/approve")
async def approve_basemap(
    basemap_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """basemap 승인 (관리자)"""
    result = await db.execute(select(Basemap).where(Basemap.id == basemap_id))
    basemap = result.scalar_one_or_none()

    if basemap is None:
        raise HTTPException(status_code=404, detail="Basemap을 찾을 수 없습니다.")

    if basemap.status != BasemapStatus.pending:
        raise HTTPException(status_code=400, detail="대기 상태인 basemap만 승인할 수 있습니다.")

    basemap.status = BasemapStatus.approved
    basemap.approved_by = admin.id
    basemap.approved_at = datetime.now(timezone.utc)
    await db.commit()

    return {"message": "승인 완료", "basemap_id": str(basemap.id)}


@router.put("/{basemap_id}/reject")
async def reject_basemap(
    basemap_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """basemap 거부 (관리자)"""
    result = await db.execute(select(Basemap).where(Basemap.id == basemap_id))
    basemap = result.scalar_one_or_none()

    if basemap is None:
        raise HTTPException(status_code=404, detail="Basemap을 찾을 수 없습니다.")

    basemap.status = BasemapStatus.rejected
    basemap.approved_by = admin.id
    await db.commit()

    return {"message": "거부 완료", "basemap_id": str(basemap.id)}


@router.put("/{basemap_id}/activate")
async def activate_basemap(
    basemap_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """basemap 활성화 — 기존 모듈 재정렬 태스크 발행 (관리자)"""
    result = await db.execute(select(Basemap).where(Basemap.id == basemap_id))
    new_basemap = result.scalar_one_or_none()

    if new_basemap is None:
        raise HTTPException(status_code=404, detail="Basemap을 찾을 수 없습니다.")

    if new_basemap.status != BasemapStatus.approved:
        raise HTTPException(status_code=400, detail="승인된 basemap만 활성화할 수 있습니다.")

    # 층 정보 조회
    floor_result = await db.execute(select(Floor).where(Floor.id == new_basemap.floor_id))
    floor = floor_result.scalar_one()

    # 기존 활성 basemap 비활성화
    result = await db.execute(
        select(Basemap).where(
            Basemap.floor_id == new_basemap.floor_id,
            Basemap.is_active == True,
        )
    )
    old_basemap = result.scalar_one_or_none()
    if old_basemap:
        old_basemap.is_active = False
        old_basemap.status = BasemapStatus.superseded

    # 새 basemap 활성화
    new_basemap.is_active = True

    # 활성 basemap을 공용 경로에 복사 (basemap/basemap.ply)
    # TODO: MinIO copy_object 구현
    # active_key = f"buildings/{floor.building_id}/{floor.id}/basemap/basemap.ply"

    await db.commit()

    # TODO: basemap_realign 태스크 발행
    return {
        "message": "활성화 완료. 기존 모듈 재정렬이 필요합니다.",
        "basemap_id": str(new_basemap.id),
    }
