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
import threading
import uuid
from typing import Any

import httpx
from sqlalchemy import select

from app.core.config import get_settings
from app.core.database import async_session
from app.models import Sam3Status, Task, TaskStatus, Upload
from app.services.minio_service import get_minio_service
from app.services.storage_paths import doors_json_key

settings = get_settings()


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
    """doors.json 키 + sam3_status 를 DB 에 반영. 별도 async session 사용."""
    async with async_session() as session:
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


def _run_door_ml_pipeline(
    upload_id: str,
    refined_ply_key: str,
    prompt: str,
    celery_task_id: str,
) -> None:
    """thread entrypoint — door-ml HTTP 호출 + doors.json 업로드 + DB 갱신."""
    # 진입 시점에 status=running 으로 표시.
    asyncio.run(_set_running(upload_id))

    minio = get_minio_service()
    doors_key: str | None = None
    error: str | None = None

    try:
        # 1) refined PLY 다운로드.
        ply_bytes = minio.get_object_bytes(refined_ply_key)

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

        # 3) doors.json 작성 + MinIO 저장.
        doors_key = _build_and_upload_doors_json(refined_ply_key, corners, minio)

    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        print(f"[sam3_door_ml] FAILED upload_id={upload_id} task={celery_task_id}: {error}")

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
    async with async_session() as session:
        result = await session.execute(select(Upload).where(Upload.id == uuid.UUID(upload_id)))
        upload = result.scalar_one_or_none()
        if upload is not None and upload.sam3_status != Sam3Status.done:
            upload.sam3_status = Sam3Status.running
            await session.commit()


def dispatch_via_door_ml(
    upload_id: str,
    refined_ply_key: str,
    prompt: str,
) -> str:
    """비동기 thread 로 door-ml 파이프라인을 시작하고 task_id 즉시 반환.

    반환값은 main 의 dispatch_sam3_door_detection_task 와 동일 형식 (UUID 문자열) 이라
    호출자(start_sam3) 의 변경 없이 동작한다.
    """
    task_id = str(uuid.uuid4())
    t = threading.Thread(
        target=_run_door_ml_pipeline,
        args=(upload_id, refined_ply_key, prompt, task_id),
        daemon=True,
        name=f"sam3-door-ml-{task_id[:8]}",
    )
    t.start()
    return task_id
