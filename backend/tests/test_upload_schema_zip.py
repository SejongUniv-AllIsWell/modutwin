from app.schemas.uploads import UploadInitRequest


def test_upload_init_accepts_zip_content_types() -> None:
    req = UploadInitRequest(
        filename="module_bundle.zip",
        file_size=1024,
        content_type="application/zip",
        building_id="00000000-0000-0000-0000-000000000001",
        floor_id="00000000-0000-0000-0000-000000000002",
        module_id="00000000-0000-0000-0000-000000000003",
        ply_target="gsplat",
    )
    assert req.content_type == "application/zip"

    req2 = UploadInitRequest(
        filename="module_bundle.zip",
        file_size=1024,
        content_type="application/x-zip-compressed",
        building_id="00000000-0000-0000-0000-000000000001",
        floor_id="00000000-0000-0000-0000-000000000002",
        module_id="00000000-0000-0000-0000-000000000003",
        ply_target="gsplat",
    )
    assert req2.content_type == "application/x-zip-compressed"
