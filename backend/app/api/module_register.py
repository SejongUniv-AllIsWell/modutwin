"""모듈 등록 새 흐름 — 정합 완료 시점에 모든 영속을 일괄 처리.

새 흐름 (Phase 1-2 refactor):
- 파일 선택 시: PLY 를 백엔드 임시 보관소(/var/lib/sam3-temp)에 백그라운드 업로드 → `POST /uploads/sam3/prepare`.
- 자동 문 검출 시: 임시 보관소 PLY 를 door-ml 로 forward, 결과만 반환 → `POST /uploads/sam3/detect-temp`.
- 정합 완료 시: 다듬기 결과 PLY + mesh + tex + doors + alignment_transform 을 일괄 영속화 → `POST /uploads/commit-final`.

기존 흐름의 register-local / refined-upload-url / sam3/start 는 그대로 두고 (basemap 등록 흐름 등에서 사용),
모듈 등록 흐름에서만 본 파일의 엔드포인트를 사용.

⚠️ 주의: 같은 사용자가 같은 호수 재등록 시 기존 modules 행을 재사용하고 옛 uploads/tasks/scene_outputs +
MinIO 객체를 삭제(덮어쓰기). 다른 사용자의 모듈은 영향 없음.
"""
from __future__ import annotations

import json
import logging
import math
import os
import time
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import and_, delete as sa_delete, select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import get_current_user
from app.models import (
    Building, Floor, Module, SceneOutput, Task, Upload, User, UserRole,
    PlyTarget, UploadStatus, TaskType, TaskStatus,
)
from app.services.minio_service import get_minio_service
from app.services.sam3_temp_storage import (
    delete_temp, is_expired, new_session_id, temp_path,
)
from app.services.storage_paths import module_base_path

router = APIRouter(prefix="/uploads", tags=["module-register"])
settings = get_settings()
logger = logging.getLogger(__name__)


# ── 1. SAM3 임시 PLY 업로드 (파일 선택 직후 백그라운드) ────────────────────────

class Sam3PrepareResponse(BaseModel):
    session_id: str
    size: int


@router.post("/sam3/prepare", response_model=Sam3PrepareResponse)
async def sam3_prepare(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """PLY 파일을 백엔드 임시 디스크에 보관. 추후 detect-temp 가 사용.

    영구 저장 X. DB 행 만들지 않음. 30분 후 자동 청소.
    """
    sid = new_session_id()
    path = temp_path(sid)
    path.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with open(path, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)  # 1MB 청크 스트리밍
                if not chunk:
                    break
                out.write(chunk)
                size += len(chunk)
    except Exception as e:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"임시 보관 실패: {e}")
    if size == 0:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
        raise HTTPException(status_code=400, detail="빈 파일")
    return Sam3PrepareResponse(session_id=sid, size=size)


# ── 2. SAM3 자동 문 검출 (door-ml forward) ────────────────────────────────────

class BakeRotation(BaseModel):
    rotX: float = 0.0
    rotZ: float = 0.0
    wallAngleRad: float = 0.0


class Sam3DetectTempRequest(BaseModel):
    session_id: str
    prompt: str = "door"
    bake_rotation: BakeRotation | None = None


class Sam3DetectTempResponse(BaseModel):
    corners: dict


def _apply_bake_rotation_to_corner(c: dict, rot_x: float, rot_z: float, wall_angle_rad: float) -> dict:
    """원본 좌표계 corner ({x,y,z}) → refined 좌표계 (A'+Y).

    sam3_door_ml.py 의 _apply_bake_rotation 과 동일한 식 (CLAUDE.md 의 A→A'→A'+Y 변환).
    """
    x0, y0, z0 = float(c["x"]), float(c["y"]), float(c["z"])
    rcx = math.cos(rot_x); rsx = math.sin(rot_x)
    rcz = math.cos(rot_z); rsz = math.sin(rot_z)
    # A → A' (rotX then rotZ — useRefineTool rotateScene 와 동일)
    x1 = rcz * x0 - rsz * rcx * y0 + rsz * rsx * z0
    y1 = rsz * x0 + rcz * rcx * y0 - rcz * rsx * z0
    z1 = rsx * y0 + rcx * z0
    # A' → A'+Y (Y axis rotation by wall_angle_rad)
    c_y = math.cos(wall_angle_rad); s_y = math.sin(wall_angle_rad)
    x2 = c_y * x1 + s_y * z1
    y2 = y1
    z2 = -s_y * x1 + c_y * z1
    return {"x": x2, "y": y2, "z": z2}


