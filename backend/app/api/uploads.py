import json
import logging
import math
import os
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import get_current_user
from app.core.storage_keys import is_key_under_prefix, normalize_minio_key
from app.models import (
    User, UserRole, Upload, Task, Module, Floor, Building, SceneOutput,
    UploadStatus, TaskType, TaskStatus, PlyTarget, Sam3Status,
    Basemap, Notification,
)
from sqlalchemy import delete as sa_delete, update as sa_update
from app.schemas.uploads import (
    UploadInitRequest,
    UploadInitResponse,
    UploadCompleteRequest,
    UploadCompleteResponse,
    UploadResponse,
    get_upload_subfolder,
)
from app.services.minio_service import get_minio_service, PART_SIZE
from app.services.celery_service import (
    dispatch_training_task,
    dispatch_sam3_door_detection_task,
    dispatch_colmap_task,
)
from app.services.sam3_service import (
    SAM3_DISABLED_DETAIL,
    mark_sam3_disabled,
    mark_sam3_dispatch_pending,
)
from app.services.storage_access import delete_storage_best_effort
from app.services.storage_paths import doors_json_key, module_base_path, refined_prefix

router = APIRouter(prefix="/uploads", tags=["uploads"])
settings = get_settings()
logger = logging.getLogger(__name__)

# 사용자당 업로드 제한 (개수 / 총 용량)
MAX_UPLOADS_PER_USER = 100
MAX_STORAGE_PER_USER = 200 * 1024 * 1024 * 1024  # 200 GB

# ── Staging multipart 업로드 ───────────────────────────────────────────────
# Cloudflare 요청 본문 100MB 한도를 피하기 위한 범용 청크 업로드. 대용량 자산
# (예: commit-final 의 refined PLY ~130MB)을 module/Upload 행 없이도 MinIO 에
# 직접 청크 PUT 으로 올린 뒤, 이어지는 핸들러(commit-final)가 그 키를 받아
# 서버사이드 copy 로 최종 위치에 옮긴다. 키는 사용자 격리: staging/{user}/{uuid}.
STAGING_PREFIX = "staging"


def _user_staging_prefix(user_id) -> str:
    return f"{STAGING_PREFIX}/{user_id}/"


class StagingMultipartInitRequest(BaseModel):
    filename: str
    file_size: int
    content_type: str = "application/octet-stream"


class StagingMultipartInitResponse(BaseModel):
    key: str
    minio_upload_id: str
    presigned_urls: list[str]
    part_size: int
    part_count: int


class StagingMultipartPart(BaseModel):
    part_number: int
    etag: str


class StagingMultipartCompleteRequest(BaseModel):
    key: str
    minio_upload_id: str
    parts: list[StagingMultipartPart]


class StagingMultipartCompleteResponse(BaseModel):
    key: str


@router.post("/staging-multipart-init", response_model=StagingMultipartInitResponse)
async def staging_multipart_init(
    body: StagingMultipartInitRequest,
    user: User = Depends(get_current_user),
):
    """대용량 자산을 staging 키로 청크 presigned PUT 하기 위한 multipart 초기화."""
    if body.file_size <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="file_size는 양수여야 합니다.")
    ext = os.path.splitext(body.filename)[1].lower() or ".ply"
    key = f"{STAGING_PREFIX}/{user.id}/{uuid4()}{ext}"
    part_count = max(1, math.ceil(body.file_size / PART_SIZE))
    minio = get_minio_service()
    minio_upload_id = minio.init_multipart_upload(key, body.content_type)
    presigned_urls = minio.get_presigned_upload_urls(key, minio_upload_id, part_count)
    return StagingMultipartInitResponse(
        key=key,
        minio_upload_id=minio_upload_id,
        presigned_urls=presigned_urls,
        part_size=PART_SIZE,
        part_count=part_count,
    )


@router.post("/staging-multipart-complete", response_model=StagingMultipartCompleteResponse)
async def staging_multipart_complete(
    body: StagingMultipartCompleteRequest,
    user: User = Depends(get_current_user),
):
    """모든 청크 PUT 후 호출. 본인 staging 경로의 키만 완료 처리한다."""
    try:
        key = normalize_minio_key(body.key)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="유효하지 않은 key 입니다.")
    if not is_key_under_prefix(key, _user_staging_prefix(user.id)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="본인 staging 경로의 키가 아닙니다.")
    minio = get_minio_service()
    try:
        parts = [{"part_number": p.part_number, "etag": p.etag} for p in body.parts]
        minio.complete_multipart_upload(key, body.minio_upload_id, parts)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"MinIO staging multipart 완료 실패: {str(e)}",
        )
    return StagingMultipartCompleteResponse(key=key)


