"""모듈 등록 흐름 — 정합 완료 시점에 모든 영속을 일괄 처리.

- 파일 선택 시: PLY 를 백엔드 임시 보관소(/var/lib/sam3-temp)에 백그라운드 업로드 → `POST /uploads/sam3/prepare`.
- 자동 문 검출 시: 임시 보관소 PLY 를 door-ml 로 forward, 결과만 반환 → `POST /uploads/sam3/detect-temp`.
- 정합 완료 시: 다듬기 결과 PLY + mesh + tex + doors + alignment_transform 을 일괄 영속화 → `POST /uploads/commit-final`.

register-local / refined-upload-url / sam3/start 는 basemap 등록 흐름 등에서 계속 사용한다.
모듈 등록은 이 파일의 prepare/detect-temp/commit-final 엔드포인트를 사용한다.

⚠️ 주의: 같은 사용자가 같은 호수 재등록 시 modules 행을 재사용하고 교체 대상
uploads/tasks/scene_outputs + MinIO 객체를 삭제(덮어쓰기). 다른 사용자의 모듈은 영향 없음.
"""
from __future__ import annotations

import json
import logging
import math
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
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
from app.core.storage_keys import is_key_under_prefix, normalize_minio_key
from app.models import (
    Building, Floor, Module, SceneOutput, Task, Upload, User, UserRole,
    PlyTarget, UploadStatus, TaskType, TaskStatus,
)
from app.services.celery_service import dispatch_sog_conversion_task
from app.services.minio_service import get_minio_service
from app.services.sam3_temp_storage import (
    delete_temp, is_expired, new_session_id, temp_path,
)
from app.services.storage_paths import module_base_path, object_dir

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
    session_id: str | None = None
    staging_key: str | None = None
    prompt: str = "door"
    bake_rotation: BakeRotation | None = None
    # Phase 1 interior gate 튜닝 (긴/비볼록 방에서 fail-fast 회피용). 미지정 시 파이프라인 기본값.
    interior_min_hits: int = 22
    interior_perp_ratio: float = 0.01
    interior_strict: bool = True
    # 방법 B — 다듬기 확정 천장/바닥 (A' 프레임) + raw→A' 회전(bakedRotation).
    # 4개 모두 주면 door-ml 이 A' 에서 추론하고 A' 코너를 반환 → 여기서 wallAngle 만 적용.
    floor_y: float | None = None
    ceiling_y: float | None = None
    rot_x: float | None = None
    rot_z: float | None = None
    # 방 footprint 폴리곤 (A' X-Z). 있으면 door-ml 이 벽-정면 카메라 커버리지 사용.
    wall_polygon: list[dict] | None = None


class Sam3DetectTempResponse(BaseModel):
    corners: dict           # 첫 번째(주) 문 코너 (backward compat)
    all_doors: list[dict] = []  # N-door: 모든 문 코너 목록


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


def _apply_wall_angle_to_corner(c: dict, wall_angle_rad: float) -> dict:
    """A' 프레임 corner → A'+Y. (방법 B: door-ml 이 이미 A' 로 반환하므로 Y회전만.)"""
    x1, y1, z1 = float(c["x"]), float(c["y"]), float(c["z"])
    c_y = math.cos(wall_angle_rad); s_y = math.sin(wall_angle_rad)
    return {"x": c_y * x1 + s_y * z1, "y": y1, "z": -s_y * x1 + c_y * z1}


def _is_known_room(body: "Sam3DetectTempRequest") -> bool:
    return (
        body.floor_y is not None and body.ceiling_y is not None
        and body.rot_x is not None and body.rot_z is not None
    )


def _detect_params(body: "Sam3DetectTempRequest") -> dict:
    """door-ml /detect 쿼리 파라미터. known-room 이면 A' 천장/바닥 전달."""
    params: dict = {
        "prompt": body.prompt or "door",
        "sam3_prob": 0.86,
        "interior_min_hits": body.interior_min_hits,
        "interior_perp_ratio": body.interior_perp_ratio,
        "interior_strict": body.interior_strict,
    }
    if _is_known_room(body):
        params.update({
            "rot_x": body.rot_x, "rot_z": body.rot_z,
            "floor_y": body.floor_y, "ceiling_y": body.ceiling_y,
        })
        if body.wall_polygon:
            params["wall_polygon"] = json.dumps(body.wall_polygon)
    return params


