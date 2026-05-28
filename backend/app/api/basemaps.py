from uuid import UUID
from datetime import datetime, timezone
from io import BytesIO
import json

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from typing import Optional
from sqlalchemy import select, func, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user, require_admin
from app.models import (
    User, UserRole, Basemap, BasemapStatus, Floor, Building, Module, Upload,
    SceneOutput, Task,
)
from app.services.minio_service import get_minio_service
from app.services.metadata_options import (
    parse_module_name_input,
    validate_floor_number as validate_floor_number_value,
)
from app.services.storage_paths import doors_json_key

router = APIRouter(prefix="/admin/basemaps", tags=["basemaps"])

# 일반 사용자가 접근하는 basemap API (정합 등에서 사용)
public_router = APIRouter(prefix="/basemaps", tags=["basemaps"])


class ActiveBasemapResponse(BaseModel):
    basemap_id: UUID
    floor_id: UUID
    building_id: UUID
    version: int
    url: str
    filename: str
    # basemap 의 원본 upload — 클라이언트가 basemap 의 doors.json 을 가져와
    # 모듈 정합 시 호수 매칭 (basemap door 의 wallSurfaceId/모듈명 → 정합 대상 4점) 에 사용.
    source_upload_id: UUID | None = None


class BasemapDoorsUpdateRequest(BaseModel):
    doors: list[dict]


