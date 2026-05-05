import asyncio
import importlib


def _reload_ws_ticket_service():
    module = importlib.import_module("app.services.ws_ticket_service")
    return importlib.reload(module)


def _reload_auth_code_service():
    module = importlib.import_module("app.services.auth_code_service")
    return importlib.reload(module)


def test_ws_ticket_key_has_expected_prefix(required_env: dict[str, str]) -> None:
    ws_ticket_service = _reload_ws_ticket_service()
    assert ws_ticket_service._key("abc123") == "ws_ticket:abc123"


def test_auth_code_key_has_expected_prefix(required_env: dict[str, str]) -> None:
    auth_code_service = _reload_auth_code_service()
    assert auth_code_service._key("abc123") == "auth_code:abc123"


def test_consume_ws_ticket_with_blank_ticket_skips_redis(
    required_env: dict[str, str], monkeypatch
) -> None:
    ws_ticket_service = _reload_ws_ticket_service()

    def _unexpected_call(*args, **kwargs):
        raise AssertionError("redis client should not be created for empty ticket")

    monkeypatch.setattr(ws_ticket_service.aioredis, "from_url", _unexpected_call)
    assert asyncio.run(ws_ticket_service.consume_ws_ticket("")) is None


def test_consume_ws_ticket_returns_payload_and_closes_client(
    required_env: dict[str, str], monkeypatch
) -> None:
    ws_ticket_service = _reload_ws_ticket_service()

    class DummyClient:
        def __init__(self) -> None:
            self.closed = False
            self.requested_key = None

        async def getdel(self, key: str):
            self.requested_key = key
            return '{"user_id":"u-1","role":"admin"}'

        async def aclose(self) -> None:
            self.closed = True

    client = DummyClient()
    monkeypatch.setattr(ws_ticket_service.aioredis, "from_url", lambda *args, **kwargs: client)

    payload = asyncio.run(ws_ticket_service.consume_ws_ticket("ticket-1"))

    assert payload == {"user_id": "u-1", "role": "admin"}
    assert client.requested_key == "ws_ticket:ticket-1"
    assert client.closed is True
