import asyncio
import importlib
import json


def _reload_oauth_state_service():
    module = importlib.import_module("app.services.oauth_state_service")
    return importlib.reload(module)


def test_oauth_state_key_has_expected_prefix(required_env: dict[str, str]) -> None:
    oauth_state_service = _reload_oauth_state_service()
    assert oauth_state_service._key("abc123") == "oauth_state:abc123"


def test_code_challenge_s256_matches_known_vector(required_env: dict[str, str]) -> None:
    oauth_state_service = _reload_oauth_state_service()
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    assert oauth_state_service.code_challenge_s256(verifier) == expected


def test_generate_code_verifier_is_urlsafe_and_long_enough(required_env: dict[str, str]) -> None:
    oauth_state_service = _reload_oauth_state_service()
    verifier = oauth_state_service.generate_code_verifier()
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    assert 43 <= len(verifier) <= 128
    assert set(verifier) <= allowed


def test_consume_oauth_state_with_blank_state_skips_redis(
    required_env: dict[str, str], monkeypatch
) -> None:
    oauth_state_service = _reload_oauth_state_service()

    def _unexpected_call(*args, **kwargs):
        raise AssertionError("redis client should not be created for empty state")

    monkeypatch.setattr(oauth_state_service.aioredis, "from_url", _unexpected_call)
    assert asyncio.run(oauth_state_service.consume_oauth_state("")) is None
    assert asyncio.run(oauth_state_service.consume_oauth_state(None)) is None


def test_issue_oauth_state_stores_payload_and_closes_client(
    required_env: dict[str, str], monkeypatch
) -> None:
    oauth_state_service = _reload_oauth_state_service()

    class DummyClient:
        def __init__(self) -> None:
            self.closed = False
            self.set_calls: list[dict] = []

        async def set(self, key: str, value: str, ex: int) -> None:
            self.set_calls.append({"key": key, "value": value, "ex": ex})

        async def aclose(self) -> None:
            self.closed = True

    client = DummyClient()
    monkeypatch.setattr(oauth_state_service.aioredis, "from_url", lambda *args, **kwargs: client)

    issued = asyncio.run(oauth_state_service.issue_oauth_state("https://app.example.com/api/auth/callback"))

    assert {"state", "code_challenge", "nonce"} <= set(issued)
    assert len(client.set_calls) == 1
    assert client.set_calls[0]["key"] == f"oauth_state:{issued['state']}"
    assert client.set_calls[0]["ex"] == oauth_state_service.OAUTH_STATE_TTL_SECONDS
    stored_payload = json.loads(client.set_calls[0]["value"])
    assert stored_payload["redirect_uri"] == "https://app.example.com/api/auth/callback"
    assert stored_payload["nonce"] == issued["nonce"]
    assert (
        oauth_state_service.code_challenge_s256(stored_payload["code_verifier"])
        == issued["code_challenge"]
    )
    assert client.closed is True


def test_consume_oauth_state_returns_payload_and_closes_client(
    required_env: dict[str, str], monkeypatch
) -> None:
    oauth_state_service = _reload_oauth_state_service()

    class DummyClient:
        def __init__(self) -> None:
            self.closed = False
            self.requested_key = None

        async def getdel(self, key: str):
            self.requested_key = key
            return (
                '{"code_verifier":"v-1","nonce":"n-1",'
                '"redirect_uri":"https://app.example.com/api/auth/callback"}'
            )

        async def aclose(self) -> None:
            self.closed = True

    client = DummyClient()
    monkeypatch.setattr(oauth_state_service.aioredis, "from_url", lambda *args, **kwargs: client)

    payload = asyncio.run(oauth_state_service.consume_oauth_state("state-1"))

    assert payload == {
        "code_verifier": "v-1",
        "nonce": "n-1",
        "redirect_uri": "https://app.example.com/api/auth/callback",
    }
    assert client.requested_key == "oauth_state:state-1"
    assert client.closed is True
