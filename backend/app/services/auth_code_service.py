"""One-time authorization code store (Redis-backed).

OAuth 콜백에서 발급한 JWT를 URL에 직접 싣는 대신,
짧은 수명의 1회용 코드를 발급해 Redis에 토큰을 잠시 저장하고,
프론트엔드가 POST /api/auth/exchange 로 코드를 제출해 세션 쿠키를 설정한다.
"""

import json
import secrets

from app.services.redis_one_time_store import getdel_raw, set_json_with_ttl

# 1회용 코드 유효 시간(초). 사용자 리다이렉트 후 즉시 exchange 호출하므로 짧게.
AUTH_CODE_TTL_SECONDS = 60
_KEY_PREFIX = "auth_code:"


def _key(code: str) -> str:
    return f"{_KEY_PREFIX}{code}"


async def issue_auth_code(access_token: str, refresh_token: str, expires_in: int) -> str:
    """access/refresh 토큰을 Redis에 잠시 저장하고 1회용 코드를 반환."""
    code = secrets.token_urlsafe(32)
    payload = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": expires_in,
    }
    await set_json_with_ttl(_key(code), payload, AUTH_CODE_TTL_SECONDS)

    return code


async def consume_auth_code(code: str) -> dict | None:
    """코드를 소비(원자적 GETDEL)하고 토큰 페이로드를 반환. 없으면 None."""
    raw = await getdel_raw(_key(code))

    if raw is None:
        return None
    return json.loads(raw)
