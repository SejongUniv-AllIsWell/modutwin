from app.api.module_register import _looks_like_ply


def test_looks_like_ply_accepts_ply_header(tmp_path):
    path = tmp_path / "scene.ply"
    path.write_bytes(b"ply\nformat binary_little_endian 1.0\n")

    assert _looks_like_ply(path) is True


def test_looks_like_ply_rejects_spz_like_zip_header(tmp_path):
    path = tmp_path / "scene.ply"
    path.write_bytes(b"PK\x03\x04means_l.webp")

    assert _looks_like_ply(path) is False