@router.post("/init", response_model=UploadInitResponse)
async def init_upload(
    body: UploadInitRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Multipart 업로드 초기화 — presigned URL 반환"""
    # 사용자당 업로드 개수 / 용량 제한 확인
    quota_result = await db.execute(
        select(
            func.count(Upload.id).label("upload_count"),
            func.coalesce(func.sum(Upload.file_size), 0).label("total_size"),
        ).where(
            Upload.user_id == user.id,
            Upload.status != UploadStatus.failed,
        )
    )
    quota = quota_result.one()
    if quota.upload_count >= MAX_UPLOADS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"업로드 개수 한도({MAX_UPLOADS_PER_USER}개)를 초과했습니다.",
        )
    if quota.total_size + body.file_size > MAX_STORAGE_PER_USER:
        used_gb = quota.total_size / (1024 ** 3)
        limit_gb = MAX_STORAGE_PER_USER / (1024 ** 3)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"저장 용량 한도({limit_gb:.0f}GB)를 초과합니다. 현재 사용량: {used_gb:.1f}GB",
        )

    # 모듈 조회 및 계층 검증 — 본인 module 만 (admin 면제)
    module_stmt = (
        select(Module)
        .join(Floor, Module.floor_id == Floor.id)
        .join(Building, Floor.building_id == Building.id)
        .where(
            Module.id == body.module_id,
            Floor.id == body.floor_id,
            Building.id == body.building_id,
        )
    )
    if user.role != UserRole.admin:
        module_stmt = module_stmt.where(Module.user_id == user.id)
    result = await db.execute(module_stmt)
    module = result.scalar_one_or_none()
    if module is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="building_id / floor_id / module_id 조합이 유효하지 않습니다.",
        )

    # 업로드 서브폴더 결정 — ply_target 기반. 예: "gsplat" → "gsplat_uploads/"
    subfolder = get_upload_subfolder(body.filename, body.ply_target or "gsplat")

    # MinIO 오브젝트 키 생성 — UUID 기반 (원본 파일명은 DB에만 저장)
    ext = os.path.splitext(body.filename)[1].lower()
    unique_name = f"{uuid4()}{ext}"
    base_path = module_base_path(
        str(body.building_id), str(body.floor_id),
        str(body.module_id), module.name,
    )
    minio_key = f"{base_path}/{subfolder}/{unique_name}"

    # 파트 수 계산
    part_count = max(1, math.ceil(body.file_size / PART_SIZE))

    minio = get_minio_service()
    minio_upload_id = minio.init_multipart_upload(minio_key, body.content_type)
    presigned_urls = minio.get_presigned_upload_urls(minio_key, minio_upload_id, part_count)

    # DB 업로드 레코드 생성
    ply_target_val = PlyTarget(body.ply_target) if body.ply_target else None
    upload = Upload(
        user_id=user.id,
        module_id=body.module_id,
        original_filename=body.filename,
        file_size=body.file_size,
        content_type=body.content_type,
        minio_path=minio_key,
        ply_target=ply_target_val,
        status=UploadStatus.uploaded,
    )
    db.add(upload)
    await db.flush()

    return UploadInitResponse(
        upload_id=upload.id,
        minio_upload_id=minio_upload_id,
        presigned_urls=presigned_urls,
        part_size=PART_SIZE,
        part_count=part_count,
    )


@router.post("/complete", response_model=UploadCompleteResponse)
async def complete_upload(
    body: UploadCompleteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Multipart 업로드 완료 — MinIO 완료 처리 + DB 갱신"""
    result = await db.execute(
        select(Upload).where(Upload.id == body.upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()

    if upload is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="업로드를 찾을 수 없습니다.",
        )

    minio = get_minio_service()

    try:
        parts = [
            {"part_number": p.part_number, "etag": p.etag}
            for p in body.parts
        ]
        minio.complete_multipart_upload(upload.minio_path, body.minio_upload_id, parts)
    except Exception as e:
        upload.status = UploadStatus.failed
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"MinIO 업로드 완료 실패: {str(e)}",
        )

    # 완성된 객체의 실제 크기를 MinIO stat으로 검증한다.
    try:
        actual_size = minio.get_object_size(upload.minio_path)
    except Exception as e:
        upload.status = UploadStatus.failed
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"업로드 파일 검증 실패: {str(e)}",
        )

    max_size = max(1, int(settings.UPLOAD_MAX_FILE_SIZE_BYTES))
    tolerance = max(0, int(settings.UPLOAD_SIZE_TOLERANCE_BYTES))
    declared_size = int(upload.file_size or 0)

    if actual_size <= 0:
        upload.status = UploadStatus.failed
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="업로드 파일 크기가 0이어서 완료할 수 없습니다.",
        )
    if actual_size > max_size:
        upload.status = UploadStatus.failed
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="업로드 파일이 허용된 최대 크기를 초과했습니다.",
        )
    if declared_size > 0 and actual_size > declared_size + tolerance:
        upload.status = UploadStatus.failed
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="업로드 파일의 실제 크기가 선언된 크기 허용 오차를 초과했습니다.",
        )

    # quota 계산 일관성을 위해 실제 저장 크기로 보정.
    upload.file_size = actual_size
    upload.status = UploadStatus.processing

    ext = os.path.splitext(upload.original_filename)[1].lower()
    is_ply = ext == ".ply"
    is_scene_artifact = ext in {".splat", ".sog"}
    is_colmap_input = upload.ply_target == PlyTarget.colmap

    skip_training = (
        (is_ply and upload.ply_target in (PlyTarget.alignment, PlyTarget.refined))
        or is_scene_artifact
        or is_colmap_input  # COLMAP은 별도 태스크로 처리
    )

    if skip_training and not is_colmap_input:
        upload.status = UploadStatus.completed

    # 모듈 + 계층 정보 조회
    mod_result = await db.execute(
        select(Module)
        .join(Floor, Module.floor_id == Floor.id)
        .where(Module.id == upload.module_id)
    )
    module = mod_result.scalar_one()
    floor_result = await db.execute(select(Floor).where(Floor.id == module.floor_id))
    floor = floor_result.scalar_one()

    celery_task_id = None

    if is_colmap_input:
        # COLMAP 전처리 태스크 발행
        upload.status = UploadStatus.processing
        celery_task_id = dispatch_colmap_task(
            upload_id=str(upload.id),
            user_id=str(user.id),
            minio_input_key=upload.minio_path,
        )
        task = Task(
            upload_id=upload.id,
            user_id=user.id,
            task_type=TaskType.colmap_preprocessing,
            celery_task_id=celery_task_id,
            status=TaskStatus.pending,
        )
    elif not skip_training:
        celery_task_id = dispatch_training_task(
            upload_id=str(upload.id),
            user_id=str(user.id),
            minio_input_key=upload.minio_path,
            building_id=str(floor.building_id),
            floor_id=str(floor.id),
            module_id=str(module.id),
            module_name=module.name,
            ply_target=upload.ply_target.value if upload.ply_target else "gsplat",
        )
        task = Task(
            upload_id=upload.id,
            user_id=user.id,
            task_type=TaskType.training_3dgs,
            celery_task_id=celery_task_id,
            status=TaskStatus.pending,
        )
    else:
        task = Task(
            upload_id=upload.id,
            user_id=user.id,
            task_type=TaskType.training_3dgs,
            celery_task_id=None,
            status=TaskStatus.completed,
        )

    db.add(task)
    await db.commit()

    if is_colmap_input:
        msg = "업로드 완료. COLMAP 전처리가 시작됩니다."
    elif skip_training:
        if is_scene_artifact or upload.ply_target == PlyTarget.refined:
            msg = "업로드 완료. refined 폴더에 저장되었습니다."
        else:
            msg = "업로드 완료. alignment 폴더에 저장되었습니다."
    else:
        msg = "업로드 완료. 3DGS 학습이 시작됩니다."

    final_status = "processing" if (is_colmap_input or not skip_training) else "completed"
    return UploadCompleteResponse(
        upload_id=upload.id,
        status=final_status,
        message=msg,
    )


