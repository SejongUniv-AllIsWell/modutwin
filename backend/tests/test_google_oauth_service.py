import asyncio
import importlib

import pytest


def _reload_google_oauth_service():
    module = importlib.import_module("app.services.google_oauth_service")
    return importlib.reload(module)


def test_verify_google_id_token_success(required_env: dict[str, str], monkeypatch) -> None:
    google_oauth_service = _reload_google_oauth_service()

    monkeypatch.setattr(
        google_oauth_service.jwt,
        "get_unverified_header",
        lambda _: {"kid": "kid-1", "alg": "RS256"},
    )

    async def _fake_fetch(*, http_client=None, force_refresh=False):
        return {"keys": [{"kid": "kid-1", "kty": "RSA", "n": "x", "e": "AQAB"}]}

    monkeypatch.setattr(google_oauth_service, "fetch_google_jwks", _fake_fetch)

    decode_calls: list[str] = []

    def _fake_decode(*args, **kwargs):
        decode_calls.append(kwargs["issuer"])
        return {
            "sub": "google-sub-1",
            "iss": "https://accounts.google.com",
            "aud": "client-1",
            "nonce": "nonce-1",
            "email": "user@example.com",
            "email_verified": True,
        }

    monkeypatch.setattr(google_oauth_service.jwt, "decode", _fake_decode)

    claims = asyncio.run(
        google_oauth_service.verify_google_id_token(
            id_token="id-token",
            audience="client-1",
            expected_nonce="nonce-1",
        )
    )

    assert claims["sub"] == "google-sub-1"
    assert claims["email"] == "user@example.com"
    assert decode_calls == ["https://accounts.google.com"]


def test_verify_google_id_token_rejects_nonce_mismatch(
    required_env: dict[str, str], monkeypatch
) -> None:
    google_oauth_service = _reload_google_oauth_service()

    monkeypatch.setattr(
        google_oauth_service.jwt,
        "get_unverified_header",
        lambda _: {"kid": "kid-1", "alg": "RS256"},
    )

    async def _fake_fetch(*, http_client=None, force_refresh=False):
        return {"keys": [{"kid": "kid-1", "kty": "RSA", "n": "x", "e": "AQAB"}]}

    monkeypatch.setattr(google_oauth_service, "fetch_google_jwks", _fake_fetch)
    monkeypatch.setattr(
        google_oauth_service.jwt,
        "decode",
        lambda *args, **kwargs: {
            "sub": "google-sub-1",
            "iss": "https://accounts.google.com",
            "aud": "client-1",
            "nonce": "wrong-nonce",
        },
    )

    with pytest.raises(google_oauth_service.GoogleIdTokenValidationError) as exc_info:
        asyncio.run(
            google_oauth_service.verify_google_id_token(
                id_token="id-token",
                audience="client-1",
                expected_nonce="nonce-1",
            )
        )

    assert str(exc_info.value) == "nonce_mismatch"


def test_verify_google_id_token_rejects_unverified_email(
    required_env: dict[str, str], monkeypatch
) -> None:
    google_oauth_service = _reload_google_oauth_service()

    monkeypatch.setattr(
        google_oauth_service.jwt,
        "get_unverified_header",
        lambda _: {"kid": "kid-1", "alg": "RS256"},
    )

    async def _fake_fetch(*, http_client=None, force_refresh=False):
        return {"keys": [{"kid": "kid-1", "kty": "RSA", "n": "x", "e": "AQAB"}]}

    monkeypatch.setattr(google_oauth_service, "fetch_google_jwks", _fake_fetch)
    monkeypatch.setattr(
        google_oauth_service.jwt,
        "decode",
        lambda *args, **kwargs: {
            "sub": "google-sub-1",
            "iss": "https://accounts.google.com",
            "aud": "client-1",
            "nonce": "nonce-1",
            "email": "user@example.com",
            "email_verified": False,
        },
    )

    with pytest.raises(google_oauth_service.GoogleIdTokenValidationError) as exc_info:
        asyncio.run(
            google_oauth_service.verify_google_id_token(
                id_token="id-token",
                audience="client-1",
                expected_nonce="nonce-1",
            )
        )

    assert str(exc_info.value) == "email_not_verified"


def test_verify_google_id_token_falls_back_to_tokeninfo(
    required_env: dict[str, str], monkeypatch
) -> None:
    google_oauth_service = _reload_google_oauth_service()

    monkeypatch.setattr(
        google_oauth_service.jwt,
        "get_unverified_header",
        lambda _: {"kid": "kid-1", "alg": "RS256"},
    )

    async def _fake_fetch_jwks(*, http_client=None, force_refresh=False):
        return {"keys": [{"kid": "kid-1", "kty": "RSA", "n": "x", "e": "AQAB"}]}

    def _fake_decode(*args, **kwargs):
        raise google_oauth_service.JWTError("signature failed")

    async def _fake_tokeninfo(*, id_token=None, http_client=None):
        return {
            "sub": "google-sub-1",
            "iss": "https://accounts.google.com",
            "aud": "client-1",
            "exp": "4102444800",
            "nonce": "nonce-1",
            "email": "user@example.com",
            "email_verified": "true",
        }

    monkeypatch.setattr(google_oauth_service, "fetch_google_jwks", _fake_fetch_jwks)
    monkeypatch.setattr(google_oauth_service.jwt, "decode", _fake_decode)
    monkeypatch.setattr(google_oauth_service, "fetch_google_tokeninfo", _fake_tokeninfo)

    claims = asyncio.run(
        google_oauth_service.verify_google_id_token(
            id_token="id-token",
            audience="client-1",
            expected_nonce="nonce-1",
        )
    )

    assert claims["sub"] == "google-sub-1"
