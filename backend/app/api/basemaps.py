from uuid import UUID
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user, require_admin
from app.models import (
    User, Basemap, BasemapStatus, Floor, Building, Module, Upload,
    SceneOutput, Task,
)
from app.services.minio_service import get_minio_service

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

    # basemap.minio_path 는 SceneOutput.ply_path 와 동일 경로로 등록됨 (register_basemap_from_upload).
    # 그 SceneOutput → Task → Upload 로 거슬러 source upload_id 를 찾는다.
    src_q = await db.execute(
        select(Task.upload_id)
        .join(SceneOutput, SceneOutput.task_id == Task.id)
        .where(SceneOutput.ply_path == basemap.minio_path)
        .order_by(SceneOutput.created_at.desc())
        .limit(1)
    )
    source_upload_id = src_q.scalar_one_or_none()

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

    # source upload 찾기 (active endpoint 와 동일 경로)
    src_q = await db.execute(
        select(Task.upload_id)
        .join(SceneOutput, SceneOutput.task_id == Task.id)
        .where(SceneOutput.ply_path == basemap.minio_path)
        .order_by(SceneOutput.created_at.desc())
        .limit(1)
    )
    source_upload_id = src_q.scalar_one_or_none()
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


@router.get("", response_model=list[BasemapResponse])
async def list_basemaps(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """basemap 목록 조회 (관리자)"""
    result = await db.execute(
        select(Basemap).order_by(Basemap.floor_id, Basemap.version.desc())
    )
    return result.scalars().all()


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
    # 업로드 + 모듈 + 층 조회
    result = await db.execute(
        select(Upload, Module, Floor)
        .join(Module, Upload.module_id == Module.id)
        .join(Floor, Module.floor_id == Floor.id)
        .where(Upload.id == body.upload_id)
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="업로드를 찾을 수 없습니다.")
    upload, module, floor = row

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
        minio_path=refined_ply_path,
        version=next_version,
        uploaded_by=admin.id,
        status=BasemapStatus.pending,
    )
    db.add(basemap)
    await db.commit()
    await db.refresh(basemap)
    return basemap


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
