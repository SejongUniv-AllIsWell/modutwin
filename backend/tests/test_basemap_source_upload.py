from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.api.basemaps import _resolve_basemap_viewer_key, _resolve_source_upload_id


class _FakeMinio:
    def __init__(self, existing: set[str]):
        self.existing = existing

    def object_exists(self, key: str) -> bool:
        return key in self.existing


@pytest.mark.asyncio
async def test_resolve_source_upload_id_prefers_direct_column() -> None:
    source_upload_id = uuid4()
    basemap = SimpleNamespace(source_upload_id=source_upload_id, minio_path="any/path.ply")
    db = SimpleNamespace(execute=AsyncMock())

    resolved = await _resolve_source_upload_id(db, basemap)

    assert resolved == source_upload_id
    db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_resolve_source_upload_id_falls_back_to_legacy_path_lookup() -> None:
    fallback_upload_id = uuid4()
    basemap = SimpleNamespace(source_upload_id=None, minio_path="buildings/x/refined.ply")
    db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: fallback_upload_id)))

    resolved = await _resolve_source_upload_id(db, basemap)

    assert resolved == fallback_upload_id
    db.execute.assert_called_once()


@pytest.mark.asyncio
async def test_resolve_basemap_viewer_key_prefers_persisted_sog() -> None:
    scene = SimpleNamespace(ply_path="basemap/final.ply", sog_path="basemap/final.sog")
    basemap = SimpleNamespace(minio_path="basemap/final.ply")
    db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: scene)))
    minio = _FakeMinio({"basemap/final.ply", "basemap/final.sog"})

    resolved = await _resolve_basemap_viewer_key(db, minio, basemap)

    assert resolved == "basemap/final.sog"


@pytest.mark.asyncio
async def test_resolve_basemap_viewer_key_falls_back_to_basemap_ply() -> None:
    basemap = SimpleNamespace(minio_path="basemap/final.ply")
    db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: None)))
    minio = _FakeMinio({"basemap/final.ply", "basemap/final.sog"})

    resolved = await _resolve_basemap_viewer_key(db, minio, basemap)

    assert resolved == "basemap/final.ply"


@pytest.mark.asyncio
async def test_resolve_basemap_viewer_key_returns_none_when_no_asset_exists() -> None:
    basemap = SimpleNamespace(minio_path="basemap/final.ply")
    db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: None)))
    minio = _FakeMinio(set())

    resolved = await _resolve_basemap_viewer_key(db, minio, basemap)

    assert resolved is None