def _upload_to_response(
    upload: Upload,
    has_scene_output: bool = False,
    is_basemap_source: bool = False,
    has_alignment: bool = False,
    is_basemap_upload: bool = False,
    is_basemap_active: bool = False,
) -> UploadResponse:
    """Upload ORM → UploadResponse (SAM3 파이프라인 파생 플래그 포함).

    has_refined: SAM3 정식 경로 (refined_ply_path) 또는 다듬기 저장으로 생성된 SceneOutput 중 하나라도 있으면 true.
    is_basemap_source: 이 업로드가 어떤 basemap의 원본 PLY 인지 — 삭제 비활성화 판단용.
    is_basemap_upload: basemap 목적으로 올라온 업로드인지 (register-local-basemap 가 생성하는 '__basemap__' 모듈 소속).
        등록 전이라도 모듈 업로드와 구분 가능 — 대시보드 상태/정합 버튼 분기용.
    is_basemap_active: 이 업로드를 원본으로 하는 basemap 이 활성(관리자 승인/등록 완료)인지.
        pending(제출만 됨) 단계에서도 Basemap row(source_upload) 는 생기므로, '업로드 완료' vs 'Basemap'
        구분은 is_basemap_source 가 아니라 이 플래그로 한다.
    """
    return UploadResponse(
        id=upload.id,
        module_id=upload.module_id,
        original_filename=upload.original_filename,
        file_size=upload.file_size,
        status=upload.status.value if upload.status else "uploaded",
        ply_target=upload.ply_target.value if upload.ply_target else None,
        uploaded_at=upload.uploaded_at,
        sam3_status=upload.sam3_status.value if upload.sam3_status else None,
        sam3_prompt=upload.sam3_prompt,
        has_refined=bool(upload.refined_ply_path) or has_scene_output,
        has_doors_json=bool(upload.door_corners_json_path),
        has_alignment=has_alignment,
        has_gsplat_ply=bool(upload.gsplat_ply_path),
        is_basemap_source=is_basemap_source,
        is_basemap_upload=is_basemap_upload,
        is_basemap_active=is_basemap_active,
    )


