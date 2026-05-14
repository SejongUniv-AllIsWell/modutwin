"""WebSocket 1회용 ticket 발급/소비 (Redis-backed).

WS 핸드셰이크 인증을 단명(60s)·1회용 ticket으로 분리한다.
- access token을 URL query에 싣지 않아 nginx/CF 로그·브라우저 history 노출을 막는다.
- WS 수명을 access token 수명(30min)에서 분리: 핸드셰이크 한 번만 인증, 이후 연결은 물리적으로 끊길 때까지 유지.
"""

import json
import secrets

from app.services.redis_one_time_store import getdel_raw, set_json_with_ttl

WS_TICKET_TTL_SECONDS = 60
_KEY_PREFIX = "ws_ticket:"


def _key(ticket: str) -> str:
    return f"{_KEY_PREFIX}{ticket}"


async def issue_ws_ticket(user_id: str, role: str) -> str:
    """user_id를 Redis에 잠시 저장하고 1회용 ticket을 반환."""
    ticket = secrets.token_urlsafe(32)
    payload = {"user_id": user_id, "role": role}
    await set_json_with_ttl(_key(ticket), payload, WS_TICKET_TTL_SECONDS)

    return ticket


async def consume_ws_ticket(ticket: str) -> dict | None:
    """ticket을 원자적으로 소비(GETDEL)하고 페이로드를 반환. 없으면 None."""
    if not ticket:
        return None
    raw = await getdel_raw(_key(ticket))

    if raw is None:
        return None
    return json.loads(raw)
