from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.api.basemaps import _resolve_source_upload_id


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
