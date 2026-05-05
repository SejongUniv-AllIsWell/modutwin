"""
가우시안 정제(refine) API.

클라이언트에서 처리한 PLY를 올릴 수 있는 presigned URL 발급과
최종 정제 결과를 SceneOutput에 기록하는 엔드포인트를 제공.

실제 정제 연산(clip/flatten/align)은 전부 클라이언트에서 수행하므로
서버는 릴레이 역할만 한다.
"""

import json
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.storage_keys import is_key_under_prefix, normalize_minio_key
from app.models import User, Upload, Task, SceneOutput, TaskType, TaskStatus
from app.services.minio_service import get_minio_service
from app.services.storage_paths import (
    build_refined_object_key,
    mesh_meta_key,
    refined_prefix,
    session_dir_from_scene_key,
    session_file_key,
)

router = APIRouter(prefix="/refine", tags=["refine"])


class RefinedUploadUrlRequest(BaseModel):
    upload_id: UUID
    filename: str = "refined.ply"
    # 같은 정제 세션 (PLY + mesh.json + 텍스처 PNG 6장 등) 을 한 디렉토리에 묶기 위한 ID.
    # 미지정 시 timestamp prefix 방식 (레거시 호환).
    session_id: Optional[str] = None


class RefinedUploadUrlResponse(BaseModel):
    put_url: str
    get_url: str
    key: str


@router.post("/refined-upload-url", response_model=RefinedUploadUrlResponse)
async def refined_upload_url(
    body: RefinedUploadUrlRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """클라이언트가 정제한 PLY/메시 메타/텍스처 PNG 를 직접 업로드할 presigned PUT/GET URL 발급.

    session_id 지정 시 `refined/{session_id}/{filename}` 경로 (한 세션의 파일들이 한 디렉토리).
    미지정 시 `refined/{timestamp}_{filename}` (레거시).
    """
    result = await db.execute(
        select(Upload).where(Upload.id == body.upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    try:
        key = build_refined_object_key(
            upload_minio_path=upload.minio_path,
            filename=body.filename,
            session_id=body.session_id,
        )
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="유효하지 않은 session_id")

    minio = get_minio_service()
    return RefinedUploadUrlResponse(
        put_url=minio.get_presigned_simple_upload_url(key, expires=3600),
        get_url=minio.get_presigned_download_url(key, expires=3600),
        key=key,
    )


class SaveRequest(BaseModel):
    upload_id: UUID
    source_key: str      # 최종 정제된 PLY의 MinIO key


class SaveResponse(BaseModel):
    scene_id: UUID
    message: str


@router.post("/save", response_model=SaveResponse)
async def save_refined(
    body: SaveRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    정제 결과를 확정하여 SceneOutput으로 저장한다.
    이후 문 정합 등에서 이 씬을 사용할 수 있다.
    """
    from datetime import datetime, timezone

    # 업로드 조회
    result = await db.execute(
        select(Upload).where(Upload.id == body.upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    try:
        source_key = normalize_minio_key(body.source_key)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="유효하지 않은 source_key 입니다.")

    upload_refined_prefix = refined_prefix(upload.minio_path)
    if not is_key_under_prefix(source_key, upload_refined_prefix):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="source_key 는 업로드의 refined 경로 하위여야 합니다.",
        )

    # 정제 파일 존재 확인
    minio = get_minio_service()
    if not minio.object_exists(source_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="정제 파일을 찾을 수 없습니다.")

    # Task 생성 (정제 완료 상태)
    task = Task(
        upload_id=upload.id,
        user_id=user.id,
        task_type=TaskType.door_alignment,
        status=TaskStatus.completed,
        progress=100,
        completed_at=datetime.now(timezone.utc),
    )
    db.add(task)
    await db.flush()

    # SceneOutput 생성
    scene = SceneOutput(
        task_id=task.id,
        user_id=user.id,
        module_id=upload.module_id,
        ply_path=source_key,
        sog_path=source_key,   # PLY도 뷰어에서 로드 가능
        is_aligned=False,
    )
    db.add(scene)
    await db.commit()

    return SaveResponse(scene_id=scene.id, message="정제 결과가 저장되었습니다.")


class RefinedBundleResponse(BaseModel):
    ply_url: str
    mesh_meta_url: Optional[str]
    textures: dict[str, str]  # surfaceId → presigned URL
    scene_id: UUID


@router.get("/refined-bundle", response_model=RefinedBundleResponse)
async def get_refined_bundle(
    upload_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """upload_id 의 가장 최근 정제 결과 (PLY + mesh.json + 텍스처 PNG들) presigned URL 일괄 반환.

    align/base 뷰어에서 정제된 모듈을 로드할 때 사용.
    """
    # 가장 최근 SceneOutput 조회 (해당 upload + 사용자 소유)
    result = await db.execute(
        select(SceneOutput)
        .join(Task, SceneOutput.task_id == Task.id)
        .where(Task.upload_id == upload_id, SceneOutput.user_id == user.id)
        .order_by(SceneOutput.created_at.desc())
        .limit(1)
    )
    scene = result.scalar_one_or_none()
    if not scene:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="정제 결과가 없습니다.")

    minio = get_minio_service()
    if not minio.object_exists(scene.ply_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PLY 파일을 찾을 수 없습니다.")

    ply_url = minio.get_presigned_download_url(scene.ply_path)

    # 같은 디렉토리에서 mesh.json 찾기 (있으면 텍스처 URL 도 같이)
    session_dir = session_dir_from_scene_key(scene.ply_path)
    mesh_meta_object_key = mesh_meta_key(session_dir)
    mesh_meta_url: Optional[str] = None
    textures: dict[str, str] = {}
    if minio.object_exists(mesh_meta_object_key):
        mesh_meta_url = minio.get_presigned_download_url(mesh_meta_object_key)
        try:
            content = minio.get_object_bytes(mesh_meta_object_key)
            meta = json.loads(content.decode("utf-8"))
            for surface in meta.get("surfaces", []):
                tex_filename = surface.get("textureFilename")
                surface_id = surface.get("surfaceId")
                if tex_filename and surface_id:
                    tex_key = session_file_key(session_dir, tex_filename)
                    if minio.object_exists(tex_key):
                        textures[surface_id] = minio.get_presigned_download_url(tex_key)
        except Exception as e:
            # mesh.json 파싱 실패해도 PLY 는 반환
            print(f"[refined-bundle] mesh.json parse failed: {e}")

    return RefinedBundleResponse(
        ply_url=ply_url,
        mesh_meta_url=mesh_meta_url,
        textures=textures,
        scene_id=scene.id,
    )