@router.get("", response_model=list[UploadResponse])
async def list_uploads(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """내 업로드 목록 조회 — 사용자가 직접 숨김 처리한 항목은 제외."""
    result = await db.execute(
        select(Upload)
        .where(Upload.user_id == user.id, Upload.hidden_from_history.is_(False))
        .order_by(Upload.uploaded_at.desc())
    )
    uploads = result.scalars().all()
    if not uploads:
        return []
    # 다듬기 저장 (SceneOutput 생성) 여부를 한 번에 조회 — has_refined 보강용.
    upload_ids = [u.id for u in uploads]
    scene_rows = await db.execute(
        select(Task.upload_id)
        .join(SceneOutput, SceneOutput.task_id == Task.id)
        .where(Task.upload_id.in_(upload_ids), SceneOutput.user_id == user.id)
        .distinct()
    )
    has_scene = {row[0] for row in scene_rows.all()}
    # basemap 원본으로 사용 중인 업로드 — 삭제 비활성화 판단용.
    basemap_rows = await db.execute(
        select(Basemap.source_upload_id)
        .where(Basemap.source_upload_id.in_(upload_ids))
        .distinct()
    )
    basemap_source_ids = {row[0] for row in basemap_rows.all() if row[0] is not None}
    # 활성(관리자 승인/등록 완료) basemap 의 원본 업로드 — 상태 'Basemap' 표시 판단용.
    active_basemap_rows = await db.execute(
        select(Basemap.source_upload_id)
        .where(Basemap.source_upload_id.in_(upload_ids), Basemap.is_active == True)
        .distinct()
    )
    active_basemap_source_ids = {row[0] for row in active_basemap_rows.all() if row[0] is not None}
    module_ids = {u.module_id for u in uploads}
    aligned_module_rows = await db.execute(
        select(Module.id)
        .where(Module.id.in_(module_ids), Module.alignment_transform.is_not(None))
    )
    aligned_module_ids = {row[0] for row in aligned_module_rows.all()}
    # basemap 목적 업로드 — register-local-basemap 가 만드는 '__basemap__' 모듈 소속.
    basemap_module_rows = await db.execute(
        select(Module.id)
        .where(Module.id.in_(module_ids), Module.name == "__basemap__")
    )
    basemap_module_ids = {row[0] for row in basemap_module_rows.all()}
    return [
        _upload_to_response(
            u,
            has_scene_output=(u.id in has_scene),
            is_basemap_source=(u.id in basemap_source_ids),
            has_alignment=(u.module_id in aligned_module_ids),
            is_basemap_upload=(u.module_id in basemap_module_ids),
            is_basemap_active=(u.id in active_basemap_source_ids),
        )
        for u in uploads
    ]


@router.get("/{upload_id}", response_model=UploadResponse)
async def get_upload(
    upload_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """업로드 상세 조회"""
    result = await db.execute(
        select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()

    if upload is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="업로드를 찾을 수 없습니다.",
        )

    scene_check = await db.execute(
        select(SceneOutput.id)
        .join(Task, SceneOutput.task_id == Task.id)
        .where(Task.upload_id == upload_id, SceneOutput.user_id == user.id)
        .limit(1)
    )
    has_scene = scene_check.scalar_one_or_none() is not None
    basemap_check = await db.execute(
        select(Basemap.id).where(Basemap.source_upload_id == upload_id).limit(1)
    )
    is_basemap_source = basemap_check.scalar_one_or_none() is not None
    active_basemap_check = await db.execute(
        select(Basemap.id)
        .where(Basemap.source_upload_id == upload_id, Basemap.is_active == True)
        .limit(1)
    )
    is_basemap_active = active_basemap_check.scalar_one_or_none() is not None
    module_check = await db.execute(
        select(Module.alignment_transform, Module.name).where(Module.id == upload.module_id).limit(1)
    )
    module_row = module_check.first()
    has_alignment = module_row is not None and module_row[0] is not None
    is_basemap_upload = module_row is not None and module_row[1] == "__basemap__"
    return _upload_to_response(
        upload,
        has_scene_output=has_scene,
        is_basemap_source=is_basemap_source,
        has_alignment=has_alignment,
        is_basemap_upload=is_basemap_upload,
        is_basemap_active=is_basemap_active,
    )


VIEWABLE_EXTENSIONS = {".ply", ".splat", ".sog"}


@router.delete("/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_upload(
    upload_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """업로드 삭제 — 본인 (또는 관리자) 업로드만 삭제.

    basemap의 원본으로 등록된 업로드는 삭제할 수 없다 (관리자가 먼저
    Basemap 관리 화면에서 등록 취소를 해야 한다).

    함께 정리:
      - SceneOutput row + MinIO 파일 (ply/sog/metadata)
      - 관련 Task row + Notification.related_task_id null 처리
      - Upload 자신의 MinIO 파일 (원본/refined/doors.json + refined prefix)
    """
    stmt = select(Upload).where(Upload.id == upload_id)
    if user.role != UserRole.admin:
        stmt = stmt.where(Upload.user_id == user.id)
    upload = (await db.execute(stmt)).scalar_one_or_none()
    if upload is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="업로드를 찾을 수 없습니다.",
        )

    basemap_exists = (await db.execute(
        select(Basemap.id).where(Basemap.source_upload_id == upload.id).limit(1)
    )).scalar_one_or_none()
    if basemap_exists is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="basemap에 등록된 업로드는 삭제할 수 없습니다. 관리자에게 문의하세요.",
        )

    # 정리 대상 키 / prefix 수집.
    keys: set[str] = set()
    prefixes: set[str] = set()
    for k in (upload.minio_path, upload.refined_ply_path, upload.door_corners_json_path):
        if k:
            keys.add(k)
    if upload.minio_path:
        prefixes.add(refined_prefix(upload.minio_path))

    task_ids_rows = await db.execute(select(Task.id).where(Task.upload_id == upload.id))
    task_ids = [tid for (tid,) in task_ids_rows.all()]

    scene_rows = await db.execute(
        select(SceneOutput.id, SceneOutput.ply_path, SceneOutput.sog_path, SceneOutput.metadata_path)
        .join(Task, SceneOutput.task_id == Task.id)
        .where(Task.upload_id == upload.id)
    )
    scene_ids: list[UUID] = []
    for sid, ply_path, sog_path, metadata_path in scene_rows.all():
        scene_ids.append(sid)
        for k in (ply_path, sog_path, metadata_path):
            if k:
                keys.add(k)

    if task_ids:
        await db.execute(
            sa_update(Notification)
            .where(Notification.related_task_id.in_(task_ids))
            .values(related_task_id=None)
        )
    if scene_ids:
        await db.execute(sa_delete(SceneOutput).where(SceneOutput.id.in_(scene_ids)))
    if task_ids:
        await db.execute(sa_delete(Task).where(Task.id.in_(task_ids)))
    await db.execute(sa_delete(Upload).where(Upload.id == upload.id))
    await db.commit()

    delete_storage_best_effort(get_minio_service(), prefixes, keys)

    return None


@router.post("/{upload_id}/hide", status_code=status.HTTP_204_NO_CONTENT)
async def hide_upload(
    upload_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """basemap 으로 채택되어 삭제가 막힌 업로드를 내 업로드 내역에서만 숨김.

    파일과 DB row 는 그대로 유지되며, /uploads 목록에서만 제외된다. basemap 의
    원본으로 등록되지 않은 업로드는 일반 DELETE 로 완전 삭제하면 되므로 이
    엔드포인트가 거부한다.
    """
    stmt = select(Upload).where(Upload.id == upload_id)
    if user.role != UserRole.admin:
        stmt = stmt.where(Upload.user_id == user.id)
    upload = (await db.execute(stmt)).scalar_one_or_none()
    if upload is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="업로드를 찾을 수 없습니다.",
        )

    basemap_exists = (await db.execute(
        select(Basemap.id).where(Basemap.source_upload_id == upload.id).limit(1)
    )).scalar_one_or_none()
    if basemap_exists is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="basemap 원본이 아닌 업로드는 숨김 대신 삭제하세요.",
        )

    if not upload.hidden_from_history:
        upload.hidden_from_history = True
        await db.commit()

    return None


