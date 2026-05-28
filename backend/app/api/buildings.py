import os
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, field_validator
from sqlalchemy import and_, delete as sa_delete, exists, func, or_, select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID

from app.core.database import get_db
from app.core.security import get_current_user, get_current_user_optional, require_admin
from app.models import (
    User, UserRole, Building, Floor, Module, SceneOutput,
    Basemap, BasemapStatus, Notification, Task, Upload,
)
from app.services.minio_service import get_minio_service
from app.services.metadata_options import (
    parse_module_name_input,
    validate_floor_number as validate_floor_number_value,
)
from app.services.storage_access import (
    add_storage_key,
    delete_storage_best_effort,
    safe_object_exists,
    safe_presigned_download_url,
)
from app.services.storage_paths import module_base_path

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
    kakao_place_id: str | None = None
    address_name: str | None = None
    road_address_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    is_confirmed: bool
    is_visible: bool
    created_at: datetime

    class Config:
        from_attributes = True


class BuildingListItem(BuildingResponse):
    """리스트 엔드포인트 응답. /buildings 의 결과를 클라이언트가 다시 N+1 fetch 해서
    floor_count 를 채우던 패턴을 제거하기 위해 같이 묶어 내려준다."""

    floor_count: int = 0


class FloorCreate(BaseModel):
    floor_number: int

    @field_validator("floor_number")
    @classmethod
    def validate_floor_number(cls, v: int) -> int:
        return validate_floor_number_value(v)


class FloorResponse(BaseModel):
    id: UUID
    building_id: UUID
    floor_number: int
    is_confirmed: bool
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
    is_confirmed: bool
    is_visible: bool
    created_at: datetime

    class Config:
        from_attributes = True


class VisibilityRequest(BaseModel):
    is_visible: bool


class AlignmentTransformRequest(BaseModel):
    """정합 결과 transform — splat entity의 local position/rotation/scale 등."""
    transform: dict


class MetadataModuleOption(BaseModel):
    id: UUID
    name: str


class MetadataFloorOption(BaseModel):
    id: UUID
    building_id: UUID
    floor_number: int
    modules: list[MetadataModuleOption]


class BuildingMetadataOptionsResponse(BaseModel):
    id: UUID
    name: str
    floors: list[MetadataFloorOption]


class FloorOverviewManifestEntry(BaseModel):
    floor_id: UUID
    floor_number: int
    overview_dirty: bool
    overview_version: datetime | None
    topdown_url: str | None
    meta_url: str | None
    module_count: int
    has_active_basemap: bool
    has_pending_basemap: bool = False


class FloorOverviewManifestResponse(BaseModel):
    building_id: UUID
    building_name: str
    building_is_confirmed: bool
    generated_at: datetime
    floors: list[FloorOverviewManifestEntry]


class BuildingFromKakaoRequest(BaseModel):
    place_id: str | None = None
    name: str
    address_name: str | None = None
    road_address_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _validate_name(v, "name")


class BuildingLookupResponse(BaseModel):
    building: BuildingResponse | None = None


class EnsureRegistrationContextRequest(BaseModel):
    building_id: UUID | None = None
    floor_id: UUID | None = None
    building_name: str | None = None
    floor_number: int | None = None
    module_name: str | None = None
    kakao_place_id: str | None = None
    address_name: str | None = None
    road_address_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None

    @field_validator("building_name")
    @classmethod
    def validate_building_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _validate_name(v, "building_name")

    @field_validator("module_name")
    @classmethod
    def validate_module_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _validate_name(v, "module_name")

    @field_validator("floor_number")
    @classmethod
    def validate_floor_number(cls, v: int | None) -> int | None:
        if v is None:
            return None
        return validate_floor_number_value(v)


class EnsureRegistrationContextResponse(BaseModel):
    building_id: UUID
    building_name: str
    floor_id: UUID
    floor_number: int
    module_id: UUID | None = None
    module_name: str | None = None


class DetailBasemapEntry(BaseModel):
    id: UUID
    version: int
    source_upload_id: UUID | None = None
    url: str | None
    filename: str


class DetailModuleEntry(BaseModel):
    id: UUID
    name: str
    user_id: UUID
    uploader_name: str | None
    alignment_transform: dict | None
    is_visible: bool
    version: datetime | None
    url: str | None
    source_upload_id: UUID | None = None


class FloorDetailManifestResponse(BaseModel):
    building_id: UUID
    building_name: str
    floor_id: UUID
    floor_number: int
    basemap: DetailBasemapEntry | None
    # 활성 basemap 이 없을 때 pending basemap (관리자 승인 대기) 존재 여부.
    # 프론트가 빈 뷰어 대신 "승인 대기중" 안내를 띄울 때 사용.
    basemap_pending_approval: bool = False
    modules: list[DetailModuleEntry]


class RegenerateOverviewResponse(BaseModel):
    floor_id: UUID
    overview_dirty: bool
    message: str


