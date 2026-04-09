"""One-time authorization code store (Redis-backed).

OAuth 콜백에서 발급한 JWT를 URL에 직접 싣는 대신,
짧은 수명의 1회용 코드를 발급해 Redis에 토큰을 잠시 저장하고,
프론트엔드가 POST /api/auth/exchange 로 코드 ↔ 토큰 교환을 수행한다.
"""

import json
import secrets

import redis.asyncio as aioredis

from app.core.config import get_settings

settings = get_settings()

# 1회용 코드 유효 시간(초). 사용자 리다이렉트 후 즉시 exchange 호출하므로 짧게.
AUTH_CODE_TTL_SECONDS = 60
_KEY_PREFIX = "auth_code:"


def _key(code: str) -> str:
    return f"{_KEY_PREFIX}{code}"


async def issue_auth_code(access_token: str, refresh_token: str, expires_in: int) -> str:
    """access/refresh 토큰을 Redis에 잠시 저장하고 1회용 코드를 반환."""
    code = secrets.token_urlsafe(32)
    payload = json.dumps(
        {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_in": expires_in,
        }
    )

    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        await client.set(_key(code), payload, ex=AUTH_CODE_TTL_SECONDS)
    finally:
        await client.aclose()

    return code


async def consume_auth_code(code: str) -> dict | None:
    """코드를 소비(원자적 GETDEL)하고 토큰 페이로드를 반환. 없으면 None."""
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        raw = await client.getdel(_key(code))
    finally:
        await client.aclose()

    if raw is None:
        return None
    return json.loads(raw)
