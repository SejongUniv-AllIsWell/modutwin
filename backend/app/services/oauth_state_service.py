"""OAuth state/PKCE/nonce store (Redis-backed).

Google OAuth 요청마다 단명(600s) state를 발급하고,
state에 연결된 code_verifier/nonce/redirect_uri를 Redis에 저장한다.
callback에서 state를 1회용으로 소비(GETDEL)해 CSRF/PKCE 검증 재료로 사용한다.
"""

import base64
import hashlib
import json
import secrets

import redis.asyncio as aioredis

from app.core.config import get_settings

settings = get_settings()

OAUTH_STATE_TTL_SECONDS = 600
_KEY_PREFIX = "oauth_state:"


def _key(state: str) -> str:
    return f"{_KEY_PREFIX}{state}"


def generate_code_verifier() -> str:
    """PKCE code_verifier 생성."""
    return secrets.token_urlsafe(64)


def code_challenge_s256(verifier: str) -> str:
    """PKCE S256 code_challenge 생성."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


async def issue_oauth_state(redirect_uri: str) -> dict[str, str]:
    """OAuth state를 발급하고 Redis에 관련 payload를 저장."""
    state = secrets.token_urlsafe(32)
    code_verifier = generate_code_verifier()
    nonce = secrets.token_urlsafe(32)
    payload = json.dumps(
        {
            "code_verifier": code_verifier,
            "nonce": nonce,
            "redirect_uri": redirect_uri,
        }
    )

    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        await client.set(_key(state), payload, ex=OAUTH_STATE_TTL_SECONDS)
    finally:
        await client.aclose()

    return {
        "state": state,
        "code_challenge": code_challenge_s256(code_verifier),
        "nonce": nonce,
    }


async def consume_oauth_state(state: str | None) -> dict | None:
    """state를 1회용으로 소비(GETDEL)하고 payload를 반환. 없거나 파싱 실패면 None."""
    if not state:
        return None

    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        raw = await client.getdel(_key(state))
    finally:
        await client.aclose()

    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None
