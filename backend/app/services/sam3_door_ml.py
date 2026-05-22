"""
door-ml HTTP 서비스 기반 SAM3 도어 검출 실행자.

main 의 원래 설계는 SAM3 작업을 Celery 워커에 dispatch 하지만, GPU 워커는
스코프 밖이라 미구현. 대신 docker-compose.gpu.yml 의 door-ml 컨테이너
(`POST /detect`) 를 호출해 동등한 결과(`doors.json`)를 만들어 같은
저장소 키(`doors_json_key(upload.minio_path)`) 에 둔다.

이 모듈은 백그라운드 thread 에서 실행되도록 설계됨. start_sam3 API
호출은 즉시 task_id 를 반환하고, 실제 처리는 여기서 비동기로 진행.

상태 전이:
  Sam3Status.pending  → dispatch 직후 (start_sam3)
  Sam3Status.running  → thread 진입 직후
  Sam3Status.done     → door-ml 응답 + doors.json 저장 완료
  Sam3Status.failed   → 어떤 단계에서든 실패
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import threading
import uuid
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.models import Sam3Status, Task, TaskStatus, Upload
from app.services.minio_service import get_minio_service
from app.services.storage_paths import doors_json_key

settings = get_settings()
logger = logging.getLogger(__name__)


def _apply_bake_rotation(
    corners: dict[str, dict[str, float]],
    rot_x: float,
    rot_z: float,
    wall_angle_rad: float,
) -> dict[str, dict[str, float]]:
    """door-ml 이 반환한 원본 좌표계 corner 들을 refined PLY 좌표계로 변환.

    refined PLY 는 다듬기 단계에서 다음 변환이 가우시안 위치에 베이크됨 (frontend
    useRefineTool.commitRefinedToServer + lib/gs/transform.ts):

        P_refined = R_y(wall_angle_rad) · R_z(rot_z) · R_x(rot_x) · P_original

    door-ml 검출은 원본 PLY 위에서 수행되므로 결과 corners 도 원본 좌표계.
    doors.json 은 정합 단계에서 refined PLY 위 좌표로 사용되므로 동일 변환 적용.
    """
    if rot_x == 0 and rot_z == 0 and wall_angle_rad == 0:
        return corners

    cx, sx = math.cos(rot_x), math.sin(rot_x)
    cz, sz = math.cos(rot_z), math.sin(rot_z)
    cy, sy = math.cos(wall_angle_rad), math.sin(wall_angle_rad)

    # R_xz = R_z(rotZ) · R_x(rotX) (transform.ts:14-17 과 동일)
    #   [cz, -sz·cx,  sz·sx]
    #   [sz,  cz·cx, -cz·sx]
    #   [0,   sx,     cx   ]
    # R_y(wallY) (transform.ts:75 과 동일)
    #   [c, 0, s]
    #   [0, 1, 0]
    #   [-s, 0, c]
    out: dict[str, dict[str, float]] = {}
    for name, p in corners.items():
        x, y, z = float(p["x"]), float(p["y"]), float(p["z"])
        # R_xz
        x1 = cz * x - sz * cx * y + sz * sx * z
        y1 = sz * x + cz * cx * y - cz * sx * z
        z1 = sx * y + cx * z
        # R_y
        x2 = cy * x1 + sy * z1
        y2 = y1
        z2 = -sy * x1 + cy * z1
        out[name] = {"x": x2, "y": y2, "z": z2}
    return out


def _make_thread_session():
    """thread 안에서 새 asyncio loop 와 함께 쓸 일회용 async engine + sessionmaker.

    main FastAPI 의 글로벌 async engine 은 메인 루프에 바인딩된 connection pool 을 갖고
    있어, thread 의 새 asyncio.run() 루프에서 호출하면
    "got Future ... attached to a different loop" RuntimeError 발생.
    각 호출마다 새 엔진을 만들고 dispose 해 격리.
    """
    eng = create_async_engine(settings.DATABASE_URL, echo=False, pool_pre_ping=True)
    sess = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)
    return eng, sess


def _build_doors_json(corners: dict[str, dict[str, float]]) -> dict[str, Any]:
    """door-ml 응답을 main 의 doors.json 스키마로 변환.

    door-ml 응답: {"left_top": {x,y,z}, "right_top": {...}, ...}
    doors.json:   {"doors": [{"id": "door_1", "corners": [[lt], [rt], [rb], [lb]], ...}]}
    """
    def to_xyz(p: dict[str, float]) -> list[float]:
        return [float(p["x"]), float(p["y"]), float(p["z"])]

    return {
        "doors": [
            {
                "id": "door_1",
                "corners": [
                    to_xyz(corners["left_top"]),
                    to_xyz(corners["right_top"]),
                    to_xyz(corners["right_bottom"]),
                    to_xyz(corners["left_bottom"]),
                ],
                "hingeEdge": None,
                "unitName": None,
            }
        ]
    }


async def _persist_result(
    upload_id: str,
    celery_task_id: str,
    doors_key: str | None,
    error: str | None,
) -> None:
    """doors.json 키 + sam3_status 를 DB 에 반영. thread 전용 일회용 엔진 사용."""
    engine, session_maker = _make_thread_session()
    try:
        async with session_maker() as session:
            result = await session.execute(select(Upload).where(Upload.id == uuid.UUID(upload_id)))
            upload = result.scalar_one_or_none()
            if upload is not None:
                if error:
                    upload.sam3_status = Sam3Status.failed
                else:
                    upload.sam3_status = Sam3Status.done
                    if doors_key:
                        upload.door_corners_json_path = doors_key

            # 매칭되는 Task 도 함께 갱신.
            task_result = await session.execute(
                select(Task).where(Task.celery_task_id == celery_task_id)
            )
            task = task_result.scalar_one_or_none()
            if task is not None:
                task.status = TaskStatus.failed if error else TaskStatus.completed
                if error:
                    task.error_message = error[:1000]

            await session.commit()
    finally:
        await engine.dispose()


def _run_door_ml_pipeline(
    upload_id: str,
    original_ply_key: str,
    prompt: str,
    celery_task_id: str,
    rot_x: float,
    rot_z: float,
    wall_angle_rad: float,
    doors_target_key: str,
) -> None:
    """thread entrypoint — door-ml HTTP 호출 + doors.json 업로드 + DB 갱신.

    원본 PLY 로 검출 → 베이크 회전을 코너에 적용 → refined 좌표계 doors.json 저장.
    refined PLY 는 다듬기에서 벽 가우시안이 mesh+texture 로 분리돼 빠지므로
    SAM3 가 벽 컨텍스트를 못 봐 검출 실패 → 원본 PLY 사용이 본질.
    """
    # 진입 시점에 status=running 으로 표시.
    asyncio.run(_set_running(upload_id))

    minio = get_minio_service()
    doors_key: str | None = None
    error: str | None = None

    try:
        # 1) 원본 PLY 다운로드 (다듬기 전 — 벽 가우시안이 살아있어 SAM3 가 문 인식 가능).
        ply_bytes = minio.get_object_bytes(original_ply_key)

        # 2) door-ml HTTP 호출. SAM3 + gsplat 는 분 단위가 걸릴 수 있어 timeout 넉넉히.
        with httpx.Client(timeout=600.0) as client:
            resp = client.post(
                f"{settings.DOOR_ML_URL}/detect",
                files={"file": ("scene.ply", ply_bytes, "application/octet-stream")},
                params={"prompt": prompt or "door", "sam3_prob": 0.55},
            )
        if resp.status_code != 200:
            raise RuntimeError(f"door-ml HTTP {resp.status_code}: {resp.text[:300]}")

        corners = resp.json()
        if not all(k in corners for k in ("left_top", "right_top", "right_bottom", "left_bottom")):
            raise RuntimeError(f"door-ml 응답 형식 오류: keys={list(corners.keys())}")

        # 2.5) 원본 좌표계 코너 → refined 좌표계로 변환 (다듬기에서 베이크된 회전 적용).
        corners = _apply_bake_rotation(corners, rot_x, rot_z, wall_angle_rad)

        # 3) doors.json 작성 + MinIO 저장 (refined 디렉터리에 저장).
        doors_key = _build_and_upload_doors_json(doors_target_key, corners, minio)

    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        logger.exception(f"[sam3_door_ml] FAILED upload_id={upload_id} task={celery_task_id}: {error}")

    # 4) DB 반영.
    asyncio.run(_persist_result(
        upload_id=upload_id,
        celery_task_id=celery_task_id,
        doors_key=doors_key,
        error=error,
    ))


def _build_and_upload_doors_json(
    refined_ply_key: str,
    corners: dict[str, dict[str, float]],
    minio: Any,
) -> str:
    """doors.json 키 계산 + MinIO put. refined_ply_key 와 같은 refined/ 디렉터리에 저장.

    main 의 storage_paths.doors_json_key 는 upload.minio_path 의 refined 디렉터리에
    doors.json 을 둠. 우리는 refined_ply_key 가 이미 그 refined 디렉터리 하위에
    있으므로 같은 prefix 의 doors.json 키를 만들어준다.
    """
    # refined_ply_key 예: buildings/B/F/modules/M/refined/<session>/final.ply
    # 또는              buildings/B/F/modules/M/refined/<ts>_aligned.ply
    # 어느 경우든 ".../refined/" 까지가 안정적인 prefix → 그 prefix 에 doors.json 둔다.
    parts = refined_ply_key.rsplit("/refined/", 1)
    if len(parts) != 2:
        # 예외적 키 — 동일 디렉터리에 두는 fallback.
        prefix = refined_ply_key.rsplit("/", 1)[0]
        key = f"{prefix}/doors.json"
    else:
        key = f"{parts[0]}/refined/doors.json"

    import io
    payload = json.dumps(_build_doors_json(corners), ensure_ascii=False, indent=2).encode("utf-8")
    minio.client.put_object(
        bucket_name=minio.bucket,
        object_name=key,
        data=io.BytesIO(payload),
        length=len(payload),
        content_type="application/json",
    )
    return key


async def _set_running(upload_id: str) -> None:
    engine, session_maker = _make_thread_session()
    try:
        async with session_maker() as session:
            result = await session.execute(select(Upload).where(Upload.id == uuid.UUID(upload_id)))
            upload = result.scalar_one_or_none()
            if upload is not None and upload.sam3_status != Sam3Status.done:
                upload.sam3_status = Sam3Status.running
                await session.commit()
    finally:
        await engine.dispose()


def dispatch_via_door_ml(
    upload_id: str,
    original_ply_key: str,
    prompt: str,
    rot_x: float = 0.0,
    rot_z: float = 0.0,
    wall_angle_rad: float = 0.0,
    doors_target_key: str | None = None,
) -> str:
    """비동기 thread 로 door-ml 파이프라인을 시작하고 task_id 즉시 반환.

    Args:
        original_ply_key: 다듬기 전 원본 PLY 의 MinIO key. 벽이 살아있어야 SAM3 검출 가능.
        rot_x/rot_z/wall_angle_rad: 다듬기에서 베이크된 회전 (corners 변환에 사용).
        doors_target_key: doors.json 위치 derivation 용 키 (refined PLY 키 또는
            동일 디렉터리 prefix 가지는 키). None 이면 original_ply_key 로부터 도출.
    """
    task_id = str(uuid.uuid4())
    t = threading.Thread(
        target=_run_door_ml_pipeline,
        args=(
            upload_id,
            original_ply_key,
            prompt,
            task_id,
            rot_x,
            rot_z,
            wall_angle_rad,
            doors_target_key or original_ply_key,
        ),
        daemon=True,
        name=f"sam3-door-ml-{task_id[:8]}",
    )
    t.start()
    return task_id