class AdminDeleteResponse(BaseModel):
    deleted_scope: str
    deleted_id: UUID
    deleted_files: int
    counts: dict[str, int]


def _pick_scene_output_path(minio, scene: SceneOutput | None) -> str | None:
    if scene is None:
        return None
    if scene.sog_path and safe_object_exists(minio, scene.sog_path):
        return scene.sog_path
    if safe_object_exists(minio, scene.ply_path):
        return scene.ply_path
    return None


async def _collect_delete_scope(
    db: AsyncSession,
    *,
    building_id: UUID | None = None,
    floor_id: UUID | None = None,
    module_id: UUID | None = None,
) -> tuple[dict[str, int], set[str], set[str], list[UUID], list[UUID], list[UUID], list[UUID], list[UUID]]:
    floor_ids: list[UUID] = []
    module_ids: list[UUID] = []
    upload_ids: list[UUID] = []
    task_ids: list[UUID] = []
    basemap_ids: list[UUID] = []
    prefixes: set[str] = set()
    keys: set[str] = set()

    if building_id is not None:
        floor_result = await db.execute(select(Floor).where(Floor.building_id == building_id))
        floors = floor_result.scalars().all()
        floor_ids = [floor.id for floor in floors]
        prefixes.add(f"buildings/{building_id}")
    elif floor_id is not None:
        floor_result = await db.execute(select(Floor).where(Floor.id == floor_id))
        floor = floor_result.scalar_one_or_none()
        if floor is not None:
            floor_ids = [floor.id]
            prefixes.add(f"buildings/{floor.building_id}/{floor.id}")
    elif module_id is not None:
        module_result = await db.execute(
            select(Module, Floor).join(Floor, Module.floor_id == Floor.id).where(Module.id == module_id)
        )
        row = module_result.one_or_none()
        if row is not None:
            module, floor = row
            module_ids = [module.id]
            prefixes.add(module_base_path(str(floor.building_id), str(floor.id), str(module.id), module.name))

    if floor_ids:
        module_result = await db.execute(select(Module.id).where(Module.floor_id.in_(floor_ids)))
        module_ids = [mid for (mid,) in module_result.all()]

        overview_result = await db.execute(
            select(Floor.overview_image_path, Floor.overview_meta_path).where(Floor.id.in_(floor_ids))
        )
        for overview_image_path, overview_meta_path in overview_result.all():
            add_storage_key(keys, overview_image_path)
            add_storage_key(keys, overview_meta_path)

    if module_ids:
        upload_result = await db.execute(
            select(Upload.id, Upload.minio_path, Upload.refined_ply_path, Upload.door_corners_json_path)
            .where(Upload.module_id.in_(module_ids))
        )
        for upload_id, minio_path, refined_ply_path, door_corners_json_path in upload_result.all():
            upload_ids.append(upload_id)
            add_storage_key(keys, minio_path)
            add_storage_key(keys, refined_ply_path)
            add_storage_key(keys, door_corners_json_path)

        scene_result = await db.execute(
            select(SceneOutput.ply_path, SceneOutput.sog_path, SceneOutput.metadata_path)
            .where(SceneOutput.module_id.in_(module_ids))
        )
        for ply_path, sog_path, metadata_path in scene_result.all():
            add_storage_key(keys, ply_path)
            add_storage_key(keys, sog_path)
            add_storage_key(keys, metadata_path)

    if upload_ids:
        task_result = await db.execute(select(Task.id).where(Task.upload_id.in_(upload_ids)))
        task_ids = [tid for (tid,) in task_result.all()]

    basemap_conditions = []
    if floor_ids:
        basemap_conditions.append(Basemap.floor_id.in_(floor_ids))
    if upload_ids:
        basemap_conditions.append(Basemap.source_upload_id.in_(upload_ids))
    if basemap_conditions:
        basemap_result = await db.execute(
            select(Basemap.id, Basemap.minio_path).where(or_(*basemap_conditions))
        )
        for bid, minio_path in basemap_result.all():
            basemap_ids.append(bid)
            add_storage_key(keys, minio_path)

    scene_count = 0
    if module_ids:
        scene_count = int(
            (await db.execute(
                select(func.count()).select_from(SceneOutput).where(SceneOutput.module_id.in_(module_ids))
            )).scalar_one()
        )

    counts = {
        "buildings": 1 if building_id is not None else 0,
        "floors": 1 if floor_id is not None else len(set(floor_ids)),
        "modules": 1 if module_id is not None else len(set(module_ids)),
        "uploads": len(set(upload_ids)),
        "tasks": len(set(task_ids)),
        "scene_outputs": scene_count,
        "basemaps": len(set(basemap_ids)),
    }
    return counts, prefixes, keys, floor_ids, module_ids, upload_ids, task_ids, basemap_ids