@router.get("/{upload_id}/presigned-url")
async def get_upload_presigned_url(
    upload_id: UUID,
    variant: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """ply/splat/sog 업로드 파일의 presigned 다운로드 URL 반환.

    variant=refined 이면 정제된 파일이 존재할 경우 그것을 반환한다.
    """
    result = await db.execute(
        select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()

    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    minio = get_minio_service()

    # COLMAP 업로드는 원본이 ZIP/MP4 이지만 워커가 생성한 결과 PLY 가 있으면 그것을 서빙한다.
    if upload.ply_target == PlyTarget.colmap:
        if upload.gsplat_ply_path and minio.object_exists(upload.gsplat_ply_path):
            url = minio.get_presigned_download_url(upload.gsplat_ply_path)
            ply_filename = os.path.splitext(upload.original_filename)[0] + ".ply"
            return {"url": url, "filename": ply_filename, "variant": "gsplat"}
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="아직 결과 PLY 가 준비되지 않았습니다 (학습 진행 중이거나 실패).",
        )

    ext = os.path.splitext(upload.original_filename)[1].lower()
    if ext not in VIEWABLE_EXTENSIONS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="뷰어를 지원하지 않는 파일 형식입니다.")

    # 정제된 PLY 후보 — variant=refined 우선시 + variant=None 일 때 원본 부재 시 fallback 으로도 사용.
    #   1순위: upload.refined_ply_path (SAM3 파이프라인 정식 경로)
    #   2순위: 가장 최근 SceneOutput.ply_path (레거시 호환)
    async def _find_refined_url() -> str | None:
        if upload.refined_ply_path and minio.object_exists(upload.refined_ply_path):
            return minio.get_presigned_download_url(upload.refined_ply_path)
        scene_result = await db.execute(
            select(SceneOutput)
            .join(Task, SceneOutput.task_id == Task.id)
            .where(Task.upload_id == upload_id, SceneOutput.user_id == user.id)
            .order_by(SceneOutput.created_at.desc())
            .limit(1)
        )
        scene = scene_result.scalar_one_or_none()
        if scene and minio.object_exists(scene.ply_path):
            return minio.get_presigned_download_url(scene.ply_path)
        return None

    if variant == "refined":
        refined_url = await _find_refined_url()
        if refined_url is not None:
            return {"url": refined_url, "filename": upload.original_filename, "variant": "refined"}

    # variant=None 또는 fallback. 원본이 MinIO 에 실제 존재할 때만 original 을 서빙;
    # 그렇지 않으면 (예: register-local 로 placeholder 만 잡힌 케이스) refined 로 자동 fallback.
    if minio.object_exists(upload.minio_path):
        url = minio.get_presigned_download_url(upload.minio_path)
        return {"url": url, "filename": upload.original_filename, "variant": "original"}

    refined_url = await _find_refined_url()
    if refined_url is not None:
        return {"url": refined_url, "filename": upload.original_filename, "variant": "refined"}

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="이 업로드에 사용할 수 있는 PLY 파일이 없습니다 (원본 미업로드, 정제 결과 없음).",
    )


# ─────────────────────────────────────────────────────────────────────────────
# SAM3 / 정합 파이프라인 — docs/sam3_alignment_pipeline.md
# ─────────────────────────────────────────────────────────────────────────────

# 로컬 파일에서 다듬기를 시작한 사용자가 "다듬기 저장" 시점에 호출 — 원본 PLY 를 MinIO 에
# 업로드하지 않고 upload 레코드만 생성한다 (refined PLY 만 영속화하면 충분).
class RegisterLocalRequest(BaseModel):
    filename: str
    building_id: UUID
    floor_id: UUID
    module_id: UUID
    file_size: int = 0       # 쿼터 추적용. 0 이면 단순 무시.
    content_type: str = "application/octet-stream"


class RegisterLocalResponse(BaseModel):
    upload_id: UUID
    minio_path: str   # placeholder (refined PLY 의 base_dir 계산에만 사용됨)


class RegisterLocalBasemapRequest(BaseModel):
    filename: str
    building_id: UUID
    floor_id: UUID
    file_size: int = 0
    content_type: str = "application/octet-stream"


class EnsureBasemapModuleRequest(BaseModel):
    building_id: UUID
    floor_id: UUID


class EnsureBasemapModuleResponse(BaseModel):
    module_id: UUID