async def _post_door_ml_detect(p: Path, body: "Sam3DetectTempRequest", params_override: dict | None = None) -> httpx.Response:
    params = _detect_params(body)
    if params_override:
        params.update(params_override)
    with open(p, "rb") as f:
        async with httpx.AsyncClient(timeout=600.0) as client:
            return await client.post(
                f"{settings.DOOR_ML_URL}/detect",
                files={"file": ("scene.ply", f, "application/octet-stream")},
                params=params,
            )


@router.post("/sam3/detect-temp", response_model=Sam3DetectTempResponse)
async def sam3_detect_temp(
    body: Sam3DetectTempRequest,
    user: User = Depends(get_current_user),
):
    """임시 보관 PLY → door-ml 검출 → bake rotation 적용 → corners 반환.

    DB 행 안 만듦. session_id 경로의 임시 PLY 또는 staging_key 경로의 MinIO PLY 를
    사용한다. 입력 파일은 호출 후 삭제하지 않음(사용자가 다시 시도하거나 prompt 바꿔
    재호출 가능. 임시 PLY 는 TTL 로 자동 청소, staging PLY 는 commit-final 후 정리).
    """
    if bool(body.session_id) == bool(body.staging_key):
        raise HTTPException(status_code=400, detail="session_id 또는 staging_key 중 하나만 필요합니다.")

    p: Path | None = None
    staging_tmp_path: str | None = None
    if body.session_id:
        p = temp_path(body.session_id)
        if not p.exists() or is_expired(p):
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail="임시 PLY 가 만료되었거나 없습니다. 파일을 다시 선택해 주세요.",
            )
    else:
        try:
            staging_key = normalize_minio_key(body.staging_key or "")
        except ValueError:
            raise HTTPException(status_code=400, detail="유효하지 않은 staging_key 입니다.")
        if not is_key_under_prefix(staging_key, f"staging/{user.id}/"):
            raise HTTPException(status_code=400, detail="본인 staging 경로의 PLY 키가 아닙니다.")
        minio = get_minio_service()
        if not minio.object_exists(staging_key):
            raise HTTPException(status_code=status.HTTP_410_GONE, detail="staging PLY 가 없습니다.")
        fd, staging_tmp_path = tempfile.mkstemp(prefix="sam3_staging_", suffix=".ply")
        os.close(fd)
        try:
            minio.download_to_file(staging_key, staging_tmp_path)
        except Exception as e:
            try:
                os.unlink(staging_tmp_path)
            except OSError:
                pass
            raise HTTPException(status_code=500, detail=f"staging PLY 다운로드 실패: {e}")
        p = Path(staging_tmp_path)

    try:
        if p is None:
            raise OSError("PLY path is not available")
        resp = await _post_door_ml_detect(p, body)
        if resp.status_code != 200 and body.interior_strict and "Room center not interior" in resp.text:
            relaxed_min_hits = max(0, min(body.interior_min_hits, 20))
            logger.warning(
                "[sam3_detect_temp] interior strict gate failed; retrying relaxed "
                "interior check (min_hits=%s): %s",
                relaxed_min_hits,
                resp.text[:300],
            )
            resp = await _post_door_ml_detect(
                p,
                body,
                {"interior_strict": False, "interior_min_hits": relaxed_min_hits},
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"door-ml 통신 실패: {e}")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"PLY 읽기 실패: {e}")
    finally:
        if staging_tmp_path:
            try:
                os.unlink(staging_tmp_path)
            except OSError:
                pass

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"door-ml HTTP {resp.status_code}: {resp.text[:300]}",
        )

    resp_json = resp.json()
    required = ("left_top", "right_top", "right_bottom", "left_bottom")
    corners = {k: resp_json[k] for k in required} if all(k in resp_json for k in required) else None
    if corners is None:
        raise HTTPException(status_code=502, detail=f"door-ml 응답 형식 오류: keys={list(resp_json.keys())}")

    # N-door: all_doors 리스트 (없으면 primary 1개)
    raw_all_doors: list[dict] = resp_json.get("all_doors", [corners])

    def _transform_corners(c: dict) -> dict:
        if body.bake_rotation:
            br = body.bake_rotation
            if _is_known_room(body):
                return {k: _apply_wall_angle_to_corner(c[k], br.wallAngleRad) for k in required}
            return {k: _apply_bake_rotation_to_corner(c[k], br.rotX, br.rotZ, br.wallAngleRad) for k in required}
        return c

    corners = _transform_corners(corners)
    all_doors_transformed = []
    for d in raw_all_doors:
        transformed = _transform_corners(d)
        # suggested_hinge_edge 는 좌표 변환 불필요 — 그대로 전달.
        transformed["suggested_hinge_edge"] = d.get("suggested_hinge_edge")
        all_doors_transformed.append(transformed)

    return Sam3DetectTempResponse(corners=corners, all_doors=all_doors_transformed)