async def _delete_hierarchy_scope(
    db: AsyncSession,
    *,
    scope: str,
    target_id: UUID,
    building_id: UUID | None = None,
    floor_id: UUID | None = None,
    module_id: UUID | None = None,
) -> AdminDeleteResponse:
    counts, prefixes, keys, floor_ids, module_ids, upload_ids, task_ids, basemap_ids = await _collect_delete_scope(
        db,
        building_id=building_id,
        floor_id=floor_id,
        module_id=module_id,
    )

    if task_ids:
        await db.execute(
            sa_update(Notification)
            .where(Notification.related_task_id.in_(task_ids))
            .values(related_task_id=None)
        )
    if basemap_ids:
        await db.execute(sa_delete(Basemap).where(Basemap.id.in_(basemap_ids)))
    if module_ids:
        await db.execute(sa_delete(SceneOutput).where(SceneOutput.module_id.in_(module_ids)))
    if task_ids:
        await db.execute(sa_delete(Task).where(Task.id.in_(task_ids)))
    if upload_ids:
        await db.execute(sa_delete(Upload).where(Upload.id.in_(upload_ids)))
    if module_id is not None:
        await db.execute(sa_delete(Module).where(Module.id == module_id))
    elif module_ids:
        await db.execute(sa_delete(Module).where(Module.id.in_(module_ids)))
    if floor_id is not None:
        await db.execute(sa_delete(Floor).where(Floor.id == floor_id))
    elif building_id is not None and floor_ids:
        await db.execute(sa_delete(Floor).where(Floor.id.in_(floor_ids)))
    if building_id is not None:
        await db.execute(sa_delete(Building).where(Building.id == building_id))

    await db.commit()
    deleted_files = delete_storage_best_effort(
        get_minio_service(),
        prefixes,
        keys,
        sort_items=True,
        suppress_errors=False,
    )

    return AdminDeleteResponse(
        deleted_scope=scope,
        deleted_id=target_id,
        deleted_files=deleted_files,
        counts=counts,
    )


# ── Building endpoints ──

