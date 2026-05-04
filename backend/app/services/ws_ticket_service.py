"""WebSocket 1회용 ticket 발급/소비 (Redis-backed).

WS 핸드셰이크 인증을 단명(60s)·1회용 ticket으로 분리한다.
- access token을 URL query에 싣지 않아 nginx/CF 로그·브라우저 history 노출을 막는다.
- WS 수명을 access token 수명(30min)에서 분리: 핸드셰이크 한 번만 인증, 이후 연결은 물리적으로 끊길 때까지 유지.
"""

import json
import secrets

import redis.asyncio as aioredis

from app.core.config import get_settings

settings = get_settings()

WS_TICKET_TTL_SECONDS = 60
_KEY_PREFIX = "ws_ticket:"


def _key(ticket: str) -> str:
    return f"{_KEY_PREFIX}{ticket}"


async def issue_ws_ticket(user_id: str, role: str) -> str:
    """user_id를 Redis에 잠시 저장하고 1회용 ticket을 반환."""
    ticket = secrets.token_urlsafe(32)
    payload = json.dumps({"user_id": user_id, "role": role})

    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        await client.set(_key(ticket), payload, ex=WS_TICKET_TTL_SECONDS)
    finally:
        await client.aclose()

    return ticket


async def consume_ws_ticket(ticket: str) -> dict | None:
    """ticket을 원자적으로 소비(GETDEL)하고 페이로드를 반환. 없으면 None."""
    if not ticket:
        return None
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        raw = await client.getdel(_key(ticket))
    finally:
        await client.aclose()

    if raw is None:
        return None
    return json.loads(raw)