@router.post("/sam3/detect-temp", response_model=Sam3DetectTempResponse)
async def sam3_detect_temp(
    body: Sam3DetectTempRequest,
    user: User = Depends(get_current_user),
):
    """임시 보관 PLY → door-ml 검출 → bake rotation 적용 → corners 반환.

    DB 행 안 만듦, MinIO 안 건드림. 임시 PLY 파일은 호출 후 삭제하지 않음
    (사용자가 다시 시도하거나 prompt 바꿔 재호출 가능. TTL 로 자동 청소.)
    """
    p = temp_path(body.session_id)
    if not p.exists() or is_expired(p):
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="임시 PLY 가 만료되었거나 없습니다. 파일을 다시 선택해 주세요.",
        )

    # door-ml 으로 forward.
    try:
        with open(p, "rb") as f:
            ply_bytes = f.read()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"임시 PLY 읽기 실패: {e}")

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(
                f"{settings.DOOR_ML_URL}/detect",
                files={"file": ("scene.ply", ply_bytes, "application/octet-stream")},
                params={"prompt": body.prompt or "door", "sam3_prob": 0.55},
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"door-ml 통신 실패: {e}")

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"door-ml HTTP {resp.status_code}: {resp.text[:300]}",
        )

    corners = resp.json()
    required = ("left_top", "right_top", "right_bottom", "left_bottom")
    if not all(k in corners for k in required):
        raise HTTPException(status_code=502, detail=f"door-ml 응답 형식 오류: keys={list(corners.keys())}")

    if body.bake_rotation:
        br = body.bake_rotation
        corners = {
            k: _apply_bake_rotation_to_corner(corners[k], br.rotX, br.rotZ, br.wallAngleRad)
            for k in required
        }

    return Sam3DetectTempResponse(corners=corners)


# ── 3. 정합 완료 — 일괄 영속화 ────────────────────────────────────────────────

class AlignmentTransformDTO(BaseModel):
    position: list[float]  # [x, y, z]
    rotation: list[float]  # [qx, qy, qz, qw]
    scale: list[float] = [1.0, 1.0, 1.0]
    rmsd: float | None = None
    matches: list[dict] | None = None


class CommitFinalResponse(BaseModel):
    module_id: UUID
    upload_id: UUID
    scene_output_id: UUID
    was_overwrite: bool


# N벽 일반화 — 텍스처 키는 ceiling/floor + 폴리곤 변 수만큼의 w0..w(N-1) (동적).
# multipart form 에서 'tex_' prefix 의 모든 키를 동적으로 수집한다.
import re as _re

REQUIRED_TEXTURE_KEYS = ("ceiling", "floor")
_WALL_KEY_RE = _re.compile(r"^w\d+$")


