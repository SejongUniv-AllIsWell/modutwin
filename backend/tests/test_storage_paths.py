import pytest

from app.services.storage_paths import (
    build_refined_object_key,
    door_position_key,
    doors_json_key,
    mesh_meta_key,
    module_base_path,
    module_folder,
    normalize_refined_key_for_upload,
    refined_prefix,
    session_dir_from_scene_key,
    session_file_key,
)


def test_module_path_helpers_match_existing_shape() -> None:
    assert module_folder("m-1", "moduleA") == "m-1_moduleA"
    assert (
        module_base_path("b-1", "f-2", "m-1", "moduleA")
        == "buildings/b-1/f-2/modules/m-1_moduleA"
    )


def test_refined_object_key_with_session_keeps_sanitize_behavior() -> None:
    upload_key = "buildings/b/f/modules/m_mod/alignment/input_local.ply"
    key = build_refined_object_key(
        upload_minio_path=upload_key,
        filename="refined model.ply",
        session_id="session!/?",
    )
    assert key == "buildings/b/f/modules/m_mod/alignment/refined/session___/refined_model.ply"


def test_refined_object_key_without_session_uses_legacy_timestamp_prefix() -> None:
    upload_key = "buildings/b/f/modules/m_mod/gsplat/input.ply"
    key = build_refined_object_key(
        upload_minio_path=upload_key,
        filename="",
        session_id=None,
        timestamp_ms=1700000000000,
    )
    assert key == "buildings/b/f/modules/m_mod/gsplat/refined/1700000000000_refined.ply"


def test_refined_related_key_helpers() -> None:
    upload_key = "buildings/b/f/modules/m_mod/gsplat/input.ply"
    assert refined_prefix(upload_key) == "buildings/b/f/modules/m_mod/gsplat/refined"
    assert doors_json_key(upload_key) == "buildings/b/f/modules/m_mod/gsplat/refined/doors.json"

    scene_key = "buildings/b/f/modules/m_mod/gsplat/refined/s1/refined.ply"
    assert session_dir_from_scene_key(scene_key) == "buildings/b/f/modules/m_mod/gsplat/refined/s1"
    assert mesh_meta_key(session_dir_from_scene_key(scene_key)) == "buildings/b/f/modules/m_mod/gsplat/refined/s1/mesh.json"
    assert session_file_key(session_dir_from_scene_key(scene_key), "tex.png") == "buildings/b/f/modules/m_mod/gsplat/refined/s1/tex.png"
    assert door_position_key(scene_key) == "buildings/b/f/modules/m_mod/gsplat/refined/s1/door_position.json"


def test_normalize_refined_key_for_upload_requires_canonical_key_under_refined_prefix() -> None:
    upload_key = "buildings/b/f/modules/m_mod/gsplat/input.ply"
    valid_key = "buildings/b/f/modules/m_mod/gsplat/refined/s1/refined.ply"
    assert normalize_refined_key_for_upload(valid_key, upload_key) == valid_key

    with pytest.raises(ValueError):
        normalize_refined_key_for_upload("buildings/b/f/modules/m_mod/gsplat/refined/../oops.ply", upload_key)

    with pytest.raises(ValueError):
        normalize_refined_key_for_upload("buildings/b/f/modules/m_mod/gsplat/raw/input.ply", upload_key)
