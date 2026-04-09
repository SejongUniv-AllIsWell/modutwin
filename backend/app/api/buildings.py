import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, field_validator
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID

from app.core.database import get_db
from app.core.security import get_current_user, get_current_user_optional
from app.models import User, Building, Floor, Module, SceneOutput

router = APIRouter(tags=["buildings"])

UNSAFE_PATH_PATTERN = re.compile(r"[/\\]|\.\.")


def _validate_name(v: str, field_name: str) -> str:
    if UNSAFE_PATH_PATTERN.search(v):
        raise ValueError(f"{field_name}에 허용되지 않는 문자가 포함되어 있습니다.")
    return v


# ── Schemas ──

class BuildingCreate(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_name(v, "name")


class BuildingResponse(BaseModel):
    id: UUID
    name: str
    created_at: datetime

    class Config:
        from_attributes = True


class FloorCreate(BaseModel):
    floor_number: int


class FloorResponse(BaseModel):
    id: UUID
    building_id: UUID
    floor_number: int
    created_at: datetime

    class Config:
        from_attributes = True


class ModuleCreate(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_name(v, "name")


class ModuleResponse(BaseModel):
    id: UUID
    floor_id: UUID
    name: str
    created_at: datetime

    class Config:
        from_attributes = True


# ── Building endpoints ──

@router.get("/buildings", response_model=list[BuildingResponse])
async def list_buildings(
    has_output: bool = Query(False),
    _: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Building).order_by(Building.name)
    if has_output:
        stmt = stmt.where(
            exists(
                select(SceneOutput.id)
                .join(Module, Module.id == SceneOutput.module_id)
                .join(Floor, Floor.id == Module.floor_id)
                .where(Floor.building_id == Building.id)
            )
        )
    result = await db.execute(stmt)
    return result.scalars().all()


@router.post("/buildings", response_model=BuildingResponse, status_code=status.HTTP_201_CREATED)
async def create_building(
    body: BuildingCreate,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 중복 이름 확인
    existing = await db.execute(select(Building).where(Building.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="이미 존재하는 건물 이름입니다.")

    building = Building(name=body.name)
    db.add(building)
    await db.commit()
    await db.refresh(building)
    return building


@router.get("/buildings/{building_id}", response_model=BuildingResponse)
async def get_building(
    building_id: UUID,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Building).where(Building.id == building_id))
    building = result.scalar_one_or_none()
    if not building:
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")
    return building


# ── Floor endpoints ──

@router.get("/buildings/{building_id}/floors", response_model=list[FloorResponse])
async def list_floors(
    building_id: UUID,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Floor)
        .where(Floor.building_id == building_id)
        .order_by(Floor.floor_number)
    )
    return result.scalars().all()


@router.post("/buildings/{building_id}/floors", response_model=FloorResponse, status_code=status.HTTP_201_CREATED)
async def create_floor(
    building_id: UUID,
    body: FloorCreate,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 건물 존재 확인
    bldg = await db.execute(select(Building).where(Building.id == building_id))
    if not bldg.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")

    # 중복 층 확인
    existing = await db.execute(
        select(Floor).where(Floor.building_id == building_id, Floor.floor_number == body.floor_number)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="이미 존재하는 층입니다.")

    floor = Floor(building_id=building_id, floor_number=body.floor_number)
    db.add(floor)
    await db.commit()
    await db.refresh(floor)
    return floor


@router.get("/floors/{floor_id}", response_model=FloorResponse)
async def get_floor(
    floor_id: UUID,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Floor).where(Floor.id == floor_id))
    floor = result.scalar_one_or_none()
    if not floor:
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")
    return floor


# ── Module endpoints ──

@router.get("/floors/{floor_id}/modules", response_model=list[ModuleResponse])
async def list_modules(
    floor_id: UUID,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Module)
        .where(Module.floor_id == floor_id)
        .order_by(Module.name)
    )
    return result.scalars().all()


@router.post("/floors/{floor_id}/modules", response_model=ModuleResponse, status_code=status.HTTP_201_CREATED)
async def create_module(
    floor_id: UUID,
    body: ModuleCreate,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 층 존재 확인
    floor = await db.execute(select(Floor).where(Floor.id == floor_id))
    if not floor.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")

    # 중복 모듈명 확인
    existing = await db.execute(
        select(Module).where(Module.floor_id == floor_id, Module.name == body.name)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="이미 존재하는 모듈 이름입니다.")

    module = Module(floor_id=floor_id, name=body.name)
    db.add(module)
    await db.commit()
    await db.refresh(module)
    return module


@router.get("/modules/{module_id}", response_model=ModuleResponse)
async def get_module(
    module_id: UUID,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Module).where(Module.id == module_id))
    module = result.scalar_one_or_none()
    if not module:
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")
    return module