@public_router.get("/active", response_model=ActiveBasemapResponse)
async def get_active_basemap(
    floor_id: Optional[UUID] = None,
    module_id: Optional[UUID] = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """현재 층의 활성 basemap presigned URL 반환.

    floor_id 또는 module_id 중 하나를 받는다 (module_id가 있으면 해당 모듈의 floor 사용).
    """
    if not floor_id and not module_id:
        raise HTTPException(status_code=400, detail="floor_id 또는 module_id 중 하나를 지정하세요.")

    if module_id and not floor_id:
        mod_result = await db.execute(select(Module).where(Module.id == module_id))
        module = mod_result.scalar_one_or_none()
        if module is None:
            raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")
        floor_id = module.floor_id

    floor_result = await db.execute(select(Floor).where(Floor.id == floor_id))
    floor = floor_result.scalar_one_or_none()
    if floor is None:
        raise HTTPException(status_code=404, detail="층을 찾을 수 없습니다.")

    bm_result = await db.execute(
        select(Basemap).where(
            Basemap.floor_id == floor_id,
            Basemap.is_active == True,
        )
    )
    basemap = bm_result.scalar_one_or_none()
    if basemap is None:
        raise HTTPException(
            status_code=404,
            detail="이 층에 활성 basemap이 없습니다. 관리자에게 문의하세요.",
        )

    minio = get_minio_service()
    url = minio.get_presigned_download_url(basemap.minio_path)
    filename = basemap.minio_path.rsplit("/", 1)[-1]

    source_upload_id = await _resolve_source_upload_id(db, basemap)

    return ActiveBasemapResponse(
        basemap_id=basemap.id,
        floor_id=basemap.floor_id,
        building_id=floor.building_id,
        version=basemap.version,
        url=url,
        filename=filename,
        source_upload_id=source_upload_id,
    )


@public_router.get("/{basemap_id}/doors")
async def get_basemap_doors(
    basemap_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """basemap 의 doors.json 반환 — 정합 단계에서 모듈을 매칭할 대상 문 정보.

    `/uploads/{id}/doors` 와 동일 형식 ({doors: [...]}) 이지만 ownership 체크 없음 —
    basemap 은 admin 이 등록 후 모든 사용자가 읽을 수 있다.
    """
    bm_result = await db.execute(select(Basemap).where(Basemap.id == basemap_id))
    basemap = bm_result.scalar_one_or_none()
    if basemap is None:
        raise HTTPException(status_code=404, detail="basemap 을 찾을 수 없습니다.")

    source_upload_id = await _resolve_source_upload_id(db, basemap)
    if source_upload_id is None:
        return {"doors": []}

    up_q = await db.execute(select(Upload).where(Upload.id == source_upload_id))
    upload = up_q.scalar_one_or_none()
    if upload is None or not upload.door_corners_json_path:
        return {"doors": []}

    minio = get_minio_service()
    if not minio.object_exists(upload.door_corners_json_path):
        return {"doors": []}

    import json as _json
    try:
        raw = minio.get_object_bytes(upload.door_corners_json_path)
        parsed = _json.loads(raw.decode("utf-8"))
        doors = parsed.get("doors", []) if isinstance(parsed, dict) else []
        return {"doors": doors}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"doors.json 파싱 실패: {e}")


@router.put("/{basemap_id}/doors")
async def update_basemap_doors(
    basemap_id: UUID,
    body: BasemapDoorsUpdateRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """활성/승인 basemap 의 doors.json 메타를 관리자 권한으로 갱신한다.

    기존 doorMesh/doorSplat 파일은 그대로 두고 doors.json 만 덮어쓴다. 정합된 문을
    잠그는 판단은 클라이언트가 하며, 서버는 관리자 전용 쓰기 권한만 보장한다.
    """
    bm_result = await db.execute(select(Basemap).where(Basemap.id == basemap_id))
    basemap = bm_result.scalar_one_or_none()
    if basemap is None:
        raise HTTPException(status_code=404, detail="basemap 을 찾을 수 없습니다.")

    source_upload_id = await _resolve_source_upload_id(db, basemap)
    if source_upload_id is None:
        raise HTTPException(status_code=400, detail="basemap 원본 upload 정보가 없습니다.")

    up_q = await db.execute(select(Upload).where(Upload.id == source_upload_id))
    upload = up_q.scalar_one_or_none()
    if upload is None:
        raise HTTPException(status_code=404, detail="업로드를 찾을 수 없습니다.")

    key = upload.door_corners_json_path or doors_json_key(upload.minio_path)
    payload = json.dumps({"doors": body.doors}, ensure_ascii=False).encode("utf-8")
    minio = get_minio_service()
    minio.client.put_object(
        minio.bucket,
        key,
        data=BytesIO(payload),
        length=len(payload),
        content_type="application/json",
    )
    upload.door_corners_json_path = key
    await db.commit()
    return {"doors": body.doors}


class BasemapResponse(BaseModel):
    id: UUID
    floor_id: UUID
    floor_number: int
    building_id: UUID
    building_name: str
    version: int
    source_upload_id: UUID | None = None
    status: str
    is_active: bool
    created_at: datetime
    approved_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BasemapCandidateResponse(BaseModel):
    upload_id: UUID
    original_filename: str
    file_size: int
    uploaded_at: datetime
    uploaded_by_name: str
    module_id: UUID
    module_name: str
    floor_id: UUID
    floor_number: int
    building_id: UUID
    building_name: str
    already_registered: bool


class BasemapRegisterRequest(BaseModel):
    upload_id: UUID


class BasemapRegisterResponse(BaseModel):
    basemap_id: UUID
    floor_id: UUID
    version: int
    status: str


class BasemapMetadataModuleResponse(BaseModel):
    id: UUID
    name: str


class BasemapMetadataFloorResponse(BaseModel):
    id: UUID
    building_id: UUID
    floor_number: int
    modules: list[BasemapMetadataModuleResponse]


class BasemapMetadataResponse(BaseModel):
    basemap_id: UUID
    building_id: UUID
    building_name: str
    floors: list[BasemapMetadataFloorResponse]


class BasemapFloorCreateRequest(BaseModel):
    floor_number: int

    @field_validator("floor_number")
    @classmethod
    def validate_floor_number(cls, v: int) -> int:
        return validate_floor_number_value(v)


class BasemapModuleCreateRequest(BaseModel):
    floor_id: UUID
    module_input: str


def _basemap_response(basemap: Basemap, floor: Floor, building: Building) -> BasemapResponse:
    return BasemapResponse(
        id=basemap.id,
        floor_id=basemap.floor_id,
        floor_number=floor.floor_number,
        building_id=building.id,
        building_name=building.name,
        version=basemap.version,
        source_upload_id=basemap.source_upload_id,
        status=basemap.status.value if hasattr(basemap.status, "value") else str(basemap.status),
        is_active=basemap.is_active,
        created_at=basemap.created_at,
        approved_at=basemap.approved_at,
    )


async def _resolve_source_upload_id(db: AsyncSession, basemap: Basemap) -> UUID | None:
    if basemap.source_upload_id is not None:
        return basemap.source_upload_id

    src_q = await db.execute(
        select(Task.upload_id)
        .join(SceneOutput, SceneOutput.task_id == Task.id)
        .where(SceneOutput.ply_path == basemap.minio_path)
        .order_by(SceneOutput.created_at.desc())
        .limit(1)
    )
    return src_q.scalar_one_or_none()


async def _get_basemap_with_building(
    db: AsyncSession,
    basemap_id: UUID,
) -> tuple[Basemap, Floor, Building]:
    result = await db.execute(
        select(Basemap, Floor, Building)
        .join(Floor, Basemap.floor_id == Floor.id)
        .join(Building, Floor.building_id == Building.id)
        .where(Basemap.id == basemap_id)
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Basemap을 찾을 수 없습니다.")
    return row


async def _metadata_response_for_building(
    db: AsyncSession,
    basemap_id: UUID,
    building: Building,
) -> BasemapMetadataResponse:
    floor_result = await db.execute(
        select(Floor)
        .where(
            Floor.building_id == building.id,
            Floor.floor_number != 0,
            Floor.is_visible == True,
        )
        .order_by(Floor.floor_number.desc())
    )
    floors = floor_result.scalars().all()
    if not floors:
        return BasemapMetadataResponse(
            basemap_id=basemap_id,
            building_id=building.id,
            building_name=building.name,
            floors=[],
        )

    floor_ids = [floor.id for floor in floors]
    module_result = await db.execute(
        select(Module.id, Module.floor_id, Module.name)
        .join(User, Module.user_id == User.id)
        .where(
            Module.floor_id.in_(floor_ids),
            Module.is_visible == True,
            User.role == UserRole.admin,
        )
        .order_by(Module.floor_id, Module.name)
    )

    modules_by_floor: dict[UUID, list[BasemapMetadataModuleResponse]] = {f.id: [] for f in floors}
    seen_by_floor: dict[UUID, set[str]] = {f.id: set() for f in floors}
    for module_id, floor_id, module_name in module_result.all():
        seen = seen_by_floor.setdefault(floor_id, set())
        if module_name in seen:
            continue
        seen.add(module_name)
        modules_by_floor.setdefault(floor_id, []).append(
            BasemapMetadataModuleResponse(id=module_id, name=module_name)
        )

    return BasemapMetadataResponse(
        basemap_id=basemap_id,
        building_id=building.id,
        building_name=building.name,
        floors=[
            BasemapMetadataFloorResponse(
                id=floor.id,
                building_id=floor.building_id,
                floor_number=floor.floor_number,
                modules=modules_by_floor.get(floor.id, []),
            )
            for floor in floors
        ],
    )


@router.get("", response_model=list[BasemapResponse])
async def list_basemaps(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """basemap 목록 조회 (관리자)"""
    result = await db.execute(
        select(Basemap, Floor, Building)
        .join(Floor, Basemap.floor_id == Floor.id)
        .join(Building, Floor.building_id == Building.id)
        .order_by(Building.name, Floor.floor_number.desc(), Basemap.version.desc())
    )
    return [
        _basemap_response(basemap, floor, building)
        for basemap, floor, building in result.all()
    ]


@router.get("/candidates", response_model=list[BasemapCandidateResponse])
async def list_basemap_candidates(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """basemap 후보 = 다듬기까지 끝난 업로드들 (관리자)

    업로드의 원본 PLY 는 placeholder 경로(`<base>/alignment/<uuid>_local.ply`)로
    저장되며 MinIO 에 실물이 없을 수 있다 (`uploads.py` register_local 참고).
    실제로 MinIO 에 존재하는 PLY 는 다듬기 결과(`alignment/refined/.../refined_*.ply`)
    이므로, 후보는 SceneOutput 가 1개 이상 있는 업로드로 한정한다.
    """
    # 업로드별 가장 최근 SceneOutput 의 ply_path. 윈도우 함수로 1개만 뽑는다.
    rn = func.row_number().over(
        partition_by=Task.upload_id,
        order_by=SceneOutput.created_at.desc(),
    ).label("rn")
    latest_scene_subq = (
        select(
            Task.upload_id.label("upload_id"),
            SceneOutput.ply_path.label("ply_path"),
            SceneOutput.created_at.label("scene_created_at"),
            rn,
        )
        .join(SceneOutput, SceneOutput.task_id == Task.id)
        .subquery()
    )

    stmt = (
        select(
            Upload.id.label("upload_id"),
            Upload.original_filename,
            Upload.file_size,
            Upload.uploaded_at,
            latest_scene_subq.c.ply_path,
            latest_scene_subq.c.scene_created_at,
            User.name.label("uploaded_by_name"),
            Module.id.label("module_id"),
            Module.name.label("module_name"),
            Floor.id.label("floor_id"),
            Floor.floor_number,
            Building.id.label("building_id"),
            Building.name.label("building_name"),
        )
        .select_from(Upload)
        .join(latest_scene_subq, latest_scene_subq.c.upload_id == Upload.id)
        .join(User, Upload.user_id == User.id)
        .join(Module, Upload.module_id == Module.id)
        .join(Floor, Module.floor_id == Floor.id)
        .join(Building, Floor.building_id == Building.id)
        .where(latest_scene_subq.c.rn == 1)
        .order_by(latest_scene_subq.c.scene_created_at.desc())
    )
    result = await db.execute(stmt)
    rows = result.all()

    # 이미 등록된 minio_path 집합 — 거부된(rejected) basemap 은 다시 등록 가능하므로 제외
    registered = await db.execute(
        select(Basemap.minio_path).where(Basemap.status != BasemapStatus.rejected)
    )
    registered_paths = {p for (p,) in registered.all()}

    return [
        BasemapCandidateResponse(
            upload_id=r.upload_id,
            original_filename=r.original_filename,
            file_size=r.file_size,
            uploaded_at=r.uploaded_at,
            uploaded_by_name=r.uploaded_by_name,
            module_id=r.module_id,
            module_name=r.module_name,
            floor_id=r.floor_id,
            floor_number=r.floor_number,
            building_id=r.building_id,
            building_name=r.building_name,
            already_registered=r.ply_path in registered_paths,
        )
        for r in rows
    ]


@router.post("/register", response_model=BasemapResponse, status_code=status.HTTP_201_CREATED)
async def register_basemap_from_upload(
    body: BasemapRegisterRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """업로드의 다듬기 결과(refined PLY)를 basemap 으로 등록 (관리자).

    Upload.minio_path 는 placeholder 라 MinIO 에 실물이 없을 수 있으므로,
    가장 최근 SceneOutput.ply_path (실제 다듬기 결과)를 basemap 으로 사용한다.
    """
    # 업로드 + 모듈 + 층 + 건물 조회
    result = await db.execute(
        select(Upload, Module, Floor, Building)
        .join(Module, Upload.module_id == Module.id)
        .join(Floor, Module.floor_id == Floor.id)
        .join(Building, Floor.building_id == Building.id)
        .where(Upload.id == body.upload_id)
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="업로드를 찾을 수 없습니다.")
    upload, module, floor, building = row

    # 가장 최근 다듬기 결과 조회 — basemap 의 실제 PLY 경로
    scene_result = await db.execute(
        select(SceneOutput.ply_path)
        .join(Task, SceneOutput.task_id == Task.id)
        .where(Task.upload_id == upload.id)
        .order_by(SceneOutput.created_at.desc())
        .limit(1)
    )
    refined_ply_path = scene_result.scalar_one_or_none()
    if refined_ply_path is None:
        raise HTTPException(
            status_code=400,
            detail="다듬기 결과가 없는 업로드는 basemap 으로 등록할 수 없습니다.",
        )

    # MinIO 에 실물 존재 검증 — placeholder 만 등록되는 사고 재발 방지
    minio = get_minio_service()
    if not minio.object_exists(refined_ply_path):
        raise HTTPException(
            status_code=400,
            detail="다듬기 결과 PLY 가 MinIO 에 존재하지 않습니다.",
        )

    # 중복 등록 방지 — 거부된(rejected) 이력은 무시하고 재등록을 허용한다
    dup = await db.execute(
        select(Basemap).where(
            Basemap.minio_path == refined_ply_path,
            Basemap.status != BasemapStatus.rejected,
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="이미 basemap으로 등록된 파일입니다.")

    # 다음 버전 계산 (해당 층 기준)
    latest = await db.execute(
        select(Basemap)
        .where(Basemap.floor_id == floor.id)
        .order_by(Basemap.version.desc())
        .limit(1)
    )
    latest_bm = latest.scalar_one_or_none()
    next_version = (latest_bm.version + 1) if latest_bm else 1

    basemap = Basemap(
        floor_id=floor.id,
        source_upload_id=upload.id,
        minio_path=refined_ply_path,
        version=next_version,
        uploaded_by=admin.id,
        status=BasemapStatus.pending,
    )
    db.add(basemap)
    await db.commit()
    await db.refresh(basemap)
    return _basemap_response(basemap, floor, building)


@public_router.post("/register", response_model=BasemapRegisterResponse, status_code=status.HTTP_201_CREATED)
async def register_basemap_from_user_upload(
    body: BasemapRegisterRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Upload, Module, Floor)
        .join(Module, Upload.module_id == Module.id)
        .join(Floor, Module.floor_id == Floor.id)
        .where(Upload.id == body.upload_id, Upload.user_id == user.id)
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="업로드를 찾을 수 없습니다.")
    upload, _, floor = row

    minio = get_minio_service()
    refined_ply_path: str | None = None
    if upload.refined_ply_path and minio.object_exists(upload.refined_ply_path):
        refined_ply_path = upload.refined_ply_path
    else:
        scene_result = await db.execute(
            select(SceneOutput.ply_path)
            .join(Task, SceneOutput.task_id == Task.id)
            .where(Task.upload_id == upload.id)
            .order_by(SceneOutput.created_at.desc())
            .limit(1)
        )
        refined_ply_path = scene_result.scalar_one_or_none()

    if refined_ply_path is None:
        raise HTTPException(status_code=400, detail="다듬기 결과가 없는 업로드는 basemap 으로 등록할 수 없습니다.")
    if not minio.object_exists(refined_ply_path):
        raise HTTPException(status_code=400, detail="다듬기 결과 PLY 가 MinIO 에 존재하지 않습니다.")

    dup = await db.execute(
        select(Basemap).where(
            Basemap.minio_path == refined_ply_path,
            Basemap.status != BasemapStatus.rejected,
        )
    )
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="이미 basemap으로 등록된 파일입니다.")

    latest = await db.execute(
        select(Basemap)
        .where(Basemap.floor_id == floor.id)
        .order_by(Basemap.version.desc())
        .limit(1)
    )
    latest_bm = latest.scalar_one_or_none()
    next_version = (latest_bm.version + 1) if latest_bm else 1

    basemap = Basemap(
        floor_id=floor.id,
        source_upload_id=upload.id,
        minio_path=refined_ply_path,
        version=next_version,
        uploaded_by=user.id,
        status=BasemapStatus.pending,
    )
    db.add(basemap)
    await db.commit()
    await db.refresh(basemap)
    return BasemapRegisterResponse(
        basemap_id=basemap.id,
        floor_id=basemap.floor_id,
        version=basemap.version,
        status=basemap.status.value if hasattr(basemap.status, "value") else str(basemap.status),
    )


@router.get("/{basemap_id}/metadata", response_model=BasemapMetadataResponse)
async def get_basemap_metadata(
    basemap_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """등록된 Basemap 이 속한 건물의 관리자 지정 층/모듈 목록."""
    _, _, building = await _get_basemap_with_building(db, basemap_id)
    return await _metadata_response_for_building(db, basemap_id, building)


@router.post("/{basemap_id}/metadata/floors", response_model=BasemapMetadataResponse)
async def add_basemap_metadata_floor(
    basemap_id: UUID,
    body: BasemapFloorCreateRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Basemap 의 건물에 관리자 지정 층을 추가한다."""
    _, _, building = await _get_basemap_with_building(db, basemap_id)

    existing = await db.execute(
        select(Floor).where(
            Floor.building_id == building.id,
            Floor.floor_number == body.floor_number,
        )
    )
    floor = existing.scalar_one_or_none()
    if floor is None:
        db.add(Floor(building_id=building.id, floor_number=body.floor_number))
        await db.commit()
    elif not floor.is_visible:
        floor.is_visible = True
        await db.commit()

    return await _metadata_response_for_building(db, basemap_id, building)


@router.post("/{basemap_id}/metadata/modules", response_model=BasemapMetadataResponse)
async def add_basemap_metadata_modules(
    basemap_id: UUID,
    body: BasemapModuleCreateRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Basemap 의 건물에 속한 층에 관리자 지정 모듈명을 추가한다.

    module_input 이 `N~M` 형태이면 N부터 M까지 문자열 모듈명으로 확장한다.
    """
    _, _, building = await _get_basemap_with_building(db, basemap_id)

    floor_result = await db.execute(
        select(Floor).where(
            Floor.id == body.floor_id,
            Floor.building_id == building.id,
        )
    )
    floor = floor_result.scalar_one_or_none()
    if floor is None:
        raise HTTPException(status_code=404, detail="Basemap 건물에 속한 층을 찾을 수 없습니다.")

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

    for module_name in module_names:
        if module_name in visible_admin_names:
            continue
        existing_admin_module = admin_owned_by_name.get(module_name)
        if existing_admin_module is not None:
            existing_admin_module.is_visible = True
            continue
        db.add(Module(floor_id=floor.id, user_id=admin.id, name=module_name))

    await db.commit()
    return await _metadata_response_for_building(db, basemap_id, building)


@router.delete("/{basemap_id}/metadata/floors/{floor_id}", response_model=BasemapMetadataResponse)
async def delete_basemap_metadata_floor(
    basemap_id: UUID,
    floor_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Basemap 건물의 층 선택지를 숨기고 관리자 모듈 선택지도 함께 숨긴다."""
    _, _, building = await _get_basemap_with_building(db, basemap_id)

    floor_result = await db.execute(
        select(Floor).where(
            Floor.id == floor_id,
            Floor.building_id == building.id,
        )
    )
    floor = floor_result.scalar_one_or_none()
    if floor is None:
        raise HTTPException(status_code=404, detail="Basemap 건물에 속한 층을 찾을 수 없습니다.")

    floor.is_visible = False
    await db.execute(
        sa_update(Module)
        .where(
            Module.floor_id == floor.id,
            Module.user_id.in_(
                select(User.id).where(User.role == UserRole.admin)
            ),
        )
        .values(is_visible=False)
    )
    await db.commit()
    return await _metadata_response_for_building(db, basemap_id, building)


@router.delete("/{basemap_id}/metadata/modules/{module_id}", response_model=BasemapMetadataResponse)
async def delete_basemap_metadata_module(
    basemap_id: UUID,
    module_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """관리자가 만든 모듈 선택지를 숨긴다."""
    _, _, building = await _get_basemap_with_building(db, basemap_id)

    module_result = await db.execute(
        select(Module, Floor, User)
        .join(Floor, Module.floor_id == Floor.id)
        .join(User, Module.user_id == User.id)
        .where(
            Module.id == module_id,
            Floor.building_id == building.id,
            User.role == UserRole.admin,
        )
    )
    row = module_result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Basemap 건물에 속한 관리자 모듈을 찾을 수 없습니다.")

    module, _, _ = row
    module.is_visible = False
    await db.commit()
    return await _metadata_response_for_building(db, basemap_id, building)


async def _activate_basemap_inplace(db: AsyncSession, new_basemap: Basemap) -> None:
    """승인된 basemap 을 활성화한다 (commit 은 호출자가 수행).

    - 같은 층의 기존 활성 basemap 을 superseded 로 내림
    - new_basemap.is_active = True
    - 해당 floor.overview_dirty = True
    - 해당 floor 및 부모 building 의 is_visible = True (explore/viewer 자동 노출)

    활성 basemap 은 Basemap row 의 minio_path 를 직접 조회하므로 공용 고정 key
    로 복사하지 않아도 현재 조회 경로와 충돌하지 않는다.
    """
    # 층 정보 조회
    floor_result = await db.execute(select(Floor).where(Floor.id == new_basemap.floor_id))
    floor = floor_result.scalar_one()

    # 기존 활성 basemap 비활성화
    result = await db.execute(
        select(Basemap).where(
            Basemap.floor_id == new_basemap.floor_id,
            Basemap.is_active == True,
            Basemap.id != new_basemap.id,
        )
    )
    old_basemap = result.scalar_one_or_none()
    if old_basemap:
        old_basemap.is_active = False
        old_basemap.status = BasemapStatus.superseded

    # 새 basemap 활성화
    new_basemap.is_active = True
    floor.overview_dirty = True

    # 층 및 부모 건물 자동 표시 (별도 VisibilityManager 조작 없이 노출)
    floor.is_visible = True
    await db.execute(
        sa_update(Building)
        .where(Building.id == floor.building_id)
        .values(is_visible=True)
    )


@router.put("/{basemap_id}/approve")
async def approve_basemap(
    basemap_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """basemap 승인 (관리자) — 승인 즉시 활성화(등록)까지 수행."""
    result = await db.execute(select(Basemap).where(Basemap.id == basemap_id))
    basemap = result.scalar_one_or_none()

    if basemap is None:
        raise HTTPException(status_code=404, detail="Basemap을 찾을 수 없습니다.")

    if basemap.status != BasemapStatus.pending:
        raise HTTPException(status_code=400, detail="대기 상태인 basemap만 승인할 수 있습니다.")

    basemap.status = BasemapStatus.approved
    basemap.approved_by = admin.id
    basemap.approved_at = datetime.now(timezone.utc)

    # 승인 = 등록: 곧바로 활성화하고 층/건물을 자동 표시한다.
    await _activate_basemap_inplace(db, basemap)

    await db.commit()

    return {
        "message": "승인 및 활성화 완료",
        "basemap_id": str(basemap.id),
    }


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


@router.delete("/{basemap_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_basemap(
    basemap_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """basemap 등록 자체를 취소 (관리자).

    상태(거부/대기/승인/활성)와 무관하게 row 를 삭제하여, 원본 PLY 가
    다시 'basemap으로 등록' 버튼이 노출되는 후보 상태로 돌아오게 한다.
    """
    result = await db.execute(select(Basemap).where(Basemap.id == basemap_id))
    basemap = result.scalar_one_or_none()
    if basemap is None:
        raise HTTPException(status_code=404, detail="Basemap을 찾을 수 없습니다.")

    await db.delete(basemap)
    await db.commit()
    return None


@router.put("/{basemap_id}/activate")
async def activate_basemap(
    basemap_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """basemap 활성화 (관리자).

    승인 시 이미 활성화까지 처리되므로 일반적으로는 호출되지 않지만,
    하위호환을 위해 엔드포인트를 유지한다. 이미 활성인 경우 멱등하게 동작한다.
    """
    result = await db.execute(select(Basemap).where(Basemap.id == basemap_id))
    new_basemap = result.scalar_one_or_none()

    if new_basemap is None:
        raise HTTPException(status_code=404, detail="Basemap을 찾을 수 없습니다.")

    if new_basemap.status not in (BasemapStatus.approved,):
        raise HTTPException(status_code=400, detail="승인된 basemap만 활성화할 수 있습니다.")

    await _activate_basemap_inplace(db, new_basemap)

    await db.commit()

    return {
        "message": "활성화 완료. 기존 모듈 재정렬이 필요합니다.",
        "basemap_id": str(new_basemap.id),
    }