# ── 2-b. 클라이언트 렌더 자동검출 (PLY 업로드 없이 이미지셋 relay) ──────────────

@router.post("/sam3/detect-temp-image", response_model=Sam3DetectTempResponse)
async def sam3_detect_temp_image(
    views: list[UploadFile] = File(...),
    meta: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """클라 렌더 이미지셋 → door-ml `/detect_image` relay → wallAngle 적용 → corners.

    PLY 업로드 불필요(병목 제거). meta JSON:
      { "prompt": "white door", "sam3_prob": 0.55, "wall_angle_rad": <float>,
        "views": [{"idx","K"(3x3),"c2w"(4x4 raw OpenCV),"w","h"}, ...],
        "room":  {"rot_x","rot_z","floor_y","ceiling_y","wall_polygon"(A')} }
    이미지 경로는 항상 known-room(A') 이므로 door-ml 의 A' 코너에 wallAngle 만 적용한다.
    """
    meta_bytes = await meta.read()
    try:
        meta_obj = json.loads(meta_bytes.decode("utf-8"))
        room = meta_obj["room"]
        for k in ("rot_x", "rot_z", "floor_y", "ceiling_y", "wall_polygon"):
            if room.get(k) is None:
                raise ValueError(f"room.{k} 누락 (known-room 필수)")
        wall_angle_rad = float(meta_obj.get("wall_angle_rad", 0.0))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"meta 파싱 실패: {e}")

    # door-ml relay (multipart 재구성). meta 는 그대로 전달, door-ml 은 room/views/prompt 만 사용.
    files: list = [("meta", ("meta.json", meta_bytes, "application/json"))]
    n_views = 0
    for uf in views:
        name = os.path.basename(uf.filename or "")
        if not name.lower().endswith(".png"):
            continue
        files.append(("views", (name, await uf.read(), "image/png")))
        n_views += 1
    if n_views == 0:
        raise HTTPException(status_code=400, detail="view PNG 가 없습니다.")

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(f"{settings.DOOR_ML_URL}/detect_image", files=files)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"door-ml 통신 실패: {e}")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"door-ml HTTP {resp.status_code}: {resp.text[:300]}")

    resp_json = resp.json()
    required = ("left_top", "right_top", "right_bottom", "left_bottom")
    if not all(k in resp_json for k in required):
        raise HTTPException(status_code=502, detail=f"door-ml 응답 형식 오류: keys={list(resp_json.keys())}")

    def _tf(c: dict) -> dict:
        return {k: _apply_wall_angle_to_corner(c[k], wall_angle_rad) for k in required}

    corners = _tf({k: resp_json[k] for k in required})
    all_doors = []
    for d in resp_json.get("all_doors", [{k: resp_json[k] for k in required}]):
        t = _tf(d)
        t["suggested_hinge_edge"] = d.get("suggested_hinge_edge")
        all_doors.append(t)
    return Sam3DetectTempResponse(corners=corners, all_doors=all_doors)


# ── 3. 정합 완료 — 일괄 영속화 ────────────────────────────────────────────────

class AlignmentTransformDTO(BaseModel):
    position: list[float]  # [x, y, z]
    rotation: list[float]  # [qx, qy, qz, qw]
    scale: list[float] = [1.0, 1.0, 1.0]
    rmsd: float | None = None
    matches: list[dict] | None = None
    bake_rotation: dict | None = None


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
_TEXTURE_EXT_BY_CONTENT_TYPE = {
    "image/webp": ".webp",
    "image/png": ".png",
}


