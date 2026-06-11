from types import SimpleNamespace

from app.api.uploads import _colmap_retry_stage, _has_colmap_sparse_outputs
from app.models import PlyTarget, TaskStatus, TaskType, UploadStatus


def _upload(status=UploadStatus.failed, gsplat_ply_path=None):
    return SimpleNamespace(
        status=status,
        ply_target=PlyTarget.colmap,
        gsplat_ply_path=gsplat_ply_path,
    )


def _task(task_type, status, created_at="2026-01-01T00:00:00Z"):
    return SimpleNamespace(task_type=task_type, status=status, created_at=created_at)


def test_colmap_retry_stage_restarts_colmap_when_colmap_task_failed() -> None:
    tasks = [_task(TaskType.colmap_preprocessing, TaskStatus.failed)]

    assert _colmap_retry_stage(_upload(), tasks) == "colmap"


def test_colmap_retry_stage_restarts_gsplat_when_gs_task_failed() -> None:
    tasks = [_task(TaskType.training_3dgs, TaskStatus.failed)]

    assert _colmap_retry_stage(_upload(), tasks) == "gsplat"


def test_colmap_retry_stage_uses_completed_colmap_artifacts_for_gs_retry() -> None:
    tasks = [_task(TaskType.colmap_preprocessing, TaskStatus.completed)]

    assert _colmap_retry_stage(_upload(), tasks) == "gsplat"


def test_colmap_retry_stage_falls_back_to_colmap_without_completed_colmap() -> None:
    tasks = [_task(TaskType.training_3dgs, TaskStatus.completed)]

    assert _colmap_retry_stage(_upload(), tasks) == "colmap"


def test_has_colmap_sparse_outputs_requires_all_sparse_bins() -> None:
    upload = SimpleNamespace(user_id="user-1", id="upload-1")

    class FakeMinio:
        def object_exists(self, key: str) -> bool:
            return not key.endswith("points3D.bin")

    assert _has_colmap_sparse_outputs(FakeMinio(), upload) is False


def test_has_colmap_sparse_outputs_accepts_complete_sparse_bins() -> None:
    upload = SimpleNamespace(user_id="user-1", id="upload-1")

    class FakeMinio:
        def object_exists(self, key: str) -> bool:
            return key.endswith(("cameras.bin", "images.bin", "points3D.bin"))

    assert _has_colmap_sparse_outputs(FakeMinio(), upload) is True


def test_has_colmap_sparse_outputs_treats_storage_errors_as_missing() -> None:
    upload = SimpleNamespace(user_id="user-1", id="upload-1")

    class FailingMinio:
        def object_exists(self, key: str) -> bool:
            raise RuntimeError("minio unavailable")

    assert _has_colmap_sparse_outputs(FailingMinio(), upload) is False
