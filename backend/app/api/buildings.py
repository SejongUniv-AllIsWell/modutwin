import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, field_validator
from sqlalchemy import exists, select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID

from app.core.database import get_db
from app.core.security import get_current_user, get_current_user_optional, require_admin
from app.models import (
    User, UserRole, Building, Floor, Module, SceneOutput,
    Basemap, BasemapStatus, Task, Upload,
)
from app.services.minio_service import get_minio_service

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
    is_visible: bool
    created_at: datetime

    class Config:
        from_attributes = True


class FloorCreate(BaseModel):
    floor_number: int


class FloorResponse(BaseModel):
    id: UUID
    building_id: UUID
    floor_number: int
    is_visible: bool
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
    user_id: UUID
    name: str
    alignment_transform: dict | None = None
    is_visible: bool
    created_at: datetime

    class Config:
        from_attributes = True


class VisibilityRequest(BaseModel):
    is_visible: bool


class AlignmentTransformRequest(BaseModel):
    """정합 결과 transform — splat entity의 local position/rotation/scale 등."""
    transform: dict


# ── Building endpoints ──

@router.get("/buildings", response_model=list[BuildingResponse])
async def list_buildings(
    has_output: bool = Query(False),
    include_hidden: bool = Query(False),
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    show_hidden = include_hidden and user is not None and user.role == UserRole.admin
    stmt = select(Building).order_by(Building.name)
    if not show_hidden:
        stmt = stmt.where(Building.is_visible == True)
    if has_output:
        # 표시 중인 floor/module 에 SceneOutput 이 있을 때만 노출 — 모든 모듈이 숨김이면 건물도 사라짐
        stmt = stmt.where(
            exists(
                select(SceneOutput.id)
                .join(Module, Module.id == SceneOutput.module_id)
                .join(Floor, Floor.id == Module.floor_id)
                .where(
                    Floor.building_id == Building.id,
                    Floor.is_visible == True,
                    Module.is_visible == True,
                )
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


# ── Explore: cross-user 다층 평면도 트리 ──
#
# /explore 페이지에서 건물 클릭 → 해당 건물의 모든 층의 활성 basemap 과
# 그 층에 매달린 모든 사용자의 visible module 들을 한 번에 반환.
# 본인 module 만 보이는 list_modules 와 달리 의도적으로 user 무관 노출 (read-only).

class ExploreModuleEntry(BaseModel):
    id: UUID
    name: str
    user_id: UUID
    uploader_name: str | None = None
    alignment_transform: dict | None = None
    latest_ply_url: str | None = None  # 가장 최근 SceneOutput 의 presigned URL (없으면 null)


class ExploreBasemapEntry(BaseModel):
    id: UUID
    version: int
    url: str
    filename: str


class ExploreFloorEntry(BaseModel):
    id: UUID
    floor_number: int
    basemap: ExploreBasemapEntry | None = None
    modules: list[ExploreModuleEntry]


class ExploreBuildingResponse(BaseModel):
    id: UUID
    name: str
    floors: list[ExploreFloorEntry]


@router.get("/buildings/{building_id}/explore", response_model=ExploreBuildingResponse)
async def explore_building(
    building_id: UUID,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """건물의 모든 층 → 활성 basemap + cross-user visible module 트리.

    visibility 가 false 인 floor/module 은 제외. basemap 이 없는 층은 basemap=null.
    각 module 의 latest_ply_url 은 가장 최근 SceneOutput.ply_path 의 presigned URL.
    """
    bldg_result = await db.execute(
        select(Building).where(Building.id == building_id, Building.is_visible == True)
    )
    building = bldg_result.scalar_one_or_none()
    if building is None:
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")

    floors_result = await db.execute(
        select(Floor)
        .where(Floor.building_id == building_id, Floor.is_visible == True)
        .order_by(Floor.floor_number)
    )
    floors = floors_result.scalars().all()
    if not floors:
        return ExploreBuildingResponse(id=building.id, name=building.name, floors=[])

    floor_ids = [f.id for f in floors]

    # 각 층의 활성 basemap 한 건씩
    bm_result = await db.execute(
        select(Basemap).where(
            Basemap.floor_id.in_(floor_ids),
            Basemap.is_active == True,
        )
    )
    bm_by_floor: dict[UUID, Basemap] = {bm.floor_id: bm for bm in bm_result.scalars().all()}

    # 각 층의 visible module 들 (cross-user) + 업로더 이름
    mod_result = await db.execute(
        select(Module, User.name.label("uploader_name"))
        .join(User, Module.user_id == User.id)
        .where(Module.floor_id.in_(floor_ids), Module.is_visible == True)
        .order_by(Module.floor_id, Module.name)
    )
    mod_rows = mod_result.all()
    modules_by_floor: dict[UUID, list[tuple[Module, str | None]]] = {}
    module_ids: list[UUID] = []
    for mod, uploader_name in mod_rows:
        modules_by_floor.setdefault(mod.floor_id, []).append((mod, uploader_name))
        module_ids.append(mod.id)

    # 각 module 의 가장 최근 SceneOutput
    latest_scene_by_module: dict[UUID, SceneOutput] = {}
    if module_ids:
        scene_result = await db.execute(
            select(SceneOutput)
            .where(SceneOutput.module_id.in_(module_ids))
            .order_by(SceneOutput.module_id, SceneOutput.created_at.desc())
        )
        for scene in scene_result.scalars().all():
            # 같은 module_id 의 첫 row (= 최신) 만 채택
            latest_scene_by_module.setdefault(scene.module_id, scene)

    minio = get_minio_service()

    floor_entries: list[ExploreFloorEntry] = []
    for floor in floors:
        bm = bm_by_floor.get(floor.id)
        bm_entry: ExploreBasemapEntry | None = None
        if bm is not None:
            bm_entry = ExploreBasemapEntry(
                id=bm.id,
                version=bm.version,
                url=minio.get_presigned_download_url(bm.minio_path),
                filename=bm.minio_path.rsplit("/", 1)[-1],
            )

        module_entries: list[ExploreModuleEntry] = []
        for mod, uploader_name in modules_by_floor.get(floor.id, []):
            scene = latest_scene_by_module.get(mod.id)
            module_entries.append(ExploreModuleEntry(
                id=mod.id,
                name=mod.name,
                user_id=mod.user_id,
                uploader_name=uploader_name,
                alignment_transform=mod.alignment_transform,
                latest_ply_url=(
                    minio.get_presigned_download_url(scene.ply_path) if scene else None
                ),
            ))

        floor_entries.append(ExploreFloorEntry(
            id=floor.id,
            floor_number=floor.floor_number,
            basemap=bm_entry,
            modules=module_entries,
        ))

    return ExploreBuildingResponse(
        id=building.id,
        name=building.name,
        floors=floor_entries,
    )


# ── Floor endpoints ──

@router.get("/buildings/{building_id}/floors", response_model=list[FloorResponse])
async def list_floors(
    building_id: UUID,
    include_hidden: bool = Query(False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    show_hidden = include_hidden and user.role == UserRole.admin
    stmt = select(Floor).where(Floor.building_id == building_id)
    if not show_hidden:
        stmt = stmt.where(Floor.is_visible == True)
    stmt = stmt.order_by(Floor.floor_number)
    result = await db.execute(stmt)
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
    include_hidden: bool = Query(False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """본인이 만든 module 만 반환. admin 은 전체.

    Cross-user 트리(explore 페이지용)는 GET /buildings/{id}/explore 를 사용한다.
    """
    is_admin = user.role == UserRole.admin
    show_hidden = include_hidden and is_admin
    stmt = select(Module).where(Module.floor_id == floor_id)
    if not is_admin:
        stmt = stmt.where(Module.user_id == user.id)
    if not show_hidden:
        stmt = stmt.where(Module.is_visible == True)
    stmt = stmt.order_by(Module.name)
    result = await db.execute(stmt)
    return result.scalars().all()


@router.post("/floors/{floor_id}/modules", response_model=ModuleResponse, status_code=status.HTTP_201_CREATED)
async def create_module(
    floor_id: UUID,
    body: ModuleCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 층 존재 확인
    floor = await db.execute(select(Floor).where(Floor.id == floor_id))
    if not floor.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")

    # 중복 모듈명 확인 — 본인이 만든 module 안에서만
    existing = await db.execute(
        select(Module).where(
            Module.floor_id == floor_id,
            Module.user_id == user.id,
            Module.name == body.name,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="이미 존재하는 모듈 이름입니다.")

    module = Module(floor_id=floor_id, user_id=user.id, name=body.name)
    db.add(module)
    await db.commit()
    await db.refresh(module)
    return module


@router.get("/modules/{module_id}", response_model=ModuleResponse)
async def get_module(
    module_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Module).where(Module.id == module_id))
    module = result.scalar_one_or_none()
    if not module:
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")
    if user.role != UserRole.admin and module.user_id != user.id:
        # 남의 module 은 노출하지 않음
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")
    return module


@router.put("/modules/{module_id}/alignment-transform", response_model=ModuleResponse)
async def update_alignment_transform(
    module_id: UUID,
    body: AlignmentTransformRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """정합 결과 transform 저장.

    transform은 자유 형식 JSON (예: {position: [x,y,z], rotation: [x,y,z,w], scale: [sx,sy,sz]}).
    """
    result = await db.execute(select(Module).where(Module.id == module_id))
    module = result.scalar_one_or_none()
    if not module:
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")
    if user.role != UserRole.admin and module.user_id != user.id:
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")

    module.alignment_transform = body.transform
    await db.commit()
    await db.refresh(module)
    return module


# ── Admin: visibility toggle ──
#
# 양방향 cascade:
#   Hide
#     - 건물 hide → 하위 floor/module 모두 hide
#     - 층 hide   → 하위 module 모두 hide
#     - 모듈 hide → 본인만
#   Show
#     - 건물 show → 하위 floor/module 모두 show
#     - 층 show   → 부모 building + 하위 module 모두 show
#     - 모듈 show → 부모 floor + 부모 building 모두 show
#
# Show cascade 가 양방향인 이유: /explore 의 has_output 필터는
# 건물·층·모듈 셋이 모두 visible 이어야 노출되므로, 한 단계만 풀면
# UI 상 "표시" 가 실제로는 효과가 없어 보인다.


@router.put("/admin/buildings/{building_id}/visibility", response_model=BuildingResponse)
async def set_building_visibility(
    building_id: UUID,
    body: VisibilityRequest,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Building).where(Building.id == building_id))
    building = result.scalar_one_or_none()
    if not building:
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")

    building.is_visible = body.is_visible

    # cascade 하위: hide → 모두 숨김 / show → 모두 표시
    await db.execute(
        sa_update(Floor)
        .where(Floor.building_id == building_id)
        .values(is_visible=body.is_visible)
    )
    await db.execute(
        sa_update(Module)
        .where(
            Module.floor_id.in_(
                select(Floor.id).where(Floor.building_id == building_id)
            )
        )
        .values(is_visible=body.is_visible)
    )

    await db.commit()
    await db.refresh(building)
    return building


@router.put("/admin/floors/{floor_id}/visibility", response_model=FloorResponse)
async def set_floor_visibility(
    floor_id: UUID,
    body: VisibilityRequest,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Floor).where(Floor.id == floor_id))
    floor = result.scalar_one_or_none()
    if not floor:
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")

    floor.is_visible = body.is_visible

    # cascade 하위 module
    await db.execute(
        sa_update(Module)
        .where(Module.floor_id == floor_id)
        .values(is_visible=body.is_visible)
    )

    # show 시 부모 building 도 표시
    if body.is_visible:
        await db.execute(
            sa_update(Building)
            .where(Building.id == floor.building_id)
            .values(is_visible=True)
        )

    await db.commit()
    await db.refresh(floor)
    return floor


@router.put("/admin/modules/{module_id}/visibility", response_model=ModuleResponse)
async def set_module_visibility(
    module_id: UUID,
    body: VisibilityRequest,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Module).where(Module.id == module_id))
    module = result.scalar_one_or_none()
    if not module:
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")

    module.is_visible = body.is_visible

    # show 시 부모 floor + building 까지 표시 — /explore 즉시 노출 보장
    if body.is_visible:
        floor_result = await db.execute(select(Floor).where(Floor.id == module.floor_id))
        floor = floor_result.scalar_one_or_none()
        if floor:
            await db.execute(
                sa_update(Floor).where(Floor.id == floor.id).values(is_visible=True)
            )
            await db.execute(
                sa_update(Building)
                .where(Building.id == floor.building_id)
                .values(is_visible=True)
            )

    await db.commit()
    await db.refresh(module)
    return module
