from __future__ import annotations

from typing import Protocol

from app.services.storage_access import safe_object_exists


class SceneOutputLike(Protocol):
    ply_path: str
    sog_path: str | None


def pick_scene_viewer_key(minio, scene: SceneOutputLike | None) -> str | None:
    """Return the best storage key for read-only scene viewing.

    PLY is the canonical asset. SOG is an optional derived asset and is only
    preferred after the backend has explicitly persisted it on SceneOutput.
    This avoids changing viewer behavior just because a sibling .sog object
    happens to exist in object storage.
    """
    if scene is None:
        return None
    if scene.sog_path and safe_object_exists(minio, scene.sog_path):
        return scene.sog_path
    if safe_object_exists(minio, scene.ply_path):
        return scene.ply_path
    return None
