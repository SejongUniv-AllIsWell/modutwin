import os
import re
import time

from app.core.storage_keys import is_key_under_prefix, normalize_minio_key

_SAFE_PATH_PART_PATTERN = re.compile(r"[^A-Za-z0-9._-]")


def module_folder(module_id: str, module_name: str) -> str:
    return f"{module_id}_{module_name}"


def module_base_path(building_id: str, floor_id: str, module_id: str, module_name: str) -> str:
    return f"buildings/{building_id}/{floor_id}/modules/{module_folder(module_id, module_name)}"


def object_dir(object_key: str) -> str:
    return os.path.dirname(object_key)


def refined_prefix(upload_minio_path: str) -> str:
    return f"{object_dir(upload_minio_path)}/refined"


def build_refined_object_key(
    upload_minio_path: str,
    filename: str,
    session_id: str | None = None,
    *,
    timestamp_ms: int | None = None,
) -> str:
    safe_name = _SAFE_PATH_PART_PATTERN.sub("_", filename) or "refined.ply"
    prefix = refined_prefix(upload_minio_path)

    if session_id:
        safe_session = _SAFE_PATH_PART_PATTERN.sub("_", session_id)[:64]
        if not safe_session:
            raise ValueError("invalid session_id")
        return f"{prefix}/{safe_session}/{safe_name}"

    if timestamp_ms is None:
        timestamp_ms = int(time.time() * 1000)
    return f"{prefix}/{int(timestamp_ms)}_{safe_name}"


def normalize_refined_key_for_upload(candidate_key: str, upload_minio_path: str) -> str:
    normalized_key = normalize_minio_key(candidate_key)
    if not is_key_under_prefix(normalized_key, refined_prefix(upload_minio_path)):
        raise ValueError("key must be under refined prefix")
    return normalized_key


def doors_json_key(upload_minio_path: str) -> str:
    return f"{refined_prefix(upload_minio_path)}/doors.json"


def door_position_key(scene_ply_path: str) -> str:
    return f"{object_dir(scene_ply_path)}/door_position.json"


def session_dir_from_scene_key(scene_ply_path: str) -> str:
    return object_dir(scene_ply_path)


def mesh_meta_key(session_dir: str) -> str:
    return f"{session_dir}/mesh.json"


def session_file_key(session_dir: str, filename: str) -> str:
    return f"{session_dir}/{filename}"