@router.post("/register-local", response_model=RegisterLocalResponse)
async def register_local_upload(
    body: RegisterLocalRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """로컬에서 다듬기 중인 PLY 의 원본을 업로드 없이 등록.

    - 원본 파일 자체는 MinIO 에 올라가지 않는다 (placeholder key 만 저장).
    - status=completed, ply_target=alignment.
    - 이후 /refine/refined-upload-url + /uploads/{id}/sam3/start 로 refined PLY 만 올림.
    """
    # 모듈 계층 검증 — 본인 module 만 (admin 면제)
    module_stmt = (
        select(Module)
        .join(Floor, Module.floor_id == Floor.id)
        .join(Building, Floor.building_id == Building.id)
        .where(
            Module.id == body.module_id,
            Floor.id == body.floor_id,
            Building.id == body.building_id,
        )
    )
    if user.role != UserRole.admin:
        module_stmt = module_stmt.where(Module.user_id == user.id)
    result = await db.execute(module_stmt)
    module = result.scalar_one_or_none()
    if module is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="building_id / floor_id / module_id 조합이 유효하지 않습니다.",
        )

    # 사용자당 업로드 개수/용량 한도 (file_size 가 0 이면 용량은 그대로).
    quota_result = await db.execute(
        select(
            func.count(Upload.id).label("upload_count"),
            func.coalesce(func.sum(Upload.file_size), 0).label("total_size"),
        ).where(
            Upload.user_id == user.id,
            Upload.status != UploadStatus.failed,
        )
    )
    quota = quota_result.one()
    if quota.upload_count >= MAX_UPLOADS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"업로드 개수 한도({MAX_UPLOADS_PER_USER}개)를 초과했습니다.",
        )
    if body.file_size > 0 and quota.total_size + body.file_size > MAX_STORAGE_PER_USER:
        used_gb = quota.total_size / (1024 ** 3)
        limit_gb = MAX_STORAGE_PER_USER / (1024 ** 3)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"저장 용량 한도({limit_gb:.0f}GB)를 초과합니다. 현재 사용량: {used_gb:.1f}GB",
        )

    # placeholder MinIO 경로 — 실제 객체는 없지만 base_dir 가 모듈 폴더 안에 있어야
    # refined PLY / mesh / doors.json 의 키 계산이 일관됨.
    ext = os.path.splitext(body.filename)[1].lower() or ".ply"
    base_path = module_base_path(
        str(body.building_id), str(body.floor_id),
        str(body.module_id), module.name,
    )
    placeholder_key = f"{base_path}/alignment/{uuid4()}_local{ext}"

    upload = Upload(
        user_id=user.id,
        module_id=body.module_id,
        original_filename=body.filename,
        file_size=body.file_size,
        content_type=body.content_type,
        minio_path=placeholder_key,
        ply_target=PlyTarget.alignment,
        status=UploadStatus.completed,
    )
    db.add(upload)
    await db.commit()

    return RegisterLocalResponse(upload_id=upload.id, minio_path=placeholder_key)


@router.post("/register-local-basemap", response_model=RegisterLocalResponse)
async def register_local_basemap_upload(
    body: RegisterLocalBasemapRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    floor_result = await db.execute(
        select(Floor).where(Floor.id == body.floor_id, Floor.building_id == body.building_id)
    )
    floor = floor_result.scalar_one_or_none()
    if floor is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="building_id / floor_id 조합이 유효하지 않습니다.",
        )

    module_result = await db.execute(
        select(Module).where(
            Module.floor_id == body.floor_id,
            Module.user_id == user.id,
            Module.name == "__basemap__",
        )
    )
    module = module_result.scalar_one_or_none()
    if module is None:
        module = Module(
            floor_id=body.floor_id,
            user_id=user.id,
            name="__basemap__",
            is_visible=False,
        )
        db.add(module)
        await db.flush()
    elif module.is_visible:
        module.is_visible = False

    ext = os.path.splitext(body.filename)[1].lower() or ".ply"
    base_path = module_base_path(
        str(body.building_id), str(body.floor_id),
        str(module.id), module.name,
    )
    placeholder_key = f"{base_path}/alignment/{uuid4()}_local{ext}"

    upload = Upload(
        user_id=user.id,
        module_id=module.id,
        original_filename=body.filename,
        file_size=body.file_size,
        content_type=body.content_type,
        minio_path=placeholder_key,
        ply_target=PlyTarget.alignment,
        status=UploadStatus.completed,
    )
    db.add(upload)
    await db.commit()

    return RegisterLocalResponse(upload_id=upload.id, minio_path=placeholder_key)


@router.post("/ensure-basemap-module", response_model=EnsureBasemapModuleResponse)
async def ensure_basemap_module(
    body: EnsureBasemapModuleRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """basemap 목적 COLMAP(영상/사진묶음) 업로드용 — 해당 층의 숨김 '__basemap__'
    모듈을 찾거나 생성해 module_id 를 반환한다.

    PLY basemap 등록은 register-local-basemap 이 placeholder 업로드까지 만들지만,
    COLMAP 업로드는 /uploads/init 가 실제 업로드를 만들므로 여기서는 모듈만 확보한다.
    is_visible=False 규약으로 일반 모듈 목록/통계에 노출되지 않게 한다.
    """
    floor_result = await db.execute(
        select(Floor).where(Floor.id == body.floor_id, Floor.building_id == body.building_id)
    )
    floor = floor_result.scalar_one_or_none()
    if floor is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="building_id / floor_id 조합이 유효하지 않습니다.",
        )

    module_result = await db.execute(
        select(Module).where(
            Module.floor_id == body.floor_id,
            Module.user_id == user.id,
            Module.name == "__basemap__",
        )
    )
    module = module_result.scalar_one_or_none()
    if module is None:
        module = Module(
            floor_id=body.floor_id,
            user_id=user.id,
            name="__basemap__",
            is_visible=False,
        )
        db.add(module)
        await db.flush()
    elif module.is_visible:
        module.is_visible = False
    await db.commit()

    return EnsureBasemapModuleResponse(module_id=module.id)


