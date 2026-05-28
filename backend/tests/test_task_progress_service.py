import asyncio
import importlib
import json

import pytest


def _reload_task_progress_service():
    module = importlib.import_module("app.services.task_progress_service")
    return importlib.reload(module)


def test_task_progress_key_has_expected_prefix(required_env: dict[str, str]) -> None:
    task_progress_service = _reload_task_progress_service()
    assert task_progress_service._key("abc123") == "task:progress:abc123"
    assert task_progress_service._key(None) == "task:progress:None"


def test_read_task_progress_returns_decoded_payload_and_closes_client(
    required_env: dict[str, str], monkeypatch
) -> None:
    task_progress_service = _reload_task_progress_service()

    class DummyClient:
        def __init__(self) -> None:
            self.closed = False
            self.requested_key = None

        async def get(self, key: str):
            self.requested_key = key
            return json.dumps({"progress": 35, "module": "segment"})

        async def aclose(self) -> None:
            self.closed = True

    client = DummyClient()
    monkeypatch.setattr(task_progress_service.aioredis, "from_url", lambda *args, **kwargs: client)

    payload = asyncio.run(task_progress_service.read_task_progress("task-1"))

    assert payload == {"progress": 35, "module": "segment"}
    assert client.requested_key == "task:progress:task-1"
    assert client.closed is True


def test_read_task_progress_returns_none_for_missing_key_and_closes_client(
    required_env: dict[str, str], monkeypatch
) -> None:
    task_progress_service = _reload_task_progress_service()

    class DummyClient:
        def __init__(self) -> None:
            self.closed = False

        async def get(self, key: str):
            return None

        async def aclose(self) -> None:
            self.closed = True

    client = DummyClient()
    monkeypatch.setattr(task_progress_service.aioredis, "from_url", lambda *args, **kwargs: client)

    payload = asyncio.run(task_progress_service.read_task_progress("task-1"))

    assert payload is None
    assert client.closed is True


def test_read_task_progress_propagates_json_error(required_env: dict[str, str], monkeypatch) -> None:
    task_progress_service = _reload_task_progress_service()

    class DummyClient:
        def __init__(self) -> None:
            self.closed = False

        async def get(self, key: str):
            return "{bad-json"

        async def aclose(self) -> None:
            self.closed = True

    client = DummyClient()
    monkeypatch.setattr(task_progress_service.aioredis, "from_url", lambda *args, **kwargs: client)

    with pytest.raises(json.JSONDecodeError):
        asyncio.run(task_progress_service.read_task_progress("task-1"))
    assert client.closed is True


def test_read_task_progress_with_none_task_id_uses_none_key_and_closes_client(
    required_env: dict[str, str], monkeypatch
) -> None:
    task_progress_service = _reload_task_progress_service()

    class DummyClient:
        def __init__(self) -> None:
            self.closed = False
            self.requested_key = None

        async def get(self, key: str):
            self.requested_key = key
            return None

        async def aclose(self) -> None:
            self.closed = True

    client = DummyClient()
    monkeypatch.setattr(task_progress_service.aioredis, "from_url", lambda *args, **kwargs: client)

    payload = asyncio.run(task_progress_service.read_task_progress(None))

    assert payload is None
    assert client.requested_key == "task:progress:None"
    assert client.closed is True
