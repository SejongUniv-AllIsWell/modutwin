import asyncio
import importlib
from types import SimpleNamespace
from uuid import uuid4

from app.models import UserRole


def _reload_auth_module():
    module = importlib.import_module("app.api.auth")
    return importlib.reload(module)


class _DummyResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _DummyTokenAndUserinfoClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url: str, data: dict):
        return _DummyResponse(
            200,
            {
                "access_token": "google-access-token",
                "id_token": "google-id-token",
            },
        )

    async def get(self, url: str, headers: dict):
        return _DummyResponse(
            200,
            {
                "id": "untrusted-userinfo-id",
                "email": "untrusted@example.com",
                "name": "Name From UserInfo",
                "picture": "https://example.com/avatar.png",
            },
        )


class _DummyScalarResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _DummyDB:
    def __init__(self):
        self.added = []
        self.committed = False
        self.flushed = False

    async def execute(self, query):
        return _DummyScalarResult(None)

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        for obj in self.added:
            if hasattr(obj, "google_id"):
                obj.id = uuid4()
                obj.role = UserRole.user
        self.flushed = True

    async def commit(self):
        self.committed = True


def test_callback_redirects_on_invalid_id_token(required_env: dict[str, str], monkeypatch) -> None:
    auth = _reload_auth_module()

    monkeypatch.setattr(
        auth,
        "settings",
        SimpleNamespace(
            DEV_MODE=False,
            PUBLIC_BASE_URL="https://app.example.com",
            GOOGLE_CLIENT_ID="google-client-id",
            GOOGLE_CLIENT_SECRET="google-client-secret",
            ACCESS_TOKEN_EXPIRE_MINUTES=30,
            REFRESH_TOKEN_EXPIRE_DAYS=7,
        ),
    )

    async def _fake_consume_oauth_state(state: str | None):
        return {
            "redirect_uri": "https://app.example.com/api/auth/callback",
            "code_verifier": "pkce-verifier",
            "nonce": "stored-nonce",
        }

    async def _fake_verify_google_id_token(**kwargs):
        raise auth.GoogleIdTokenValidationError("nonce_mismatch")

    monkeypatch.setattr(auth, "consume_oauth_state", _fake_consume_oauth_state)
    monkeypatch.setattr(auth, "verify_google_id_token", _fake_verify_google_id_token)
    monkeypatch.setattr(auth.httpx, "AsyncClient", _DummyTokenAndUserinfoClient)

    response = asyncio.run(auth.callback(db=_DummyDB(), code="oauth-code", state="oauth-state"))

    assert response.status_code == 307
    assert response.headers["location"] == "https://app.example.com/login?error=invalid_id_token"


def test_callback_uses_verified_id_token_identity(required_env: dict[str, str], monkeypatch) -> None:
    auth = _reload_auth_module()

    monkeypatch.setattr(
        auth,
        "settings",
        SimpleNamespace(
            DEV_MODE=False,
            PUBLIC_BASE_URL="https://app.example.com",
            GOOGLE_CLIENT_ID="google-client-id",
            GOOGLE_CLIENT_SECRET="google-client-secret",
            ACCESS_TOKEN_EXPIRE_MINUTES=30,
            REFRESH_TOKEN_EXPIRE_DAYS=7,
        ),
    )

    async def _fake_consume_oauth_state(state: str | None):
        return {
            "redirect_uri": "https://app.example.com/api/auth/callback",
            "code_verifier": "pkce-verifier",
            "nonce": "stored-nonce",
        }

    async def _fake_verify_google_id_token(**kwargs):
        return {
            "sub": "verified-google-sub",
            "email": "verified@example.com",
            "nonce": "stored-nonce",
        }

    async def _fake_issue_auth_code(*, access_token: str, refresh_token: str, expires_in: int) -> str:
        assert access_token == "internal-access-token"
        assert refresh_token == "internal-refresh-token"
        return "issued-auth-code"

    monkeypatch.setattr(auth, "consume_oauth_state", _fake_consume_oauth_state)
    monkeypatch.setattr(auth, "verify_google_id_token", _fake_verify_google_id_token)
    monkeypatch.setattr(auth, "issue_auth_code", _fake_issue_auth_code)
    monkeypatch.setattr(auth, "create_access_token", lambda user_id, role: "internal-access-token")
    monkeypatch.setattr(auth, "create_refresh_token", lambda: "internal-refresh-token")
    monkeypatch.setattr(auth, "hash_token", lambda token: "refresh-token-hash")
    monkeypatch.setattr(auth.httpx, "AsyncClient", _DummyTokenAndUserinfoClient)

    db = _DummyDB()
    response = asyncio.run(auth.callback(db=db, code="oauth-code", state="oauth-state"))

    user = next(item for item in db.added if hasattr(item, "google_id"))
    assert user.google_id == "verified-google-sub"
    assert user.email == "verified@example.com"
    assert user.name == "Name From UserInfo"
    assert user.avatar_url == "https://example.com/avatar.png"

    assert db.flushed is True
    assert db.committed is True
    assert response.status_code == 307
    assert response.headers["location"] == "https://app.example.com/login/callback?code=issued-auth-code"
