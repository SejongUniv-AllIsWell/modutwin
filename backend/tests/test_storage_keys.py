import pytest

from app.core.storage_keys import is_key_under_prefix, normalize_minio_key


def test_normalize_minio_key_rejects_unsafe_keys() -> None:
    unsafe_keys = (
        "",
        "   ",
        "/absolute/key.ply",
        "../escape.ply",
        "folder/../escape.ply",
        "folder//file.ply",
    )

    for key in unsafe_keys:
        with pytest.raises(ValueError):
            normalize_minio_key(key)


def test_normalize_minio_key_accepts_clean_relative_keys() -> None:
    assert normalize_minio_key("buildings/demo/refined/model.ply") == "buildings/demo/refined/model.ply"


def test_is_key_under_prefix_requires_segment_boundary() -> None:
    assert is_key_under_prefix("buildings/a/refined/model.ply", "buildings/a/refined")
    assert is_key_under_prefix("buildings/a/refined/model.ply", "buildings/a/refined/")
    assert not is_key_under_prefix("buildings/a/refinedx/model.ply", "buildings/a/refined")
    assert not is_key_under_prefix("../buildings/a/refined/model.ply", "buildings/a/refined")
