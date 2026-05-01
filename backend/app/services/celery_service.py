from celery import Celery

from app.core.config import get_settings

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
    refined_ply_key: str,
    prompt: str,
    building_id: str,
    floor_id: str,
    floor_number: int,
    module_id: str,
    module_name: str,
) -> str:
    """SAM3 문 꼭짓점 자동 검출 태스크 발행 → celery_task_id 반환.

    GPU worker 가 refined PLY 를 다운로드해 SAM3 로 문을 검출하고
    `doors.json` 을 minIO 에 저장한다. 워커가 아직 task 핸들러를 구현하지
    않았다면 메시지는 큐에 쌓인다 (worker 측 별도 작업).
    """
    result = celery_app.send_task(
        "tasks.sam3.run_door_detection",
        args=[
            upload_id, user_id, refined_ply_key, prompt,
            building_id, floor_id, floor_number, module_id, module_name,
        ],
        queue="sam3",
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


