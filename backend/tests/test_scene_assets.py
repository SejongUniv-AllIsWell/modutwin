from types import SimpleNamespace

from app.services.scene_assets import pick_scene_viewer_key


class _FakeMinio:
    def __init__(self, existing: set[str]):
        self.existing = existing

    def object_exists(self, key: str) -> bool:
        return key in self.existing


def test_pick_scene_viewer_key_prefers_persisted_sog() -> None:
    scene = SimpleNamespace(ply_path="scenes/final.ply", sog_path="scenes/final.sog")
    minio = _FakeMinio({"scenes/final.ply", "scenes/final.sog"})

    assert pick_scene_viewer_key(minio, scene) == "scenes/final.sog"


def test_pick_scene_viewer_key_falls_back_to_ply_when_sog_missing() -> None:
    scene = SimpleNamespace(ply_path="scenes/final.ply", sog_path="scenes/final.sog")
    minio = _FakeMinio({"scenes/final.ply"})

    assert pick_scene_viewer_key(minio, scene) == "scenes/final.ply"


def test_pick_scene_viewer_key_ignores_unpersisted_sibling_sog() -> None:
    scene = SimpleNamespace(ply_path="scenes/final.ply", sog_path=None)
    minio = _FakeMinio({"scenes/final.ply", "scenes/final.sog"})

    assert pick_scene_viewer_key(minio, scene) == "scenes/final.ply"


def test_pick_scene_viewer_key_returns_none_without_available_assets() -> None:
    scene = SimpleNamespace(ply_path="scenes/final.ply", sog_path="scenes/final.sog")
    minio = _FakeMinio(set())

    assert pick_scene_viewer_key(minio, scene) is None
