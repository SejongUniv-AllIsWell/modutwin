"""Google OAuth helpers for ID token validation."""

from __future__ import annotations

from datetime import datetime, timezone
from time import monotonic
from typing import Any

import httpx
from jose import JWTError, jwt

GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"
GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")
GOOGLE_ID_TOKEN_ALGORITHMS = ("RS256",)
_JWKS_CACHE_TTL_SECONDS = 3600
_jwks_cache: dict[str, Any] = {"expires_at": 0.0, "jwks": None}


class GoogleIdTokenValidationError(ValueError):
    """Raised when Google ID token validation fails."""


def _select_jwk(jwks: dict[str, Any], kid: str) -> dict[str, Any] | None:
    keys = jwks.get("keys")
    if not isinstance(keys, list):
        return None
    for key in keys:
        if isinstance(key, dict) and key.get("kid") == kid:
            return key
    return None


async def fetch_google_jwks(
    *,
    http_client: httpx.AsyncClient | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    now = monotonic()
    if not force_refresh and _jwks_cache["jwks"] is not None and now < _jwks_cache["expires_at"]:
        return _jwks_cache["jwks"]

    owns_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=5.0)
    try:
        response = await client.get(GOOGLE_JWKS_URL)
    except Exception as exc:
        raise GoogleIdTokenValidationError("jwks_fetch_failed") from exc
    finally:
        if owns_client:
            await client.aclose()

    if response.status_code != 200:
        raise GoogleIdTokenValidationError("jwks_fetch_failed")

    jwks = response.json()
    if not isinstance(jwks, dict) or not isinstance(jwks.get("keys"), list):
        raise GoogleIdTokenValidationError("jwks_invalid")

    _jwks_cache["jwks"] = jwks
    _jwks_cache["expires_at"] = monotonic() + _JWKS_CACHE_TTL_SECONDS
    return jwks


async def fetch_google_tokeninfo(
    *,
    id_token: str | None,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    if not id_token:
        raise GoogleIdTokenValidationError("missing_id_token")

    owns_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=5.0)
    try:
        response = await client.get(GOOGLE_TOKENINFO_URL, params={"id_token": id_token})
    except Exception as exc:
        raise GoogleIdTokenValidationError("tokeninfo_fetch_failed") from exc
    finally:
        if owns_client:
            await client.aclose()

    if response.status_code != 200:
        raise GoogleIdTokenValidationError("tokeninfo_rejected")

    claims = response.json()
    if not isinstance(claims, dict):
        raise GoogleIdTokenValidationError("tokeninfo_invalid")
    return claims


def _validate_common_claims(
    claims: dict[str, Any],
    *,
    audience: str,
    expected_nonce: str,
    require_exp_check: bool,
) -> dict[str, Any]:
    issuer = claims.get("iss")
    if issuer not in GOOGLE_ISSUERS:
        raise GoogleIdTokenValidationError("invalid_issuer")

    if claims.get("aud") != audience:
        raise GoogleIdTokenValidationError("invalid_audience")

    if require_exp_check:
        try:
            expires_at = int(claims.get("exp", "0"))
        except (TypeError, ValueError) as exc:
            raise GoogleIdTokenValidationError("invalid_expiry") from exc

        if expires_at <= int(datetime.now(timezone.utc).timestamp()):
            raise GoogleIdTokenValidationError("expired_id_token")

    if claims.get("nonce") != expected_nonce:
        raise GoogleIdTokenValidationError("nonce_mismatch")

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise GoogleIdTokenValidationError("invalid_subject")

    email = claims.get("email")
    if email is not None:
        if not isinstance(email, str) or not email:
            raise GoogleIdTokenValidationError("invalid_email")
        email_verified = claims.get("email_verified")
        if email_verified in (False, "false", "False", 0, "0"):
            raise GoogleIdTokenValidationError("email_not_verified")

    return claims


async def _verify_google_id_token_with_jwks(
    *,
    id_token: str,
    audience: str,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    if not audience:
        raise GoogleIdTokenValidationError("missing_audience")

    try:
        header = jwt.get_unverified_header(id_token)
    except JWTError as exc:
        raise GoogleIdTokenValidationError("invalid_id_token_header") from exc

    kid = header.get("kid")
    alg = header.get("alg")
    if not kid or alg not in GOOGLE_ID_TOKEN_ALGORITHMS:
        raise GoogleIdTokenValidationError("invalid_id_token_header")

    jwks = await fetch_google_jwks(http_client=http_client)
    key = _select_jwk(jwks, kid)
    if key is None:
        jwks = await fetch_google_jwks(http_client=http_client, force_refresh=True)
        key = _select_jwk(jwks, kid)
    if key is None:
        raise GoogleIdTokenValidationError("jwks_kid_not_found")

    claims: dict[str, Any] | None = None
    last_error: Exception | None = None
    for issuer in GOOGLE_ISSUERS:
        try:
            claims = jwt.decode(
                id_token,
                key,
                algorithms=list(GOOGLE_ID_TOKEN_ALGORITHMS),
                audience=audience,
                issuer=issuer,
            )
            break
        except JWTError as exc:
            last_error = exc

    if claims is None:
        raise GoogleIdTokenValidationError("invalid_id_token") from last_error

    return claims


async def verify_google_id_token(
    *,
    id_token: str | None,
    audience: str,
    expected_nonce: str,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    if not id_token:
        raise GoogleIdTokenValidationError("missing_id_token")
    if not audience:
        raise GoogleIdTokenValidationError("missing_audience")
    if not expected_nonce:
        raise GoogleIdTokenValidationError("missing_nonce")

    try:
        jwks_claims = await _verify_google_id_token_with_jwks(
            id_token=id_token,
            audience=audience,
            http_client=http_client,
        )
        return _validate_common_claims(
            jwks_claims,
            audience=audience,
            expected_nonce=expected_nonce,
            require_exp_check=False,
        )
    except GoogleIdTokenValidationError as exc:
        if str(exc) not in {
            "jwks_fetch_failed",
            "jwks_invalid",
            "jwks_kid_not_found",
            "invalid_id_token",
        }:
            raise

    tokeninfo_claims = await fetch_google_tokeninfo(
        id_token=id_token,
        http_client=http_client,
    )
    return _validate_common_claims(
        tokeninfo_claims,
        audience=audience,
        expected_nonce=expected_nonce,
        require_exp_check=True,
    )