# refined PLY: 클라이언트가 /refine/refined-upload-url 로 단일 PUT 업로드 한 후,
# 이 엔드포인트를 호출해 canonical refined_ply_path 등록 + SAM3 task 발행.
class BakeRotation(BaseModel):
    rotX: float = 0.0
    rotZ: float = 0.0
    wallAngleRad: float = 0.0


class Sam3StartRequest(BaseModel):
    refined_ply_key: str   # MinIO key (refined PLY — doors.json 위치 도출용)
    prompt: str = ""
    bake_rotation: BakeRotation | None = None  # 다듬기에서 베이크된 회전 — 원본 좌표계 검출 결과를 refined 좌표계로 변환할 때 사용


class Sam3StartResponse(BaseModel):
    upload_id: UUID
    sam3_status: str
    celery_task_id: str | None
@router.post("/{upload_id}/sam3/start", response_model=Sam3StartResponse)
async def start_sam3(
    upload_id: UUID,
    body: Sam3StartRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """업로드 완료된 refined PLY 를 canonical 경로로 등록 + SAM3 문 검출 태스크 발행."""
    result = await db.execute(
        select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    try:
        refined_key = normalize_minio_key(body.refined_ply_key)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="유효하지 않은 refined_ply_key 입니다.")

    upload_refined_prefix = refined_prefix(upload.minio_path)
    if not is_key_under_prefix(refined_key, upload_refined_prefix):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="refined_ply_key 는 업로드의 refined 경로 하위여야 합니다.",
        )

    minio = get_minio_service()
    if not minio.object_exists(refined_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="refined PLY 가 MinIO 에 없습니다.")

    if not settings.ENABLE_SAM3:
        mark_sam3_disabled(upload=upload, refined_key=refined_key, prompt=body.prompt)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=SAM3_DISABLED_DETAIL,
        )

    mark_sam3_dispatch_pending(upload=upload, refined_key=refined_key, prompt=body.prompt)

    # 모듈/계층 정보 (SAM3 task 페이로드용)
    mod_q = await db.execute(
        select(Module, Floor).join(Floor, Module.floor_id == Floor.id)
        .where(Module.id == upload.module_id)
    )
    mod, floor = mod_q.one()

    celery_task_id: str | None = None
    try:
        # SAM3 검출은 다듬기 전 원본 PLY (upload.minio_path) 로 수행. 다듬기 산출물은
        # 벽 가우시안이 mesh+texture 로 분리돼 SAM3 가 문을 못 봐 본질적으로 검출 실패.
        # door-ml 결과(원본 좌표계 corners) 는 백엔드에서 베이크 회전 적용 → refined 좌표계로 변환.
        bake = body.bake_rotation or BakeRotation()
        celery_task_id = dispatch_sam3_door_detection_task(
            upload_id=str(upload.id),
            user_id=str(user.id),
            original_ply_key=upload.minio_path,
            prompt=upload.sam3_prompt or "",
            building_id=str(floor.building_id),
            floor_id=str(floor.id),
            floor_number=floor.floor_number,
            module_id=str(mod.id),
            module_name=mod.name,
            rot_x=bake.rotX,
            rot_z=bake.rotZ,
            wall_angle_rad=bake.wallAngleRad,
            doors_target_key=refined_key,
        )
        upload.sam3_status = Sam3Status.running
    except Exception as e:
        # broker/worker 비가용 — failed 로 두면 사용자가 정합 단계에서 수동 지정 가능.
        upload.sam3_status = Sam3Status.failed
        logger.exception(f"[sam3] dispatch failed: {e}")

    if celery_task_id:
        task = Task(
            upload_id=upload.id,
            user_id=user.id,
            task_type=TaskType.sam3_door_detection,
            celery_task_id=celery_task_id,
            status=TaskStatus.running,
        )
        db.add(task)

    await db.commit()

    return Sam3StartResponse(
        upload_id=upload.id,
        sam3_status=upload.sam3_status.value if upload.sam3_status else "pending",
        celery_task_id=celery_task_id,
    )


class Sam3StatusResponse(BaseModel):
    upload_id: UUID
    sam3_status: str | None
    sam3_prompt: str | None
    has_doors_json: bool
    refined_ply_present: bool


