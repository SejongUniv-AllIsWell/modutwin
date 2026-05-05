"""WebSocket 엔드포인트.

설계 원칙:
- 핸드셰이크 인증은 1회용 ticket을 `Sec-WebSocket-Protocol`로만 전달한다.
- WS 수명은 access token 수명과 무관하다. 한 번 인증되면 물리적으로 끊길 때까지 유지.
- 같은 user_id가 여러 connection을 가질 수 있다(멀티 탭). 알림은 모든 connection에 fanout.
- 서버 측 keepalive ping을 주기적으로 보내 dead connection을 빠르게 감지(half-open NAT 등).

Close codes:
- 1000 정상 종료 / 1001 going away
- 4401 ticket 무효·만료(클라는 새 ticket 발급 후 재시도)
- 4400 잘못된 요청
"""

import asyncio
import base64
import binascii
import json
import logging
import uuid
from typing import Dict, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.ws_ticket_service import consume_ws_ticket

logger = logging.getLogger(__name__)
router = APIRouter()

# 서버 → 클라 keepalive 주기. 무료 Cloudflare WS idle timeout(~100s)·각종 NAT 만료 보다 넉넉히 짧게.
SERVER_PING_INTERVAL_SECONDS = 25
WS_TICKET_SUBPROTOCOL = "ticket"
WS_TICKET_PROTOCOL_PREFIX = "ticket."


class ConnectionManager:
    """user_id → set[WebSocket] 매핑. 멀티 탭/디바이스 동시 접속 지원."""

    def __init__(self) -> None:
        self._by_user: Dict[str, Set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def add(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._by_user.setdefault(user_id, set()).add(ws)

    async def remove(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._by_user.get(user_id)
            if conns is None:
                return
            conns.discard(ws)
            if not conns:
                self._by_user.pop(user_id, None)

    def is_online(self, user_id: str) -> bool:
        return bool(self._by_user.get(user_id))

    async def send_to_user(self, user_id: str, message: dict) -> bool:
        """user의 모든 connection에 fanout. 하나라도 성공이면 True.

        실패한 socket은 즉시 제거하지 않는다(receive 루프의 except가 정리).
        """
        # snapshot — 전송 도중 set 변경에 대비
        conns = list(self._by_user.get(user_id, set()))
        if not conns:
            return False

        results = await asyncio.gather(
            *(ws.send_json(message) for ws in conns),
            return_exceptions=True,
        )
        return any(not isinstance(r, Exception) for r in results)


manager = ConnectionManager()


def _parse_ws_subprotocols(websocket: WebSocket) -> list[str]:
    raw = websocket.headers.get("sec-websocket-protocol", "")
    if not raw:
        return []
    return [token.strip() for token in raw.split(",") if token.strip()]


def _decode_ticket_protocol(token: str) -> str | None:
    if not token.startswith(WS_TICKET_PROTOCOL_PREFIX):
        return None
    encoded = token[len(WS_TICKET_PROTOCOL_PREFIX) :]
    if not encoded:
        return None

    padded = encoded + "=" * (-len(encoded) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None

    return decoded or None


def _extract_ticket_and_accept_protocol(websocket: WebSocket) -> tuple[str | None, str | None]:
    subprotocols = _parse_ws_subprotocols(websocket)
    if not subprotocols:
        return None, None

    if WS_TICKET_SUBPROTOCOL in subprotocols:
        marker_index = subprotocols.index(WS_TICKET_SUBPROTOCOL)
        # 권장 패턴: ["ticket", "ticket.<base64url(ticket)>"]
        for candidate in subprotocols[marker_index + 1 :]:
            ticket = _decode_ticket_protocol(candidate)
            if ticket:
                return ticket, WS_TICKET_SUBPROTOCOL
        # ticket marker는 있었지만 payload가 없거나 손상된 경우.
        # 그래도 marker를 선택해 브라우저가 연결을 성립시킨 뒤 4401 close code를 전달받게 한다.
        return None, WS_TICKET_SUBPROTOCOL

    # 호환 패턴: 단일 "ticket.<base64url(ticket)>"
    for token in subprotocols:
        ticket = _decode_ticket_protocol(token)
        if ticket:
            return ticket, token
    return None, None


async def _server_keepalive(ws: WebSocket) -> None:
    """주기적으로 ping을 보내 dead connection을 감지한다.

    Starlette WebSocket에는 표준 ping API가 없어 application-level ping을 보낸다.
    send 실패 시 receive 루프가 곧 disconnect로 빠지므로 여기서는 break만 한다.
    """
    try:
        while True:
            await asyncio.sleep(SERVER_PING_INTERVAL_SECONDS)
            try:
                await ws.send_json({"type": "ping"})
            except Exception:
                return
    except asyncio.CancelledError:
        return


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket 엔드포인트.

    연결: WS /api/ws + Sec-WebSocket-Protocol(ticket 전달)

    수신 메시지:
        {"type": "ping"} → {"type": "pong"}
        {"type": "pong"} (서버 ping에 대한 응답, 그냥 무시)

    발신 메시지:
        {"type": "ping"} (서버 keepalive)
        {"type": "progress" | "task_complete" | "task_failed" | "notification", ...}
    """
    ticket, accept_protocol = _extract_ticket_and_accept_protocol(websocket)
    payload = await consume_ws_ticket(ticket or "")
    if payload is None:
        # accept() 전에 close()하면 핸드셰이크가 4xx로 거절된다(브라우저는 close code를 못 본다).
        # accept 후 close하면 클라가 close code를 받을 수 있어 재시도 정책을 분기할 수 있다.
        await websocket.accept(subprotocol=accept_protocol)
        await websocket.close(code=4401, reason="invalid or expired ticket")
        return

    user_id = payload["user_id"]
    conn_id = uuid.uuid4().hex[:8]

    await websocket.accept(subprotocol=accept_protocol)
    await manager.add(user_id, websocket)
    logger.info("ws connect: user=%s conn=%s", user_id, conn_id)

    keepalive_task = asyncio.create_task(_server_keepalive(websocket))

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                await websocket.send_json({"type": "pong"})
            # 그 외 타입(특히 'pong')은 keepalive 응답으로 묵인
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning("ws error user=%s conn=%s err=%s", user_id, conn_id, e)
    finally:
        keepalive_task.cancel()
        try:
            await keepalive_task
        except (asyncio.CancelledError, Exception):
            pass
        await manager.remove(user_id, websocket)
        logger.info("ws disconnect: user=%s conn=%s", user_id, conn_id)
