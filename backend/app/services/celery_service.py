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
    refined_ply_key: str,
    prompt: str,
    building_id: str,
    floor_id: str,
    floor_number: int,
    module_id: str,
    module_name: str,
) -> str:
    """SAM3 문 꼭짓점 자동 검출 발행 → task_id 반환.

    원래 설계는 GPU worker 가 Celery 큐(SAM3_QUEUE_NAME)에서 가져가 refined PLY 를
    다운로드해 SAM3 로 문을 검출하고 `doors.json` 을 MinIO 에 저장하는 흐름.
    이 프로젝트의 GPU worker 는 스코프 밖이라 미구현 → docker-compose.gpu.yml 의
    door-ml HTTP 컨테이너로 동등한 처리를 위임한다.

    호출자(start_sam3) 는 task_id 와 sam3_status='running' 만 신경 쓰므로
    인터페이스(반환값 형식)는 동일하게 유지.

    upload_id, refined_ply_key, prompt 외 인자(building_id 등)는 원래 Celery 워커가
    페이로드 라우팅에 썼던 것 — door-ml 은 PLY 와 prompt 만 받으므로 미사용.
    """
    # 지연 import — door-ml 통합 모듈은 sqlalchemy session/minio 를 끌어와서
    # circular import 방지를 위해 함수 내부에서 import.
    from app.services.sam3_door_ml import dispatch_via_door_ml

    return dispatch_via_door_ml(
        upload_id=upload_id,
        refined_ply_key=refined_ply_key,
        prompt=prompt,
    )


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