@router.post("/commit-final", response_model=CommitFinalResponse)
async def commit_final(
    request: Request,
    building_id: UUID = Form(...),
    floor_id: UUID = Form(...),
    module_name: str = Form(...),
    original_filename: str = Form(...),
    alignment_transform_json: str = Form(...),
    final_ply: UploadFile = File(...),
    mesh_json: UploadFile = File(...),
    doors_json: UploadFile = File(...),
    sam3_session_id: str | None = Form(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """정합 완료 시점 일괄 영속화.

    - 같은 사용자가 같은 호수 재등록 시: 기존 module 재사용 + 기존 자산 삭제(덮어쓰기).
    - 다른 사용자가 같은 호수: 별개 module 신규 생성.
    - 영속 자산: final.ply + mesh.json + tex_*.png 6장 + doors.json + alignment_transform.
    - 'aligned.ply' 는 저장 안 함 (final.ply + alignment_transform 로 재계산 가능).
    """
    module_name = (module_name or "").strip()
    if not module_name:
        raise HTTPException(status_code=400, detail="module_name 이 비었습니다.")

    # alignment_transform JSON 파싱/검증
    try:
        at_dict = json.loads(alignment_transform_json)
        at = AlignmentTransformDTO.model_validate(at_dict)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"alignment_transform 형식 오류: {e}")
    if len(at.position) != 3 or len(at.rotation) != 4 or len(at.scale) != 3:
        raise HTTPException(status_code=400, detail="alignment_transform position/rotation/scale 형식 오류.")

    # ── 동적 텍스처 키 수집 — 'tex_<surfaceId>' 패턴 ──
    # ceiling/floor 필수 + w0..w(N-1) 폴리곤 변 수만큼. multipart form 한 번 읽음 (cached).
    form = await request.form()
    tex_uploads: dict[str, UploadFile] = {}
    for key, value in form.multi_items():
        if not key.startswith("tex_"):
            continue
        sid = key[len("tex_"):]
        if not (sid in REQUIRED_TEXTURE_KEYS or _WALL_KEY_RE.match(sid)):
            continue
        if not hasattr(value, "read") or not hasattr(value, "filename"):
            continue
        tex_uploads[sid] = value  # type: ignore[assignment]
    missing = [k for k in REQUIRED_TEXTURE_KEYS if k not in tex_uploads]
    if missing:
        raise HTTPException(status_code=400, detail=f"필수 텍스처 누락: {missing}")
    if not any(_WALL_KEY_RE.match(k) for k in tex_uploads):
        raise HTTPException(status_code=400, detail="벽 텍스처(w0..) 가 하나 이상 필요합니다.")

    # 건물/층 검증 (building_id, floor_id 정합성)
    fres = await db.execute(
        select(Floor).where(Floor.id == floor_id, Floor.building_id == building_id)
    )
    floor = fres.scalar_one_or_none()
    if floor is None:
        raise HTTPException(status_code=404, detail="floor/building 조합이 유효하지 않습니다.")

    # 같은 사용자·층·이름 모듈 lookup (덮어쓰기 후보)
    mres = await db.execute(
        select(Module).where(
            Module.floor_id == floor_id,
            Module.user_id == user.id,
            Module.name == module_name,
        )
    )
    existing_module: Module | None = mres.scalar_one_or_none()
    was_overwrite = existing_module is not None

    minio = get_minio_service()

    # ── 덮어쓰기 처리: 옛 uploads/tasks/scene_outputs + MinIO 객체 정리 ──
    if existing_module is not None:
        # 옛 uploads 모두 가져와 MinIO prefix 청소
        old_uploads = (await db.execute(
            select(Upload).where(Upload.module_id == existing_module.id)
        )).scalars().all()
        old_upload_ids = [u.id for u in old_uploads]

        # MinIO: 옛 module_base_path 하위 전부 삭제
        try:
            base = module_base_path(
                str(building_id), str(floor_id), str(existing_module.id), existing_module.name,
            )
            minio.delete_prefix(base)
        except Exception as e:
            logger.exception(f"[commit-final] MinIO 옛 객체 삭제 실패: {e}")

        # 옛 scene_outputs → tasks → uploads 순으로 삭제
        if old_upload_ids:
            await db.execute(sa_delete(SceneOutput).where(SceneOutput.module_id == existing_module.id))
            await db.execute(sa_delete(Task).where(Task.upload_id.in_(old_upload_ids)))
            await db.execute(sa_delete(Upload).where(Upload.id.in_(old_upload_ids)))

        module = existing_module
    else:
        module = Module(floor_id=floor_id, user_id=user.id, name=module_name)
        db.add(module)
        await db.flush()  # module.id 확보

    # ── MinIO 키 계산 ──
    base = module_base_path(str(building_id), str(floor_id), str(module.id), module.name)
    # 원본 PLY 경로 (placeholder — 실제 원본은 안 올림. register-local 와 동일 관례)
    ext = os.path.splitext(original_filename)[1].lower() or ".ply"
    placeholder_key = f"{base}/alignment/{uuid4()}_local{ext}"
    # refined 세션 폴더
    refined_session = f"s{int(time.time() * 1000)}"
    refined_dir = f"{base}/alignment/refined/{refined_session}"
    final_ply_key = f"{refined_dir}/final.ply"
    mesh_key = f"{refined_dir}/mesh.json"
    doors_key = f"{base}/alignment/refined/doors.json"  # CLAUDE.md 규약과 일관 (doors 는 refined 디렉터리 직속)
    tex_keys = {tid: f"{refined_dir}/tex_{tid}.png" for tid in tex_uploads.keys()}

    # ── Upload 행 생성 ──
    final_ply_bytes = await final_ply.read()
    upload = Upload(
        user_id=user.id,
        module_id=module.id,
        original_filename=original_filename,
        file_size=len(final_ply_bytes),  # 다듬기 결과 PLY 기준
        content_type="application/octet-stream",
        minio_path=placeholder_key,
        ply_target=PlyTarget.alignment,
        status=UploadStatus.completed,
        sam3_status=None,  # 새 흐름에선 임시 검출이라 dispatch 안 함
    )
    db.add(upload)
    await db.flush()

    # ── MinIO 업로드 (final.ply + mesh.json + tex_*.png + doors.json) ──
    try:
        minio.put_object_bytes(final_ply_key, final_ply_bytes, "application/octet-stream")

        mesh_bytes = await mesh_json.read()
        minio.put_object_bytes(mesh_key, mesh_bytes, "application/json")

        doors_bytes = await doors_json.read()
        minio.put_object_bytes(doors_key, doors_bytes, "application/json")

        for tid, f in tex_uploads.items():
            data = await f.read()
            minio.put_object_bytes(tex_keys[tid], data, "image/png")
    except Exception as e:
        # 부분 실패 — 이미 일부 객체가 올라갔을 수 있어 정리 시도.
        try:
            minio.delete_prefix(base)
        except Exception:
            pass
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"MinIO 업로드 실패: {e}")

    # ── Task + SceneOutput 생성 ──
    now = datetime.now(timezone.utc)
    task = Task(
        upload_id=upload.id,
        user_id=user.id,
        task_type=TaskType.door_alignment,
        status=TaskStatus.completed,
        completed_at=now,
    )
    db.add(task)
    await db.flush()

    scene_output = SceneOutput(
        task_id=task.id,
        user_id=user.id,
        module_id=module.id,
        ply_path=final_ply_key,
        # SceneOutput.sog_path 는 NOT NULL — SOG 변환 결과가 없을 땐 PLY 키를 그대로 채워
        # 뷰어 fallback (sog → ply) 가 동일 객체를 가리키게 한다 (refine.py 와 동일 관례).
        sog_path=final_ply_key,
        is_aligned=True,
    )
    db.add(scene_output)
    await db.flush()

    # ── Module 정합 정보 갱신 ──
    module.alignment_transform = {
        "transform": {
            "position": at.position,
            "rotation": at.rotation,
            "scale": at.scale,
        },
        "rmsd": at.rmsd,
        "matches": at.matches or [],
        "saved_at": now.isoformat(),
    }
    module.is_confirmed = True

    # Floor overview 재계산 플래그
    await db.execute(
        sa_update(Floor).where(Floor.id == floor_id).values(overview_dirty=True)
    )

    # Upload 행에 정합 정보 저장 (DoorAlignModal.applyAndSave 의 기존 /uploads/{id}/alignment 와 동등)
    upload.alignment_transform = {
        "transform": {
            "position": at.position,
            "rotation": at.rotation,
            "scale": at.scale,
        },
        "rmsd": at.rmsd,
        "matches": at.matches or [],
        "saved_at": now.isoformat(),
    }

    await db.commit()

    # SAM3 임시 PLY 삭제 (있으면)
    if sam3_session_id:
        try:
            delete_temp(sam3_session_id)
        except Exception:
            pass

    return CommitFinalResponse(
        module_id=module.id,
        upload_id=upload.id,
        scene_output_id=scene_output.id,
        was_overwrite=was_overwrite,
    )