@router.get("/{upload_id}/sam3", response_model=Sam3StatusResponse)
async def get_sam3_status(
    upload_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """SAM3 진행 상태 폴링용 — 다듬기→정합 전환 로딩 화면이 호출."""
    result = await db.execute(
        select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    minio = get_minio_service()
    has_doors = bool(upload.door_corners_json_path) and minio.object_exists(upload.door_corners_json_path)
    has_refined = bool(upload.refined_ply_path) and minio.object_exists(upload.refined_ply_path)

    return Sam3StatusResponse(
        upload_id=upload.id,
        sam3_status=upload.sam3_status.value if upload.sam3_status else None,
        sam3_prompt=upload.sam3_prompt,
        has_doors_json=has_doors,
        refined_ply_present=has_refined,
    )


# ── doors.json: SAM3 결과 + 사용자 보정 ─────────────────────────────────────

class DoorMeshMeta(BaseModel):
    """도어 quad mesh 의 영속화 메타 — wall 텍스처에서 도어 영역을 잘라낸 별도 PNG + corners.

    basemap 재로드 시 wall mesh quad entity 재생성에 필요한 정보 전부 포함.
    """
    corners: list[list[float]]  # 4 × [x, y, z] — A'+Y 프레임 mesh 코너
    uvs: list[list[float]]      # 4 × [u, v]   — 텍스처 매핑
    normalInward: list[float]   # [x, y, z]    — 방 안쪽 normal
    textureFilename: str        # MinIO 키: "tex_door_<doorId>.png"
    textureWidth: int
    textureHeight: int


class DoorSplatMeta(BaseModel):
    """도어 영역 가우시안 splat PLY 의 영속화 메타 (boundary split sub + doorOrig)."""
    filename: str               # MinIO 키: "door_<doorId>.ply"


class DoorEntry(BaseModel):
    """doors.json 의 한 문 엔트리.

    corners 외 나머지 메타 (회전축/회전각/방향/벽 surfaceId/두께/분할 옵션 등) 는
    문 설정 단계에서 사용자가 확정한 값. 정합·재진입·basemap 매칭 시 모두 활용되므로
    스키마에 명시해 라운드트립 시 손실되지 않게 한다.

    선택 자산 `doorMesh` / `doorSplat`: basemap 의 경우 도어별 텍스처/가우시안을 별도
    파일로 영속화하면 로드 시 그대로 재생성 가능. 없으면 corners 만으로 정합 매칭 등에 사용.
    """
    id: str
    corners: list[list[float]]  # 4 × [x, y, z]
    hingeEdge: int | None = None
    swing: int | None = None
    angleDeg: float | None = None
    wallSurfaceId: str | None = None
    doorExtractionDepth: float | None = None
    boundarySplitEnabled: bool | None = None
    # basemap 등록 시 각 문에 부여하는 호수 (예: "302호"). 정합 단계에서 모듈의
    # 호수 (Module.name) 와 매칭해 basemap 의 어느 문에 정합할지 결정. 모듈측에서는 비어있음.
    unitName: str | None = None
    doorMesh: DoorMeshMeta | None = None
    doorSplat: DoorSplatMeta | None = None


class DoorsJson(BaseModel):
    doors: list[DoorEntry] = Field(default_factory=list)


@router.get("/{upload_id}/doors", response_model=DoorsJson)
async def get_doors(
    upload_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """저장된 doors.json 반환 (없으면 빈 리스트)."""
    result = await db.execute(
        select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    if not upload.door_corners_json_path:
        return DoorsJson(doors=[])

    minio = get_minio_service()
    if not minio.object_exists(upload.door_corners_json_path):
        return DoorsJson(doors=[])

    try:
        raw = minio.get_object_bytes(upload.door_corners_json_path)
        parsed = json.loads(raw.decode("utf-8"))
        doors = parsed.get("doors", []) if isinstance(parsed, dict) else []
        # 가벼운 검증 — corners 형식만 강제하고 메타 필드는 그대로 패스스루.
        clean: list[DoorEntry] = []
        for d in doors:
            if not isinstance(d, dict): continue
            corners = d.get("corners") or []
            if not isinstance(corners, list) or len(corners) != 4: continue
            ok = all(
                isinstance(c, list) and len(c) == 3 and
                all(isinstance(v, (int, float)) for v in c)
                for c in corners
            )
            if not ok: continue
            entry_kwargs = dict(
                id=str(d.get("id") or f"door_{len(clean)+1}"),
                corners=corners,
                hingeEdge=d.get("hingeEdge") if isinstance(d.get("hingeEdge"), int) else None,
                swing=d.get("swing") if isinstance(d.get("swing"), int) else None,
                angleDeg=d.get("angleDeg") if isinstance(d.get("angleDeg"), (int, float)) else None,
                wallSurfaceId=d.get("wallSurfaceId") if isinstance(d.get("wallSurfaceId"), str) else None,
                doorExtractionDepth=d.get("doorExtractionDepth") if isinstance(d.get("doorExtractionDepth"), (int, float)) else None,
                boundarySplitEnabled=d.get("boundarySplitEnabled") if isinstance(d.get("boundarySplitEnabled"), bool) else None,
                unitName=d.get("unitName") if isinstance(d.get("unitName"), str) else None,
            )
            # doorMesh / doorSplat — 옵션. Pydantic 가 형식 검증; 실패 시 그냥 패스 (corners 만으로 사용 가능).
            dm = d.get("doorMesh")
            if isinstance(dm, dict):
                try: entry_kwargs["doorMesh"] = DoorMeshMeta(**dm)
                except Exception: pass
            ds = d.get("doorSplat")
            if isinstance(ds, dict):
                try: entry_kwargs["doorSplat"] = DoorSplatMeta(**ds)
                except Exception: pass
            clean.append(DoorEntry(**entry_kwargs))
        return DoorsJson(doors=clean)
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"doors.json 파싱 실패: {e}")


@router.put("/{upload_id}/doors", response_model=DoorsJson)
async def put_doors(
    upload_id: UUID,
    body: DoorsJson,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """doors.json 통째 덮어쓰기 (이력 보존 안 함 — 합의 사양)."""
    result = await db.execute(
        select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    minio = get_minio_service()
    key = upload.door_corners_json_path or doors_json_key(upload.minio_path)
    # exclude_none — 미입력 도어 메타 필드 (hingeEdge 등) 는 JSON 에 안 넣어 가독성 유지.
    payload = json.dumps(
        {"doors": [d.model_dump(exclude_none=True) for d in body.doors]}
    ).encode("utf-8")

    # MinIO put_object 직접 호출 (작은 메타파일이라 단일 PUT)
    from io import BytesIO
    minio.client.put_object(
        minio.bucket, key,
        data=BytesIO(payload), length=len(payload),
        content_type="application/json",
    )
    upload.door_corners_json_path = key
    await db.commit()
    return body
