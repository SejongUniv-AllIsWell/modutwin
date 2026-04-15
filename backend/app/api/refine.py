"""
가우시안 정제(refine) API.

단일 평면 기준으로 clip + align 처리 후 결과 presigned URL 반환.
"""

import os
import tempfile
from uuid import UUID

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import User, Upload, Task, SceneOutput, TaskType, TaskStatus
from app.services.minio_service import get_minio_service

router = APIRouter(prefix="/refine", tags=["refine"])


class PlaneData(BaseModel):
    normal: list[float]   # [nx, ny, nz]
    d: float


class AlignRequest(BaseModel):
    upload_id: UUID
    source_key: str | None = None    # 이전 정제 결과의 MinIO key (없으면 원본 사용)
    plane: PlaneData
    thickness: float = 0.05


class AlignResponse(BaseModel):
    url: str             # presigned download URL
    source_key: str      # 다음 호출 시 사용할 MinIO key


@router.post("/align", response_model=AlignResponse)
async def align_to_plane(
    body: AlignRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    단일 평면 기준으로 가우시안을 정렬한다.

    1. source_key가 있으면 해당 파일, 없으면 upload의 원본 파일 사용
    2. clip (바깥 가우시안 삭제) + align (벽면 스냅/flatten/회전/SH/opacity)
    3. 결과를 MinIO에 저장하고 presigned URL 반환
    """
    import numpy as np
    from core.refine_module.clip import clip_single_plane
    from core.refine_module.flat_opaque import align_single_plane

    # 원본 업로드 조회
    result = await db.execute(
        select(Upload).where(Upload.id == body.upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    minio = get_minio_service()

    # 소스 파일 결정
    source_key = body.source_key or upload.minio_path
    if not minio.object_exists(source_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="소스 파일을 찾을 수 없습니다.")

    normal = np.array(body.plane.normal, dtype=np.float64)
    d = body.plane.d

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = os.path.join(tmpdir, "input.ply")
            clipped_path = os.path.join(tmpdir, "clipped.ply")
            output_path = os.path.join(tmpdir, "output.ply")

            # 다운로드
            minio.download_to_file(source_key, input_path)

            # 1) clip: 바깥 가우시안 중 thickness 초과 거리 삭제
            clip_single_plane(input_path, normal, d, clipped_path, body.thickness)
            # 2) align: 남은 바깥 가우시안을 평면에 수직투영
            align_single_plane(clipped_path, normal, d, output_path)

            # 결과 업로드
            base_dir = os.path.dirname(upload.minio_path)
            result_key = f"{base_dir}/refined/{upload.id}_refined.ply"
            minio.upload_from_file(result_key, output_path)

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"정제 처리 실패: {str(e)}",
        )

    # presigned URL 반환
    url = minio.get_presigned_download_url(result_key, expires=3600)

    return AlignResponse(url=url, source_key=result_key)


class FlattenRequest(BaseModel):
    upload_id: UUID
    source_key: str | None = None
    action: Literal["project", "remove"]
    surfaces: list[str]   # subset of ["ceiling","floor","w1a","w1b","w2a","w2b"]
    angle_deg: float
    walls: list[float]    # [a1, b1, a2, b2]
    ceiling_y: float
    floor_y: float
    offsets: dict[str, float] | None = None   # per-surface safety margin (meters)


# 투영 시 벽면보다 약간 바깥쪽에 붙여 사용자가 라인을 벽에 딱 맞춘 경우 대비
SAFETY_MARGIN = 0.15
# 벽에서 이 거리 초과 바깥 가우시안은 투영하지 않고 삭제 (outlier pile-up 방지)
PROJECT_FAR_CLIP = 0.5
# 벽 라인은 보통 히스토그램 피크(벽면 본체) 위에 있으므로, 이 거리 이내 바깥 가우시안은
# 실제 벽면으로 간주하여 투영/삭제하지 않고 보호
NEAR_PROTECT = 0.03


def _surface_plane(
    surface: str, angle_deg: float, walls: list[float], ceiling_y: float, floor_y: float,
):
    """Return (normal_outward, d) such that points outside room have normal·x > d."""
    import math
    a1, b1, a2, b2 = walls
    rad = math.radians(angle_deg)
    c, s = math.cos(rad), math.sin(rad)
    if surface == "ceiling":
        return [0.0, 1.0, 0.0], float(ceiling_y)
    if surface == "floor":
        return [0.0, -1.0, 0.0], -float(floor_y)
    if surface == "w1a":
        return [-c, 0.0, -s], -float(a1)
    if surface == "w1b":
        return [c, 0.0, s], float(b1)
    if surface == "w2a":
        return [s, 0.0, -c], -float(a2)
    if surface == "w2b":
        return [-s, 0.0, c], float(b2)
    raise ValueError(f"Unknown surface: {surface}")


@router.post("/flatten", response_model=AlignResponse)
async def flatten_surfaces(
    body: FlattenRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    선택된 경계면(천장/바닥/4벽)에 대해 바깥 가우시안을 투영 또는 제거.

    - action='project': 각 면별로 PROJECT_FAR_CLIP 이내 바깥 가우시안을 면 + SAFETY_MARGIN으로 납작 투영
    - action='remove':  각 면 바깥 가우시안을 전부 삭제 (통유리 등)
    """
    import numpy as np
    from core.refine_module.clip import clip_single_plane
    from core.refine_module.flat_opaque import align_single_plane

    result = await db.execute(
        select(Upload).where(Upload.id == body.upload_id, Upload.user_id == user.id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="업로드를 찾을 수 없습니다.")

    if not body.surfaces:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="선택된 경계면이 없습니다.")

    minio = get_minio_service()
    source_key = body.source_key or upload.minio_path
    if not minio.object_exists(source_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="소스 파일을 찾을 수 없습니다.")

    # ── 방 중심 C (원근 투영 기준점) ──
    # 회전된 프레임 기준 직육면체 중심 → 월드 좌표로 역회전
    import math
    _rad = math.radians(body.angle_deg)
    _c, _s = math.cos(_rad), math.sin(_rad)
    _a1, _b1, _a2, _b2 = body.walls
    _rx_center = (_a1 + _b1) / 2
    _rz_center = (_a2 + _b2) / 2
    _cx = _rx_center * _c - _rz_center * _s
    _cz = _rx_center * _s + _rz_center * _c
    _cy = (body.ceiling_y + body.floor_y) / 2
    room_center = np.array([_cx, _cy, _cz], dtype=np.float64)

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            current_path = os.path.join(tmpdir, "step_0.ply")
            minio.download_to_file(source_key, current_path)

            for i, surf in enumerate(body.surfaces):
                normal, d = _surface_plane(
                    surf, body.angle_deg, body.walls, body.ceiling_y, body.floor_y,
                )
                normal_np = np.array(normal, dtype=np.float64)
                next_path = os.path.join(tmpdir, f"step_{i + 1}.ply")

                offset = (body.offsets or {}).get(surf, SAFETY_MARGIN)

                if body.action == "remove":
                    # thickness=0 → 바깥 전부 삭제 (단, NEAR_PROTECT 이내 벽면 본체는 보호)
                    clip_single_plane(
                        current_path, normal_np, d, next_path,
                        thickness=0.0, near_protect=NEAR_PROTECT,
                    )
                else:
                    # 투영: 먼 outlier는 먼저 잘라내고, 남은 바깥을 d+offset 평면에 스냅
                    # NEAR_PROTECT 이내 벽면 본체는 clip/align 모두에서 보호
                    clipped_path = os.path.join(tmpdir, f"clip_{i}.ply")
                    clip_single_plane(
                        current_path, normal_np, d, clipped_path,
                        thickness=PROJECT_FAR_CLIP, near_protect=NEAR_PROTECT,
                    )
                    align_single_plane(
                        clipped_path, normal_np, d + offset, next_path,
                        near_protect=NEAR_PROTECT,
                        center=room_center,   # 방 중심에서 원근 투영
                    )

                current_path = next_path

            base_dir = os.path.dirname(upload.minio_path)
            result_key = f"{base_dir}/refined/{upload.id}_flattened.ply"
            minio.upload_from_file(result_key, current_path)

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"경계면 처리 실패: {str(e)}",
        )

    url = minio.get_presigned_download_url(result_key, expires=3600)
    return AlignResponse(url=url, source_key=result_key)


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

    # 정제 파일 존재 확인
    minio = get_minio_service()
    if not minio.object_exists(body.source_key):
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
        ply_path=body.source_key,
        sog_path=body.source_key,   # PLY도 뷰어에서 로드 가능
        is_aligned=False,
    )
    db.add(scene)
    await db.commit()

    return SaveResponse(scene_id=scene.id, message="정제 결과가 저장되었습니다.")
