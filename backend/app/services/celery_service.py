from celery import Celery

from app.core.config import get_settings
from app.services.sam3_service import (
    SAM3_QUEUE_NAME,
    SAM3_TASK_NAME,
    build_sam3_task_args,
)

settings = get_settings()

TRAINING_TASK_NAME = "tasks.training.run_3dgs_training"
COLMAP_TASK_NAME = "tasks.colmap.run_colmap_preprocessing"
GS_FROM_COLMAP_TASK_NAME = "tasks.training.run_gs_training_from_colmap"
ALIGNMENT_TASK_NAME = "tasks.alignment.run_door_alignment"
SOG_CONVERSION_TASK_NAME = "tasks.sog.convert_scene_to_sog"
SAM3_DOOR_ML_TASK_NAME = "door_ml.sam3_door_detection"
TRAINING_QUEUE = "training"
ALIGNMENT_QUEUE = "alignment"
SOG_QUEUE = "sog"

# 백엔드에서 태스크를 발행하기 위한 Celery 클라이언트
celery_app = Celery("worker")
celery_app.config_from_object({
    "broker_url": settings.RABBITMQ_URL,
    "result_backend": settings.REDIS_URL,
    "task_serializer": "json",
    "result_serializer": "json",
    "accept_content": ["json"],
})


def dispatch_training_task(
    upload_id: str,
    user_id: str,
    minio_input_key: str,
    building_id: str,
    floor_id: str,
    module_id: str,
    module_name: str,
    ply_target: str = "gsplat",
    task_id: str | None = None,
) -> str:
    """3DGS 학습 태스크 발행 → celery_task_id 반환"""
    result = celery_app.send_task(
        TRAINING_TASK_NAME,
        args=[
            upload_id, user_id, minio_input_key,
            building_id, floor_id, module_id, module_name, ply_target,
        ],
        queue=TRAINING_QUEUE,
        task_id=task_id,
    )
    return result.id


def dispatch_sam3_door_detection_task(
    upload_id: str,
    user_id: str,
    original_ply_key: str,
    prompt: str,
    building_id: str,
    floor_id: str,
    floor_number: int,
    module_id: str,
    module_name: str,
    rot_x: float = 0.0,
    rot_z: float = 0.0,
    wall_angle_rad: float = 0.0,
    doors_target_key: str | None = None,
    task_id: str | None = None,
) -> str:
    """SAM3 문 꼭짓점 자동 검출 발행 → task_id 반환.

    door-ml HTTP 컨테이너로 dispatch. 원본 PLY 로 검출 후 다듬기 베이크 회전을 코너에
    적용해 refined 좌표계 doors.json 으로 저장. (다듬기 후 PLY 는 벽이 분리돼 SAM3
    가 문을 못 봐서 본질적으로 검출 불가능 — sam3_door_ml.py 참조.)

    upload_id/prompt/회전/doors_target 외 인자(building_id 등)는 원래 Celery 워커
    라우팅에 썼던 것 — door-ml 은 PLY/prompt 만 받으므로 미사용.
    """
    from app.services.sam3_door_ml import dispatch_via_door_ml

    return dispatch_via_door_ml(
        upload_id=upload_id,
        original_ply_key=original_ply_key,
        prompt=prompt,
        rot_x=rot_x,
        rot_z=rot_z,
        wall_angle_rad=wall_angle_rad,
        doors_target_key=doors_target_key,
        task_id=task_id,
    )


def dispatch_sog_conversion_task(scene_id: str, ply_key: str) -> str:
    """refined(정합 완료) PLY → SOG 변환 태스크 발행 → celery_task_id 반환.

    SceneOutput 은 이미 존재하므로 변환 완료 후 워커가 scene_id 로 sog_path 만 채운다.
    """
    result = celery_app.send_task(
        SOG_CONVERSION_TASK_NAME,
        args=[scene_id, ply_key],
        queue=SOG_QUEUE,  # 전용 sog-worker 가 소비 (training 큐 블로킹 방지)
    )
    return result.id


def dispatch_colmap_task(
    upload_id: str,
    user_id: str,
    minio_input_key: str,
    task_id: str | None = None,
) -> str:
    """COLMAP 전처리 태스크 발행 → celery_task_id 반환"""
    result = celery_app.send_task(
        COLMAP_TASK_NAME,
        args=[upload_id, user_id, minio_input_key],
        queue=TRAINING_QUEUE,
        task_id=task_id,
    )
    return result.id


def dispatch_gs_training_from_colmap_task(
    upload_id: str,
    user_id: str,
    minio_input_key: str,
    bounds: dict | None = None,
    task_id: str | None = None,
) -> str:
    """COLMAP 산출물을 재사용해 GS 학습 태스크 발행 → celery_task_id 반환"""
    result = celery_app.send_task(
        GS_FROM_COLMAP_TASK_NAME,
        args=[upload_id, user_id, minio_input_key, bounds or {}],
        queue=TRAINING_QUEUE,
        task_id=task_id,
    )
    return result.id


def dispatch_alignment_task(
    upload_id: str,
    user_id: str,
    ply_key: str,
    door_position_key: str,
    basemap_key: str,
    building_id: str,
    floor_id: str,
    module_id: str,
    module_name: str,
    task_id: str | None = None,
) -> str:
    """문 정합 태스크 발행 → celery_task_id 반환"""
    result = celery_app.send_task(
        ALIGNMENT_TASK_NAME,
        args=[
            upload_id, user_id, ply_key, door_position_key,
            basemap_key, building_id, floor_id, module_id, module_name,
        ],
        queue=ALIGNMENT_QUEUE,
        task_id=task_id,
    )
    return result.id


def dispatch_task_payload(
    *,
    task_name: str,
    args: list | None = None,
    kwargs: dict | None = None,
    queue: str | None = None,
    task_id: str | None = None,
) -> str:
    """Dispatch a task from an outbox payload and return the effective task id."""
    if task_name == SAM3_DOOR_ML_TASK_NAME:
        from app.services.sam3_door_ml import dispatch_via_door_ml

        payload = dict(kwargs or {})
        return dispatch_via_door_ml(**payload, task_id=task_id)

    result = celery_app.send_task(
        task_name,
        args=args or [],
        kwargs=kwargs or {},
        queue=queue,
        task_id=task_id,
    )
    return result.id
