from types import SimpleNamespace

from app.api.internal import _failed_pipeline_cleanup_targets, _task_type_for_stage
from app.models import TaskType


def test_task_type_for_stage_maps_colmap() -> None:
    assert _task_type_for_stage("colmap") == TaskType.colmap_preprocessing


def test_task_type_for_stage_maps_gsplat() -> None:
    assert _task_type_for_stage("gsplat") == TaskType.training_3dgs


def test_failed_pipeline_cleanup_targets_preserve_colmap_for_gs_failure() -> None:
    upload = SimpleNamespace(
        id="upload-1",
        user_id="user-1",
        gsplat_ply_path="users/user-1/gsplat/upload-1/output.ply",
    )

    prefixes, keys = _failed_pipeline_cleanup_targets(upload, "gsplat")

    assert prefixes == {"users/user-1/gsplat/upload-1"}
    assert keys == {"users/user-1/gsplat/upload-1/output.ply"}
    assert upload.gsplat_ply_path is None


def test_failed_pipeline_cleanup_targets_clear_colmap_and_gs_for_colmap_failure() -> None:
    upload = SimpleNamespace(id="upload-1", user_id="user-1", gsplat_ply_path=None)

    prefixes, keys = _failed_pipeline_cleanup_targets(upload, "colmap")

    assert prefixes == {
        "users/user-1/colmap/upload-1",
        "users/user-1/gsplat/upload-1",
    }
    assert keys == set()
