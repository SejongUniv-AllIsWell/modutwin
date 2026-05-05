from types import SimpleNamespace

from app.models import Sam3Status
from app.services.sam3_service import (
    SAM3_DISABLED_DETAIL,
    SAM3_QUEUE_NAME,
    SAM3_TASK_NAME,
    build_sam3_task_args,
    mark_sam3_disabled,
    mark_sam3_dispatch_pending,
    normalize_sam3_prompt,
)


def test_sam3_constants_match_worker_contract() -> None:
    assert SAM3_TASK_NAME == "tasks.sam3.run_door_detection"
    assert SAM3_QUEUE_NAME == "sam3"
    assert SAM3_DISABLED_DETAIL == "SAM3 자동 문 추출 기능이 비활성화되어 있습니다. 수동 지정을 사용하세요."


def test_normalize_sam3_prompt_strips_and_empty_to_none() -> None:
    assert normalize_sam3_prompt("") is None
    assert normalize_sam3_prompt("   ") is None
    assert normalize_sam3_prompt(None) is None
    assert normalize_sam3_prompt("  find the doors  ") == "find the doors"


def test_build_sam3_task_args_preserves_exact_argument_order() -> None:
    args = build_sam3_task_args(
        upload_id="upload-1",
        user_id="user-1",
        refined_ply_key="buildings/b/f/modules/m/alignment/refined/r.ply",
        prompt="door prompt",
        building_id="building-1",
        floor_id="floor-1",
        floor_number=7,
        module_id="module-1",
        module_name="module-A",
    )

    assert args == [
        "upload-1",
        "user-1",
        "buildings/b/f/modules/m/alignment/refined/r.ply",
        "door prompt",
        "building-1",
        "floor-1",
        7,
        "module-1",
        "module-A",
    ]


def test_mark_sam3_disabled_sets_refined_prompt_and_failed_status() -> None:
    upload = SimpleNamespace(refined_ply_path=None, sam3_prompt=None, sam3_status=None)

    mark_sam3_disabled(
        upload=upload,
        refined_key="buildings/b/f/modules/m/alignment/refined/r.ply",
        prompt="   ",
    )

    assert upload.refined_ply_path == "buildings/b/f/modules/m/alignment/refined/r.ply"
    assert upload.sam3_prompt is None
    assert upload.sam3_status == Sam3Status.failed


def test_mark_sam3_dispatch_pending_sets_refined_prompt_and_pending_status() -> None:
    upload = SimpleNamespace(refined_ply_path=None, sam3_prompt=None, sam3_status=None)

    mark_sam3_dispatch_pending(
        upload=upload,
        refined_key="buildings/b/f/modules/m/alignment/refined/r.ply",
        prompt="  detect doors  ",
    )

    assert upload.refined_ply_path == "buildings/b/f/modules/m/alignment/refined/r.ply"
    assert upload.sam3_prompt == "detect doors"
    assert upload.sam3_status == Sam3Status.pending
