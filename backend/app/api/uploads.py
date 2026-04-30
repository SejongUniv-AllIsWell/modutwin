import math
import os
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import (
    User, Upload, Task, Module, Floor, Building,
    UploadStatus, TaskType, TaskStatus, PlyTarget,
)
from app.schemas.uploads import (
    UploadInitRequest,
    UploadInitResponse,
    UploadCompleteRequest,
    UploadCompleteResponse,
    UploadResponse,
    get_upload_subfolder,
)
from app.services.minio_service import get_minio_service, PART_SIZE
from app.services.celery_service import dispatch_training_task

router = APIRouter(prefix="/uploads", tags=["uploads"])

# 사용자당 업로드 제한 (개수 / 총 용량)
MAX_UPLOADS_PER_USER = 100
MAX_STORAGE_PER_USER = 200 * 1024 * 1024 * 1024  # 200 GB


def _module_folder(module_id: str, module_name: str) -> str:
    return f"{module_id}_{module_name}"


def _module_base_path(building_id: str, floor_id: str, module_id: str, module_name: str) -> str:
    return f"buildings/{building_id}/{floor_id}/modules/{_module_folder(module_id, module_name)}"


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

    # 모듈 조회 및 계층 검증
    result = await db.execute(
        select(Module)
        .join(Floor, Module.floor_id == Floor.id)
        .join(Building, Floor.building_id == Building.id)
        .where(
            Module.id == body.module_id,
            Floor.id == body.floor_id,
            Building.id == body.building_id,
        )
    )
    module = result.scalar_one_or_none()
    if module is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="building_id / floor_id / module_id 조합이 유효하지 않습니다.",
        )

    # 업로드 서브폴더 결정
    subfolder = get_upload_subfolder(body.filename, body.ply_target or "gsplat")

    # MinIO 오브젝트 키 생성 — UUID 기반 (원본 파일명은 DB에만 저장)
    ext = os.path.splitext(body.filename)[1].lower()
    unique_name = f"{uuid4()}{ext}"
    base_path = _module_base_path(
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

    upload.status = UploadStatus.processing

    # 학습 없이 바로 완료 처리할 케이스
    #  - PLY + alignment 타겟 (정합용 ply)
    #  - PLY + refined 타겟 (다듬기 결과 ply)
    #  - .splat / .sog (이미 학습 완료된 산출물)
    ext = os.path.splitext(upload.original_filename)[1].lower()
    is_ply = ext == ".ply"
    is_scene_artifact = ext in {".splat", ".sog"}
    skip_training = (
        (is_ply and upload.ply_target in (PlyTarget.alignment, PlyTarget.refined))
        or is_scene_artifact
    )

    if skip_training:
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

    # PLY + alignment 타겟이면 별도 처리 없이 완료
    celery_task_id = None
    if not skip_training:
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
        status=TaskStatus.completed if skip_training else TaskStatus.pending,
    )
    db.add(task)

    await db.commit()

    if skip_training:
        if is_scene_artifact or upload.ply_target == PlyTarget.refined:
            msg = "업로드 완료. refined 폴더에 저장되었습니다."
        else:
            msg = "업로드 완료. alignment 폴더에 저장되었습니다."
    else:
        msg = "업로드 완료. 3DGS 학습이 시작됩니다."

    return UploadCompleteResponse(
        upload_id=upload.id,
        status="processing" if not skip_training else "completed",
        message=msg,
    )


@router.get("", response_model=list[UploadResponse])
async def list_uploads(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """내 업로드 목록 조회"""
    result = await db.execute(
        select(Upload)
        .where(Upload.user_id == user.id)
        .order_by(Upload.uploaded_at.desc())
    )
    return result.scalars().all()


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

    return upload


VIEWABLE_EXTENSIONS = {".ply", ".splat", ".sog"}


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

    ext = os.path.splitext(upload.original_filename)[1].lower()
    if ext not in VIEWABLE_EXTENSIONS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="뷰어를 지원하지 않는 파일 형식입니다.")

    minio = get_minio_service()

    # refined 버전 요청 시, 스토리지에 정제 파일이 있으면 그것을 반환
    if variant == "refined":
        base_dir = os.path.dirname(upload.minio_path)
        refined_key = f"{base_dir}/refined/{upload.id}_refined.ply"
        if minio.object_exists(refined_key):
            url = minio.get_presigned_download_url(refined_key)
            return {"url": url, "filename": upload.original_filename, "variant": "refined"}

    url = minio.get_presigned_download_url(upload.minio_path)
    return {"url": url, "filename": upload.original_filename, "variant": "original"}
