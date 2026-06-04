from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException


def _load_internal_worker():
    from app.core.config import get_settings

    get_settings.cache_clear()
    from app.api import internal_worker

    return internal_worker


def test_require_worker_token_rejects_blank_config(required_env, monkeypatch) -> None:
    internal_worker = _load_internal_worker()
    monkeypatch.setattr(internal_worker, "settings", SimpleNamespace(WORKER_CALLBACK_TOKEN=""))

    with pytest.raises(HTTPException) as exc_info:
        internal_worker._require_worker_token("secret")

    assert exc_info.value.status_code == 403


def test_require_worker_token_rejects_missing_or_wrong_header(required_env, monkeypatch) -> None:
    internal_worker = _load_internal_worker()
    monkeypatch.setattr(internal_worker, "settings", SimpleNamespace(WORKER_CALLBACK_TOKEN="secret"))

    with pytest.raises(HTTPException) as missing_info:
        internal_worker._require_worker_token(None)
    with pytest.raises(HTTPException) as wrong_info:
        internal_worker._require_worker_token("wrong")

    assert missing_info.value.status_code == 401
    assert wrong_info.value.status_code == 401


def test_require_worker_token_accepts_matching_header(required_env, monkeypatch) -> None:
    internal_worker = _load_internal_worker()
    monkeypatch.setattr(internal_worker, "settings", SimpleNamespace(WORKER_CALLBACK_TOKEN="secret"))

    assert internal_worker._require_worker_token("secret") is None


@pytest.mark.asyncio
async def test_worker_scene_sog_ready_sets_scene_sog_path(required_env, monkeypatch) -> None:
    internal_worker = _load_internal_worker()
    scene_id = uuid4()
    task_id = uuid4()
    scene = SimpleNamespace(id=scene_id, task_id=task_id, sog_path=None)

    class FakeDb:
        async def get(self, model, requested_id):
            assert model is internal_worker.SceneOutput
            assert requested_id == scene_id
            return scene

    class FakeMinio:
        def object_exists(self, key: str) -> bool:
            return key == "scenes/final.sog"

    monkeypatch.setattr(internal_worker, "get_minio_service", lambda: FakeMinio())

    response = await internal_worker.worker_scene_sog_ready(
        internal_worker.WorkerSogReadyRequest(scene_id=scene_id, sog_key="scenes/final.sog"),
        _auth=None,
        db=FakeDb(),
    )

    assert scene.sog_path == "scenes/final.sog"
    assert response.task_id == task_id
    assert response.scene_id == scene_id
    assert response.status == "completed"


@pytest.mark.asyncio
async def test_worker_scene_sog_ready_requires_existing_sog_object(required_env, monkeypatch) -> None:
    internal_worker = _load_internal_worker()
    scene_id = uuid4()
    scene = SimpleNamespace(id=scene_id, task_id=uuid4(), sog_path=None)

    class FakeDb:
        async def get(self, model, requested_id):
            return scene

    class FakeMinio:
        def object_exists(self, key: str) -> bool:
            return False

    monkeypatch.setattr(internal_worker, "get_minio_service", lambda: FakeMinio())

    with pytest.raises(HTTPException) as exc_info:
        await internal_worker.worker_scene_sog_ready(
            internal_worker.WorkerSogReadyRequest(scene_id=scene_id, sog_key="scenes/final.sog"),
            _auth=None,
            db=FakeDb(),
        )

    assert exc_info.value.status_code == 404
    assert scene.sog_path is None
