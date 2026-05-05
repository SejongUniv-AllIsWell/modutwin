from typing import Any

from app.models import Sam3Status

SAM3_TASK_NAME = "tasks.sam3.run_door_detection"
SAM3_QUEUE_NAME = "sam3"
SAM3_DISABLED_DETAIL = "SAM3 자동 문 추출 기능이 비활성화되어 있습니다. 수동 지정을 사용하세요."


def normalize_sam3_prompt(prompt: str | None) -> str | None:
    return (prompt or "").strip() or None


def build_sam3_task_args(
    upload_id: str,
    user_id: str,
    refined_ply_key: str,
    prompt: str,
    building_id: str,
    floor_id: str,
    floor_number: int,
    module_id: str,
    module_name: str,
) -> list[str | int]:
    return [
        upload_id,
        user_id,
        refined_ply_key,
        prompt,
        building_id,
        floor_id,
        floor_number,
        module_id,
        module_name,
    ]


def _set_sam3_upload_payload(upload: Any, refined_key: str, prompt: str | None) -> None:
    upload.refined_ply_path = refined_key
    upload.sam3_prompt = normalize_sam3_prompt(prompt)


def mark_sam3_disabled(upload: Any, refined_key: str, prompt: str | None) -> None:
    _set_sam3_upload_payload(upload=upload, refined_key=refined_key, prompt=prompt)
    upload.sam3_status = Sam3Status.failed


def mark_sam3_dispatch_pending(upload: Any, refined_key: str, prompt: str | None) -> None:
    _set_sam3_upload_payload(upload=upload, refined_key=refined_key, prompt=prompt)
    upload.sam3_status = Sam3Status.pending