def _texture_ext(upload: UploadFile) -> str:
    content_type = (upload.content_type or "").split(";", 1)[0].strip().lower()
    if content_type in _TEXTURE_EXT_BY_CONTENT_TYPE:
        return _TEXTURE_EXT_BY_CONTENT_TYPE[content_type]
    ext = os.path.splitext(upload.filename or "")[1].lower()
    return ext if ext in {".webp", ".png"} else ".png"


def _texture_content_type(upload: UploadFile) -> str:
    content_type = (upload.content_type or "").split(";", 1)[0].strip().lower()
    return content_type if content_type in _TEXTURE_EXT_BY_CONTENT_TYPE else "image/png"


@router.post("/commit-final", response_model=CommitFinalResponse)
async def commit_final(
    request: Request,
    building_id: UUID = Form(...),
    floor_id: UUID = Form(...),
    module_name: str = Form(...),
    original_filename: str = Form(...),
    alignment_transform_json: str = Form(...),
    final_ply_staging_key: str = Form(...),
    mesh_json: UploadFile = File(...),
    doors_json: UploadFile = File(...),
    sam3_session_id: str | None = Form(None),
    sam3_staging_key: str | None = Form(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """정합 완료 시점 일괄 영속화.

    - 같은 사용자가 같은 호수 재등록 시: 기존 module 재사용 + 기존 자산 삭제(덮어쓰기).
    - 다른 사용자가 같은 호수: 별개 module 신규 생성.
    - 영속 자산: final.ply + mesh.json + tex_* 텍스처 + doors.json + alignment_transform.
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

    # ── final.ply staging 키 검증 ──
    # 대용량 PLY 는 Cloudflare 100MB 본문 한도 때문에 멀티파트로 못 싣는다. 클라이언트가
    # /uploads/staging-multipart-* 로 미리 MinIO 에 청크 업로드한 staging 키를 받아,
    # 아래에서 서버사이드 copy 로 최종 위치에 옮긴다. (본인 staging 경로만 허용.)
    try:
        staging_key = normalize_minio_key(final_ply_staging_key)
    except ValueError:
        raise HTTPException(status_code=400, detail="유효하지 않은 final_ply_staging_key 입니다.")
    if not is_key_under_prefix(staging_key, f"staging/{user.id}/"):
        raise HTTPException(status_code=400, detail="본인 staging 경로의 PLY 키가 아닙니다.")

    # ── 동적 텍스처 키 수집 — 'tex_<surfaceId>' 패턴 ──
    # ceiling/floor 필수 + w0..w(N-1) 폴리곤 변 수만큼. multipart form 한 번 읽음 (cached).
    form = await request.form()
    tex_uploads: dict[str, UploadFile] = {}
    tex_variant_uploads: dict[str, UploadFile] = {}
    door_tex_uploads: dict[str, UploadFile] = {}
    door_splat_uploads: dict[str, UploadFile] = {}
    for key, value in form.multi_items():
        if not hasattr(value, "read") or not hasattr(value, "filename"):
            continue
        if key.startswith("door_tex_"):
            door_tex_uploads[key] = value  # type: ignore[assignment]
            continue
        if key.startswith("door_splat_"):
            door_splat_uploads[key] = value  # type: ignore[assignment]
            continue
        if key.startswith("texview_"):
            tex_variant_uploads[key[len("texview_"):]] = value  # type: ignore[assignment]
            continue
        if not key.startswith("tex_"):
            continue
        sid = key[len("tex_"):]
        if not (sid in REQUIRED_TEXTURE_KEYS or _WALL_KEY_RE.match(sid)):
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
    was_overwrite = False
    if existing_module is not None:
        old_output = await db.execute(
            select(SceneOutput.id)
            .where(SceneOutput.module_id == existing_module.id)
            .limit(1)
        )
        was_overwrite = (
            existing_module.alignment_transform is not None
            or old_output.scalar_one_or_none() is not None
        )

    minio = get_minio_service()

    # staging PLY 존재 + 크기 확인 — 덮어쓰기로 옛 객체를 지우기 전에 먼저 검증한다
    # (소스가 없으면 옛 작업물을 파괴하기 전에 즉시 중단).
    if not minio.object_exists(staging_key):
        raise HTTPException(status_code=400, detail="업로드된 PLY(staging)를 찾을 수 없습니다. 다시 업로드하세요.")
    final_ply_size = int(minio.stat_object(staging_key).size)

    old_upload_ids: list = []
    old_cleanup_prefixes: list[str] = []
    # ── 덮어쓰기 준비: 교체 대상은 새 commit 이 성공한 뒤 정리 ──
    if existing_module is not None:
        if user.role != UserRole.admin and existing_module.user_id != user.id:
            raise HTTPException(status_code=403, detail="이 모듈을 덮어쓸 권한이 없습니다.")
        old_uploads = (await db.execute(
            select(Upload).where(Upload.module_id == existing_module.id)
        )).scalars().all()
        old_upload_ids = [u.id for u in old_uploads]
        old_base = module_base_path(
            str(building_id), str(floor_id), str(existing_module.id), existing_module.name,
        )
        old_scene_paths = (await db.execute(
            select(SceneOutput.ply_path).where(SceneOutput.module_id == existing_module.id)
        )).scalars().all()
        old_cleanup_prefixes = [object_dir(path) for path in old_scene_paths if path]
        old_cleanup_prefixes.extend([
            f"{old_base}/alignment/refined/door_assets",
        ])

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
    doors_key = f"{refined_dir}/doors.json"
    tex_keys = {tid: f"{refined_dir}/tex_{tid}{_texture_ext(f)}" for tid, f in tex_uploads.items()}
    tex_variant_keys = {tid: f"{refined_dir}/tex_{tid}{_texture_ext(f)}" for tid, f in tex_variant_uploads.items()}
    door_asset_dir = f"{refined_dir}/door_assets"
    door_tex_keys = {field: f"{door_asset_dir}/{field}{_texture_ext(f)}" for field, f in door_tex_uploads.items()}
    door_splat_keys = {field: f"{door_asset_dir}/{field}.ply" for field in door_splat_uploads.keys()}

    # ── Upload 행 생성 ──
    upload = Upload(
        user_id=user.id,
        module_id=module.id,
        original_filename=original_filename,
        file_size=final_ply_size,  # staging 으로 올라온 다듬기 결과 PLY 크기
        content_type="application/octet-stream",
        minio_path=placeholder_key,
        ply_target=PlyTarget.alignment,
        status=UploadStatus.completed,
        sam3_status=None,  # module flow uses synchronous detect-temp, so no SAM3 task dispatch.
        # 표준 조회 경로(uploads.py)가 doors.json / refined PLY 를 찾을 수 있도록 키를 기록.
        # 누락 시 has_doors_json=False 가 되어 "문 정보 없음" 으로 끝난다 (commit-final 계약).
        refined_ply_path=final_ply_key,
        door_corners_json_path=doors_key,
    )
    db.add(upload)
    await db.flush()

    # ── doors.json 의 multipart placeholder 를 최종 MinIO key 로 치환 ──
    try:
        doors_payload = json.loads((await doors_json.read()).decode("utf-8"))
        for door in doors_payload.get("doors", []):
            if not isinstance(door, dict):
                continue
            door_mesh = door.get("doorMesh")
            if isinstance(door_mesh, dict):
                tex_ref = door_mesh.get("textureFilename")
                if isinstance(tex_ref, str) and tex_ref.startswith("form:"):
                    field = tex_ref[len("form:"):]
                    if field not in door_tex_uploads:
                        raise HTTPException(status_code=400, detail=f"도어 텍스처 파일 누락: {field}")
                    door_mesh["textureFilename"] = door_tex_keys[field]
            door_splat = door.get("doorSplat")
            if isinstance(door_splat, dict):
                splat_ref = door_splat.get("filename")
                if isinstance(splat_ref, str) and splat_ref.startswith("form:"):
                    field = splat_ref[len("form:"):]
                    if field not in door_splat_uploads:
                        raise HTTPException(status_code=400, detail=f"도어 splat 파일 누락: {field}")
                    door_splat["filename"] = door_splat_keys[field]
        doors_bytes = json.dumps(doors_payload, ensure_ascii=False).encode("utf-8")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"doors_json 형식 오류: {e}")

    # ── MinIO 업로드 (final.ply + mesh.json + tex_* + doors.json + door assets) ──
    uploaded_keys: list[str] = []
    try:
        # 대용량 PLY: staging → 최종 키로 MinIO 서버사이드 복사 (데이터가 백엔드/Cloudflare 미경유).
        minio.copy_object(final_ply_key, staging_key)
        uploaded_keys.append(final_ply_key)

        mesh_bytes = await mesh_json.read()
        minio.put_object_bytes(mesh_key, mesh_bytes, "application/json")
        uploaded_keys.append(mesh_key)

        minio.put_object_bytes(doors_key, doors_bytes, "application/json")
        uploaded_keys.append(doors_key)

        for tid, f in tex_uploads.items():
            data = await f.read()
            minio.put_object_bytes(tex_keys[tid], data, _texture_content_type(f))
            uploaded_keys.append(tex_keys[tid])
        for tid, f in tex_variant_uploads.items():
            data = await f.read()
            minio.put_object_bytes(tex_variant_keys[tid], data, _texture_content_type(f))
            uploaded_keys.append(tex_variant_keys[tid])
        for field, f in door_tex_uploads.items():
            data = await f.read()
            minio.put_object_bytes(door_tex_keys[field], data, _texture_content_type(f))
            uploaded_keys.append(door_tex_keys[field])
        for field, f in door_splat_uploads.items():
            data = await f.read()
            minio.put_object_bytes(door_splat_keys[field], data, "application/octet-stream")
            uploaded_keys.append(door_splat_keys[field])
    except Exception as e:
        # 부분 실패 — 이번 요청에서 새로 올린 키만 정리한다.
        for key in uploaded_keys:
            try:
                minio.delete_object(key)
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
        # SOG is an optional viewer-optimized derivative. The canonical persisted
        # module output for this flow is final.ply.
        sog_path=None,
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
        "bake_rotation": at.bake_rotation,
        "saved_at": now.isoformat(),
    }
    module.is_confirmed = True

    # Floor overview 재계산 플래그
    await db.execute(
        sa_update(Floor).where(Floor.id == floor_id).values(overview_dirty=True)
    )

    await db.commit()

    # staging PLY 정리 — 최종 키로 복사 완료됐으니 임시본 삭제 (실패해도 무시, 누수만 됨).
    try:
        minio.delete_object(staging_key)
    except Exception:
        pass

    if old_upload_ids:
        try:
            await db.execute(sa_delete(SceneOutput).where(SceneOutput.module_id == module.id, SceneOutput.id != scene_output.id))
            await db.execute(sa_delete(Task).where(Task.upload_id.in_(old_upload_ids)))
            await db.execute(sa_delete(Upload).where(Upload.id.in_(old_upload_ids)))
            await db.commit()
            for prefix in old_cleanup_prefixes:
                minio.delete_prefix(prefix)
        except Exception as e:
            await db.rollback()
            logger.exception(f"[commit-final] 교체 대상 정리 실패: {e}")

    # refined(정합 완료) PLY → SOG 변환 비동기 발행. 뷰어용 경량 파생물이라 브로커
    # 미가용 등으로 실패해도 무시 — sog_path 는 None 으로 남고 표시는 PLY 로 폴백된다.
    try:
        dispatch_sog_conversion_task(str(scene_output.id), final_ply_key)
    except Exception as e:
        logger.warning(f"[commit_final] SOG 변환 발행 실패 (무시): {e}")

    # SAM3 임시 PLY 삭제 (있으면)
    if sam3_session_id:
        try:
            delete_temp(sam3_session_id)
        except Exception:
            pass
    if sam3_staging_key:
        try:
            key = normalize_minio_key(sam3_staging_key)
            if is_key_under_prefix(key, f"staging/{user.id}/"):
                minio.delete_object(key)
        except Exception:
            pass

    return CommitFinalResponse(
        module_id=module.id,
        upload_id=upload.id,
        scene_output_id=scene_output.id,
        was_overwrite=was_overwrite,
    )
