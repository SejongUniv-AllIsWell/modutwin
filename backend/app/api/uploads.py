import json
import math
import os
import re
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import (
    User, UserRole, Upload, Task, Module, Floor, Building, SceneOutput,
    UploadStatus, TaskType, TaskStatus, PlyTarget, Sam3Status,
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
from app.services.celery_service import (
    dispatch_training_task,
    dispatch_sam3_door_detection_task,
)

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


def _upload_to_response(upload: Upload, has_scene_output: bool = False) -> UploadResponse:
    """Upload ORM → UploadResponse (SAM3 파이프라인 파생 플래그 포함).

    has_refined: SAM3 정식 경로 (refined_ply_path) 또는 다듬기 저장으로 생성된 SceneOutput 중 하나라도 있으면 true.
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
        has_alignment=bool(upload.alignment_transform),
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
    return [_upload_to_response(u, has_scene_output=(u.id in has_scene)) for u in uploads]


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
    return _upload_to_response(upload, has_scene_output=has_scene)


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
    base_path = _module_base_path(
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


# refined PLY: 클라이언트가 /refine/refined-upload-url 로 단일 PUT 업로드 한 후,
# 이 엔드포인트를 호출해 canonical refined_ply_path 등록 + SAM3 task 발행.
class Sam3StartRequest(BaseModel):
    refined_ply_key: str   # MinIO key
    prompt: str = ""


class Sam3StartResponse(BaseModel):
    upload_id: UUID
    sam3_status: str
    celery_task_id: str | None


def _doors_json_minio_key(upload: Upload) -> str:
    base_dir = os.path.dirname(upload.minio_path)
    return f"{base_dir}/refined/doors.json"


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

    minio = get_minio_service()
    if not minio.object_exists(body.refined_ply_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="refined PLY 가 MinIO 에 없습니다.")

    # refined PLY 가 사용자/업로드 본인 디렉토리 아래에 있는지 약식 확인 (path traversal 방지).
    base_dir = os.path.dirname(upload.minio_path)
    if not body.refined_ply_key.startswith(base_dir + "/"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="refined_ply_key 가 업로드 디렉토리 밖입니다.")

    upload.refined_ply_path = body.refined_ply_key
    upload.sam3_prompt = (body.prompt or "").strip() or None
    upload.sam3_status = Sam3Status.pending

    # 모듈/계층 정보 (SAM3 task 페이로드용)
    mod_q = await db.execute(
        select(Module, Floor).join(Floor, Module.floor_id == Floor.id)
        .where(Module.id == upload.module_id)
    )
    mod, floor = mod_q.one()

    celery_task_id: str | None = None
    try:
        celery_task_id = dispatch_sam3_door_detection_task(
            upload_id=str(upload.id),
            user_id=str(user.id),
            refined_ply_key=body.refined_ply_key,
            prompt=upload.sam3_prompt or "",
            building_id=str(floor.building_id),
            floor_id=str(floor.id),
            floor_number=floor.floor_number,
            module_id=str(mod.id),
            module_name=mod.name,
        )
        upload.sam3_status = Sam3Status.running
    except Exception as e:
        # broker/worker 비가용 — failed 로 두면 사용자가 정합 단계에서 수동 지정 가능.
        upload.sam3_status = Sam3Status.failed
        print(f"[sam3] dispatch failed: {e}")

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

class DoorEntry(BaseModel):
    """doors.json 의 한 문 엔트리.

    corners 외 나머지 메타 (회전축/회전각/회전방향/벽 surfaceId/두께/분할 옵션 등) 는
    문 설정 단계에서 사용자가 확정한 값. 정합·재진입·basemap 매칭 시 모두 활용되므로
    스키마에 명시해 라운드트립 시 손실되지 않게 한다.
    """
    id: str
    corners: list[list[float]]  # 4 × [x, y, z]
    hingeEdge: int | None = None
    swing: int | None = None
    angleDeg: float | None = None
    wallSurfaceId: str | None = None
    doorThickness: float | None = None
    boundarySplitEnabled: bool | None = None
    safetyMargin: float | None = None
    # basemap 등록 시 admin 이 각 문에 입력하는 호수 (예: "302호").
    # 정합 단계에서 모듈의 호수 (Module.name) 와 매칭해 basemap 의 어느 문에 정합할지 결정.
    # 모듈측 doors.json 에서는 보통 비어있음 (모듈은 단일 호라 호수 = Module.name 으로 자명).
    unitName: str | None = None


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
            entry = DoorEntry(
                id=str(d.get("id") or f"door_{len(clean)+1}"),
                corners=corners,
                hingeEdge=d.get("hingeEdge") if isinstance(d.get("hingeEdge"), int) else None,
                swing=d.get("swing") if isinstance(d.get("swing"), int) else None,
                angleDeg=d.get("angleDeg") if isinstance(d.get("angleDeg"), (int, float)) else None,
                wallSurfaceId=d.get("wallSurfaceId") if isinstance(d.get("wallSurfaceId"), str) else None,
                doorThickness=d.get("doorThickness") if isinstance(d.get("doorThickness"), (int, float)) else None,
                boundarySplitEnabled=d.get("boundarySplitEnabled") if isinstance(d.get("boundarySplitEnabled"), bool) else None,
                safetyMargin=d.get("safetyMargin") if isinstance(d.get("safetyMargin"), (int, float)) else None,
                unitName=d.get("unitName") if isinstance(d.get("unitName"), str) else None,
            )
            clean.append(entry)
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
    key = upload.door_corners_json_path or _doors_json_minio_key(upload)
    # exclude_none — 미입력 필드는 JSON 에 안 넣어 가독성 유지.
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


# ── 정합 결과 저장 (변환행렬 + basemap/door 매칭) ────────────────────────────

class AlignmentMatch(BaseModel):
    """모듈 문 ID(doors.json 의 id) ↔ basemap 의 매칭."""
    module_door_id: str
    basemap_id: str
    basemap_door_id: str | None = None  # basemap 측 문 식별자(있으면)


class AlignmentSaveRequest(BaseModel):
    transform: dict[str, Any]            # {position:[x,y,z], rotation:[x,y,z,w], scale:[x,y,z]}
    rmsd: float | None = None
    matches: list[AlignmentMatch] = Field(default_factory=list)


class AlignmentSaveResponse(BaseModel):
    upload_id: UUID
    saved_at: str


@router.post("/{upload_id}/alignment", response_model=AlignmentSaveResponse)
async def save_alignment(
    upload_id: UUID,
    body: AlignmentSaveRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """정합 결과(변환행렬 + 매칭 정보) 를 upload-scoped 로 저장."""
    from datetime import datetime, timezone

    result = await db.execute(
        select(Upload).where(Upload.id == upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    now = datetime.now(timezone.utc)
    upload.alignment_transform = {
        "transform": body.transform,
        "rmsd": body.rmsd,
        "matches": [m.model_dump() for m in body.matches],
        "saved_at": now.isoformat(),
    }
    await db.commit()
    return AlignmentSaveResponse(upload_id=upload.id, saved_at=now.isoformat())
