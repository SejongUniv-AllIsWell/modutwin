from celery import Celery

from app.core.config import get_settings
from app.services.sam3_service import (
    SAM3_QUEUE_NAME,
    SAM3_TASK_NAME,
    build_sam3_task_args,
)

settings = get_settings()

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
) -> str:
    """3DGS 학습 태스크 발행 → celery_task_id 반환"""
    result = celery_app.send_task(
        "tasks.training.run_3dgs_training",
        args=[
            upload_id, user_id, minio_input_key,
            building_id, floor_id, module_id, module_name, ply_target,
        ],
        queue="training",
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
    )


def dispatch_colmap_task(
    upload_id: str,
    user_id: str,
    minio_input_key: str,
) -> str:
    """COLMAP 전처리 태스크 발행 → celery_task_id 반환"""
    result = celery_app.send_task(
        "tasks.colmap.run_colmap_preprocessing",
        args=[upload_id, user_id, minio_input_key],
        queue="training",
    )
    return result.id



def dispatch_scene_sog_conversion(
    scene_id: str,
    ply_key: str,
    sog_key: str,
) -> str:
    """최종 씬 PLY → SOG 변환 태스크 발행 → celery_task_id 반환.

    commit_final / save_refined 가 SceneOutput 을 생성(sog_path=None)한 뒤 호출한다.
    완료되면 워커가 /internal/worker/scenes/{scene_id}/sog 로 콜백해 sog_path 를
    실제 SOG 키로 갱신한다. 변환 전/실패 시엔 sog_path=None 이라 뷰어가 PLY 로 fallback.
    """
    result = celery_app.send_task(
        "tasks.training.convert_scene_sog",
        args=[scene_id, ply_key, sog_key],
        queue="training",
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
) -> str:
    """문 정합 태스크 발행 → celery_task_id 반환"""
    result = celery_app.send_task(
        "tasks.alignment.run_door_alignment",
        args=[
            upload_id, user_id, ply_key, door_position_key,
            basemap_key, building_id, floor_id, module_id, module_name,
        ],
        queue="alignment",
    )
    return result.id