@router.get("/buildings", response_model=list[BuildingListItem])
async def list_buildings(
    has_output: bool = Query(False),
    include_hidden: bool = Query(False),
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    show_hidden = include_hidden and user is not None and user.role == UserRole.admin
    # floor_count 는 visible floor 만 집계 — admin 으로 hidden 까지 보더라도
    # explore 와 동일한 의미를 유지한다.
    floor_count_subq = (
        select(Floor.building_id, func.count(Floor.id).label("floor_count"))
        .where(Floor.is_visible == True)
        .group_by(Floor.building_id)
        .subquery()
    )
    stmt = (
        select(Building, func.coalesce(floor_count_subq.c.floor_count, 0))
        .outerjoin(floor_count_subq, floor_count_subq.c.building_id == Building.id)
        .order_by(Building.name)
    )
    if not show_hidden:
        stmt = stmt.where(Building.is_visible == True)
    if has_output:
        # /explore 노출 조건:
        #   1) 관리자가 표시관리에서 직접 추가한 건물 (is_confirmed=True, 자동 확정 경로)
        #   2) 표시 중인 floor/module 에 SceneOutput 이 등록된 건물
        # 둘 중 하나라도 만족하면 지도 마커/좌측 목록에 노출한다.
        stmt = stmt.where(
            or_(
                Building.is_confirmed == True,
                exists(
                    select(SceneOutput.id)
                    .join(Module, Module.id == SceneOutput.module_id)
                    .join(Floor, Floor.id == Module.floor_id)
                    .where(
                        Floor.building_id == Building.id,
                        Floor.is_visible == True,
                        Module.is_visible == True,
                        Module.name != "__basemap__",
                    )
                ),
            )
        )
    result = await db.execute(stmt)
    return [
        BuildingListItem(
            **BuildingResponse.model_validate(building).model_dump(),
            floor_count=int(floor_count),
        )
        for building, floor_count in result.all()
    ]


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


@router.get("/buildings/lookup", response_model=BuildingLookupResponse)
async def lookup_building(
    kakao_place_id: str | None = Query(None),
    name: str | None = Query(None),
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    if not kakao_place_id and not name:
        raise HTTPException(status_code=400, detail="kakao_place_id 또는 name 이 필요합니다.")
    if name:
        _validate_name(name, "name")

    building: Building | None = None
    if kakao_place_id:
        place_stmt = select(Building).where(Building.kakao_place_id == kakao_place_id)
        if user is None or user.role != UserRole.admin:
            place_stmt = place_stmt.where(Building.is_visible == True)
        place_result = await db.execute(place_stmt)
        building = place_result.scalar_one_or_none()
    if building is None and name:
        name_stmt = select(Building).where(Building.name == name)
        if user is None or user.role != UserRole.admin:
            name_stmt = name_stmt.where(Building.is_visible == True)
        name_result = await db.execute(name_stmt)
        building = name_result.scalar_one_or_none()

    if building is None:
        return BuildingLookupResponse(building=None)
    return BuildingLookupResponse(building=BuildingResponse.model_validate(building))


@router.post("/buildings/ensure-registration-context", response_model=EnsureRegistrationContextResponse)
async def ensure_registration_context(
    body: EnsureRegistrationContextRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.floor_id is None and body.floor_number is None:
        raise HTTPException(status_code=400, detail="floor_id 또는 floor_number 가 필요합니다.")

    building: Building | None = None
    floor: Floor | None = None

    if body.floor_id is not None:
        floor_result = await db.execute(select(Floor).where(Floor.id == body.floor_id))
        floor = floor_result.scalar_one_or_none()
        if floor is None:
            raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")

        building_result = await db.execute(select(Building).where(Building.id == floor.building_id))
        building = building_result.scalar_one_or_none()
        if building is None:
            raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")

        if body.floor_number is not None and floor.floor_number != body.floor_number:
            raise HTTPException(status_code=400, detail="floor_id 와 floor_number 가 일치하지 않습니다.")
        if body.building_id is not None and building.id != body.building_id:
            raise HTTPException(status_code=400, detail="floor_id 와 building_id 가 일치하지 않습니다.")

    if building is None and body.building_id is not None:
        building_result = await db.execute(select(Building).where(Building.id == body.building_id))
        building = building_result.scalar_one_or_none()
        if building is None:
            raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")

    if building is None and body.kakao_place_id:
        place_result = await db.execute(select(Building).where(Building.kakao_place_id == body.kakao_place_id))
        building = place_result.scalar_one_or_none()

    if building is None and body.building_name:
        name_result = await db.execute(select(Building).where(Building.name == body.building_name))
        building = name_result.scalar_one_or_none()

    if building is None:
        if not body.building_name:
            raise HTTPException(status_code=400, detail="building_name 이 필요합니다.")
        building = Building(
            name=body.building_name,
            kakao_place_id=body.kakao_place_id,
            address_name=body.address_name,
            road_address_name=body.road_address_name,
            latitude=body.latitude,
            longitude=body.longitude,
        )
        db.add(building)
        await db.flush()
    else:
        if body.kakao_place_id and not building.kakao_place_id:
            building.kakao_place_id = body.kakao_place_id
        if body.address_name and not building.address_name:
            building.address_name = body.address_name
        if body.road_address_name and not building.road_address_name:
            building.road_address_name = body.road_address_name
        if body.latitude is not None and building.latitude is None:
            building.latitude = body.latitude
        if body.longitude is not None and building.longitude is None:
            building.longitude = body.longitude

    if floor is None:
        if body.floor_number is None:
            raise HTTPException(status_code=400, detail="floor_number 가 필요합니다.")
        floor_result = await db.execute(
            select(Floor).where(
                Floor.building_id == building.id,
                Floor.floor_number == body.floor_number,
            )
        )
        floor = floor_result.scalar_one_or_none()
        if floor is None:
            if user.role != UserRole.admin and building.is_confirmed:
                raise HTTPException(status_code=400, detail="확정된 건물에는 층을 추가할 수 없습니다.")
            floor = Floor(building_id=building.id, floor_number=body.floor_number)
            db.add(floor)
            await db.flush()

    module: Module | None = None
    module_name = body.module_name.strip() if body.module_name else None
    if module_name:
        module_result = await db.execute(
            select(Module).where(
                Module.floor_id == floor.id,
                Module.user_id == user.id,
                Module.name == module_name,
            )
        )
        module = module_result.scalar_one_or_none()
        if module is None:
            module = Module(floor_id=floor.id, user_id=user.id, name=module_name)
            db.add(module)
            floor.overview_dirty = True
            await db.flush()

    await db.commit()

    return EnsureRegistrationContextResponse(
        building_id=building.id,
        building_name=building.name,
        floor_id=floor.id,
        floor_number=floor.floor_number,
        module_id=module.id if module is not None else None,
        module_name=module.name if module is not None else None,
    )


@router.post("/buildings/from-kakao", response_model=BuildingResponse)
async def create_or_find_building_from_kakao(
    body: BuildingFromKakaoRequest,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    building: Building | None = None
    if body.place_id:
        place_result = await db.execute(
            select(Building).where(Building.kakao_place_id == body.place_id)
        )
        building = place_result.scalar_one_or_none()

    if building is None:
        name_result = await db.execute(select(Building).where(Building.name == body.name))
        building = name_result.scalar_one_or_none()

    if building is None:
        building = Building(
            name=body.name,
            kakao_place_id=body.place_id,
            address_name=body.address_name,
            road_address_name=body.road_address_name,
            latitude=body.latitude,
            longitude=body.longitude,
        )
        db.add(building)
    else:
        if body.place_id and not building.kakao_place_id:
            building.kakao_place_id = body.place_id
        if body.address_name and not building.address_name:
            building.address_name = body.address_name
        if body.road_address_name and not building.road_address_name:
            building.road_address_name = body.road_address_name
        if body.latitude is not None and building.latitude is None:
            building.latitude = body.latitude
        if body.longitude is not None and building.longitude is None:
            building.longitude = body.longitude

    await db.commit()
    await db.refresh(building)
    return building


@router.get("/buildings/{building_id}", response_model=BuildingResponse)
async def get_building(
    building_id: UUID,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Building).where(Building.id == building_id)
    if user is None or user.role != UserRole.admin:
        stmt = stmt.where(Building.is_visible == True)
    result = await db.execute(stmt)
    building = result.scalar_one_or_none()
    if not building:
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")
    return building


@router.get("/buildings/{building_id}/metadata-options", response_model=BuildingMetadataOptionsResponse)
async def get_building_metadata_options(
    building_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Viewer 메타데이터 선택용: 관리자가 지정한 층과 모듈명 목록.

    floors 는 건물 공용 테이블을 사용하고, module 선택지는 admin 계정이 만든
    module 이름만 노출한다. 일반 사용자가 저장할 때는 선택한 이름으로 본인
    소유 module 을 별도로 생성/재사용한다.
    """
    building_stmt = select(Building).where(Building.id == building_id)
    if user.role != UserRole.admin:
        building_stmt = building_stmt.where(Building.is_visible == True)
    building_result = await db.execute(building_stmt)
    building = building_result.scalar_one_or_none()
    if not building:
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")

    floor_stmt = select(Floor).where(
        Floor.building_id == building_id,
        Floor.floor_number != 0,
    )
    if user.role != UserRole.admin:
        floor_stmt = floor_stmt.where(Floor.is_visible == True)
    floor_stmt = floor_stmt.order_by(Floor.floor_number.desc())
    floor_result = await db.execute(floor_stmt)
    floors = floor_result.scalars().all()
    if not floors:
        return BuildingMetadataOptionsResponse(id=building.id, name=building.name, floors=[])

    floor_ids = [f.id for f in floors]
    module_result = await db.execute(
        select(Module.id, Module.floor_id, Module.name)
        .join(User, Module.user_id == User.id)
        .where(
            Module.floor_id.in_(floor_ids),
            Module.is_visible == True,
            Module.name != "__basemap__",
            User.role == UserRole.admin,
        )
        .order_by(Module.floor_id, Module.name)
    )

    modules_by_floor: dict[UUID, list[MetadataModuleOption]] = {f.id: [] for f in floors}
    seen_by_floor: dict[UUID, set[str]] = {f.id: set() for f in floors}
    for module_id, floor_id, module_name in module_result.all():
        seen = seen_by_floor.setdefault(floor_id, set())
        if module_name in seen:
            continue
        seen.add(module_name)
        modules_by_floor.setdefault(floor_id, []).append(
            MetadataModuleOption(id=module_id, name=module_name)
        )

    return BuildingMetadataOptionsResponse(
        id=building.id,
        name=building.name,
        floors=[
            MetadataFloorOption(
                id=floor.id,
                building_id=floor.building_id,
                floor_number=floor.floor_number,
                modules=modules_by_floor.get(floor.id, []),
            )
            for floor in floors
        ],
    )


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
    source_upload_id: UUID | None = None
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
    _: User | None = Depends(get_current_user_optional),
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
        .where(
            Module.floor_id.in_(floor_ids),
            Module.is_visible == True,
            Module.name != "__basemap__",
        )
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
                source_upload_id=bm.source_upload_id,
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


@router.get("/buildings/{building_id}/floor-overview", response_model=FloorOverviewManifestResponse)
async def get_floor_overview_manifest(
    building_id: UUID,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    building_stmt = select(Building).where(Building.id == building_id)
    is_admin = user is not None and user.role == UserRole.admin
    if not is_admin:
        building_stmt = building_stmt.where(Building.is_visible == True)
    building_result = await db.execute(building_stmt)
    building = building_result.scalar_one_or_none()
    if building is None:
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")

    floor_stmt = (
        select(Floor)
        .where(Floor.building_id == building_id)
        .order_by(Floor.floor_number.desc())
    )
    if not is_admin:
        floor_stmt = floor_stmt.where(Floor.is_visible == True)
    floor_result = await db.execute(floor_stmt)
    floors = floor_result.scalars().all()
    if not floors:
        return FloorOverviewManifestResponse(
            building_id=building.id,
            building_name=building.name,
            building_is_confirmed=building.is_confirmed,
            generated_at=datetime.now(timezone.utc),
            floors=[],
        )

    floor_ids = [floor.id for floor in floors]
    module_count_stmt = (
        select(Module.floor_id, func.count(Module.id))
        .where(
            Module.floor_id.in_(floor_ids),
            Module.is_visible == True,
            Module.name != "__basemap__",
        )
        .group_by(Module.floor_id)
    )
    module_count_result = await db.execute(module_count_stmt)
    module_count_by_floor = {floor_id: count for floor_id, count in module_count_result.all()}

    active_basemap_result = await db.execute(
        select(Basemap.floor_id)
        .where(
            Basemap.floor_id.in_(floor_ids),
            Basemap.is_active == True,
        )
    )
    active_basemap_floor_ids = {floor_id for (floor_id,) in active_basemap_result.all()}

    pending_basemap_result = await db.execute(
        select(Basemap.floor_id)
        .where(
            Basemap.floor_id.in_(floor_ids),
            Basemap.status == BasemapStatus.pending,
            Basemap.is_active == False,
        )
    )
    pending_basemap_floor_ids = {floor_id for (floor_id,) in pending_basemap_result.all()}

    minio = get_minio_service()
    entries = [
        FloorOverviewManifestEntry(
            floor_id=floor.id,
            floor_number=floor.floor_number,
            overview_dirty=floor.overview_dirty,
            overview_version=floor.overview_version,
            topdown_url=safe_presigned_download_url(minio, floor.overview_image_path),
            meta_url=safe_presigned_download_url(minio, floor.overview_meta_path),
            module_count=int(module_count_by_floor.get(floor.id, 0)),
            has_active_basemap=floor.id in active_basemap_floor_ids,
            has_pending_basemap=floor.id in pending_basemap_floor_ids,
        )
        for floor in floors
    ]

    return FloorOverviewManifestResponse(
        building_id=building.id,
        building_name=building.name,
        building_is_confirmed=building.is_confirmed,
        generated_at=datetime.now(timezone.utc),
        floors=entries,
    )


@router.get(
    "/buildings/{building_id}/floors/{floor_number}/detail-manifest",
    response_model=FloorDetailManifestResponse,
)
async def get_floor_detail_manifest(
    building_id: UUID,
    floor_number: int,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    building_stmt = select(Building).where(Building.id == building_id)
    is_admin = user is not None and user.role == UserRole.admin
    if not is_admin:
        building_stmt = building_stmt.where(Building.is_visible == True)
    building_result = await db.execute(building_stmt)
    building = building_result.scalar_one_or_none()
    if building is None:
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")

    floor_stmt = select(Floor).where(
        Floor.building_id == building_id,
        Floor.floor_number == floor_number,
    )
    if not is_admin:
        floor_stmt = floor_stmt.where(Floor.is_visible == True)
    floor_result = await db.execute(floor_stmt)
    floor = floor_result.scalar_one_or_none()
    if floor is None:
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")

    minio = get_minio_service()

    basemap_result = await db.execute(
        select(Basemap)
        .where(
            Basemap.floor_id == floor.id,
            Basemap.is_active == True,
        )
        .order_by(Basemap.version.desc())
        .limit(1)
    )
    basemap = basemap_result.scalar_one_or_none()
    # 활성 basemap 이 없을 때 pending 기록이 있는지 확인 — UI 에 "관리자 승인 대기중" 안내 표시용.
    has_pending_basemap = False
    if basemap is None:
        pending_check = await db.execute(
            select(Basemap.id)
            .where(
                Basemap.floor_id == floor.id,
                Basemap.status == BasemapStatus.pending,
            )
            .limit(1)
        )
        has_pending_basemap = pending_check.scalar_one_or_none() is not None
    # basemap 서빙 키 — 경량 SOG 파생물(worker/DGX 가 refined PLY 옆에 '{name}.sog' 로 생성)이
    # 있으면 우선, 없으면 원본 PLY 로 폴백. (모듈 _scene_active_key 와 동일한 sog 우선 규약.)
    basemap_serve_key = None
    if basemap is not None:
        sog_candidate = os.path.splitext(basemap.minio_path)[0] + ".sog"
        basemap_serve_key = (
            sog_candidate if safe_object_exists(minio, sog_candidate) else basemap.minio_path
        )
    basemap_url = safe_presigned_download_url(minio, basemap_serve_key) if basemap_serve_key else None
    basemap_entry = (
        DetailBasemapEntry(
            id=basemap.id,
            version=basemap.version,
            source_upload_id=basemap.source_upload_id,
            url=basemap_url,
            filename=basemap_serve_key.rsplit("/", 1)[-1],
        )
        if basemap is not None
        else None
    )

    module_stmt = (
        select(Module, User.name.label("uploader_name"))
        .join(User, Module.user_id == User.id)
        .where(Module.floor_id == floor.id)
        # basemap 등록 시 placeholder 로 생성되는 '__basemap__' 모듈은 항상 숨김.
        .where(Module.name != "__basemap__")
        .order_by(Module.name)
    )
    if not is_admin:
        module_stmt = module_stmt.where(Module.is_visible == True)
    module_result = await db.execute(module_stmt)
    module_rows = module_result.all()

    module_ids = [module.id for module, _ in module_rows]
    latest_scene_by_module: dict[UUID, SceneOutput] = {}
    upload_id_by_task: dict[UUID, UUID] = {}
    if module_ids:
        scene_stmt = select(SceneOutput).where(SceneOutput.module_id.in_(module_ids))
        if not is_admin:
            public_scene_filter = and_(
                SceneOutput.is_aligned == True,
                Module.is_visible == True,
                Floor.is_visible == True,
                Building.is_visible == True,
            )
            scene_visibility_filter = (
                or_(SceneOutput.user_id == user.id, public_scene_filter)
                if user is not None
                else public_scene_filter
            )
            scene_stmt = (
                scene_stmt
                .join(Module, SceneOutput.module_id == Module.id)
                .join(Floor, Module.floor_id == Floor.id)
                .join(Building, Floor.building_id == Building.id)
                .where(scene_visibility_filter)
            )
        scene_result = await db.execute(
            scene_stmt.order_by(SceneOutput.module_id, SceneOutput.created_at.desc())
        )
        latest_scenes = scene_result.scalars().all()
        for scene in latest_scenes:
            latest_scene_by_module.setdefault(scene.module_id, scene)
        task_ids = [scene.task_id for scene in latest_scene_by_module.values()]
        if task_ids:
            task_result = await db.execute(select(Task.id, Task.upload_id).where(Task.id.in_(task_ids)))
            upload_id_by_task = {task_id: upload_id for task_id, upload_id in task_result.all()}

    module_entries: list[DetailModuleEntry] = []
    for module, uploader_name in module_rows:
        latest_scene = latest_scene_by_module.get(module.id)
        path = _pick_scene_output_path(minio, latest_scene)
        module_entries.append(
            DetailModuleEntry(
                id=module.id,
                name=module.name,
                user_id=module.user_id,
                uploader_name=uploader_name,
                alignment_transform=module.alignment_transform,
                is_visible=module.is_visible,
                version=latest_scene.created_at if latest_scene else None,
                url=minio.get_presigned_download_url(path) if path else None,
                source_upload_id=upload_id_by_task.get(latest_scene.task_id) if latest_scene else None,
            )
        )

    return FloorDetailManifestResponse(
        building_id=building.id,
        building_name=building.name,
        floor_id=floor.id,
        floor_number=floor.floor_number,
        basemap=basemap_entry,
        basemap_pending_approval=has_pending_basemap,
        modules=module_entries,
    )


# ── Floor endpoints ──

@router.get("/buildings/{building_id}/floors", response_model=list[FloorResponse])
async def list_floors(
    building_id: UUID,
    include_hidden: bool = Query(False),
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    show_hidden = include_hidden and user is not None and user.role == UserRole.admin
    stmt = (
        select(Floor)
        .join(Building, Floor.building_id == Building.id)
        .where(Floor.building_id == building_id)
    )
    if not show_hidden:
        stmt = stmt.where(Building.is_visible == True, Floor.is_visible == True)
    stmt = stmt.order_by(Floor.floor_number)
    result = await db.execute(stmt)
    return result.scalars().all()


@router.post("/buildings/{building_id}/floors", response_model=FloorResponse, status_code=status.HTTP_201_CREATED)
async def create_floor(
    building_id: UUID,
    body: FloorCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 건물 존재 확인
    bldg = await db.execute(select(Building).where(Building.id == building_id))
    building = bldg.scalar_one_or_none()
    if not building:
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")
    if user.role != UserRole.admin and building.is_confirmed:
        raise HTTPException(status_code=400, detail="확정된 건물에는 층을 추가할 수 없습니다.")

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


@router.post("/floors/{floor_id}/regenerate-overview", response_model=RegenerateOverviewResponse)
async def regenerate_floor_overview(
    floor_id: UUID,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Floor).where(Floor.id == floor_id))
    floor = result.scalar_one_or_none()
    if floor is None:
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")

    floor.overview_dirty = True
    await db.commit()

    return RegenerateOverviewResponse(
        floor_id=floor.id,
        overview_dirty=floor.overview_dirty,
        message="층 overview 재생성이 표시되었습니다. 백그라운드 렌더러 연동은 추후 연결됩니다.",
    )


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
        # 일반 목록에서는 숨김 모듈과 placeholder '__basemap__' 를 제외한다.
        # admin 표시 관리(show_hidden)에서는 basemap 도 'Basemap' 항목으로 노출한다.
        stmt = stmt.where(Module.is_visible == True, Module.name != "__basemap__")
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
    await db.execute(
        sa_update(Floor)
        .where(Floor.id == floor_id)
        .values(overview_dirty=True)
    )
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
    await db.execute(
        sa_update(Floor)
        .where(Floor.id == module.floor_id)
        .values(overview_dirty=True)
    )
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
# Show cascade 가 양방향인 이유: /explore 의 has_output 필터에서
# SceneOutput 분기는 건물·층·모듈 셋이 모두 visible 이어야 노출되므로,
# 한 단계만 풀면 UI 상 "표시" 가 실제로는 효과가 없어 보인다.
# (관리자 추가 분기 is_confirmed=True 는 건물 visibility 만 따른다.)


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
    await db.execute(
        sa_update(Floor)
        .where(Floor.id == module.floor_id)
        .values(overview_dirty=True)
    )

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


@router.delete("/admin/buildings/{building_id}", response_model=AdminDeleteResponse)
async def delete_building_admin(
    building_id: UUID,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    building = (await db.execute(select(Building).where(Building.id == building_id))).scalar_one_or_none()
    if building is None:
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")
    return await _delete_hierarchy_scope(
        db,
        scope="building",
        target_id=building_id,
        building_id=building_id,
    )


@router.delete("/admin/floors/{floor_id}", response_model=AdminDeleteResponse)
async def delete_floor_admin(
    floor_id: UUID,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    floor = (await db.execute(select(Floor).where(Floor.id == floor_id))).scalar_one_or_none()
    if floor is None:
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")
    return await _delete_hierarchy_scope(
        db,
        scope="floor",
        target_id=floor_id,
        floor_id=floor_id,
    )


@router.delete("/admin/modules/{module_id}", response_model=AdminDeleteResponse)
async def delete_module_admin(
    module_id: UUID,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    module = (await db.execute(select(Module).where(Module.id == module_id))).scalar_one_or_none()
    if module is None:
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")
    await db.execute(
        sa_update(Floor)
        .where(Floor.id == module.floor_id)
        .values(overview_dirty=True)
    )
    return await _delete_hierarchy_scope(
        db,
        scope="module",
        target_id=module_id,
        module_id=module_id,
    )


@router.put("/admin/buildings/{building_id}/confirm", response_model=BuildingResponse)
async def confirm_building(
    building_id: UUID,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Building).where(Building.id == building_id))
    building = result.scalar_one_or_none()
    if building is None:
        raise HTTPException(status_code=404, detail="건물을 찾을 수 없습니다.")

    building.is_confirmed = True
    await db.execute(
        sa_update(Floor)
        .where(Floor.building_id == building_id)
        .values(is_confirmed=True)
    )
    await db.execute(
        sa_update(Module)
        .where(Module.floor_id.in_(select(Floor.id).where(Floor.building_id == building_id)))
        .values(is_confirmed=True)
    )
    await db.commit()
    await db.refresh(building)
    return building


@router.put("/admin/floors/{floor_id}/confirm", response_model=FloorResponse)
async def confirm_floor(
    floor_id: UUID,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Floor).where(Floor.id == floor_id))
    floor = result.scalar_one_or_none()
    if floor is None:
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")

    floor.is_confirmed = True
    await db.execute(
        sa_update(Module)
        .where(Module.floor_id == floor_id)
        .values(is_confirmed=True)
    )
    await db.commit()
    await db.refresh(floor)
    return floor


@router.put("/admin/modules/{module_id}/confirm", response_model=ModuleResponse)
async def confirm_module(
    module_id: UUID,
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Module).where(Module.id == module_id))
    module = result.scalar_one_or_none()
    if module is None:
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")

    module.is_confirmed = True
    await db.commit()
    await db.refresh(module)
    return module


class AdminModuleBulkCreateRequest(BaseModel):
    module_input: str


@router.post(
    "/admin/floors/{floor_id}/modules",
    response_model=list[ModuleResponse],
    status_code=status.HTTP_201_CREATED,
)
async def admin_create_modules(
    floor_id: UUID,
    body: AdminModuleBulkCreateRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """관리자가 층에 모듈을 일괄 추가한다. module_input 이 `N~M` 형태면 범위로 확장한다."""
    floor_result = await db.execute(select(Floor).where(Floor.id == floor_id))
    floor = floor_result.scalar_one_or_none()
    if floor is None:
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")

    try:
        module_names = parse_module_name_input(body.module_input)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    visible_admin_result = await db.execute(
        select(Module.name)
        .join(User, Module.user_id == User.id)
        .where(
            Module.floor_id == floor.id,
            Module.name.in_(module_names),
            User.role == UserRole.admin,
            Module.is_visible == True,
        )
    )
    visible_admin_names = {name for (name,) in visible_admin_result.all()}

    admin_owned_result = await db.execute(
        select(Module).where(
            Module.floor_id == floor.id,
            Module.user_id == admin.id,
            Module.name.in_(module_names),
        )
    )
    admin_owned_by_name = {module.name: module for module in admin_owned_result.scalars().all()}

    affected: list[Module] = []
    for module_name in module_names:
        if module_name in visible_admin_names:
            continue
        existing_admin_module = admin_owned_by_name.get(module_name)
        if existing_admin_module is not None:
            existing_admin_module.is_visible = True
            existing_admin_module.is_confirmed = True
            affected.append(existing_admin_module)
            continue
        new_module = Module(
            floor_id=floor.id,
            user_id=admin.id,
            name=module_name,
            is_confirmed=True,
        )
        db.add(new_module)
        affected.append(new_module)

    await db.execute(
        sa_update(Floor).where(Floor.id == floor.id).values(overview_dirty=True)
    )
    await db.commit()
    for module in affected:
        await db.refresh(module)
    return affected
