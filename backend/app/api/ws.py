import json
import logging
from typing import Dict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from jose import JWTError, jwt

from app.core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter()


class ConnectionManager:
    """WebSocket 접속 관리자"""

    def __init__(self):
        # user_id → WebSocket 매핑
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, user_id: str, websocket: WebSocket):
        await websocket.accept()
        # 기존 연결이 있으면 끊기
        if user_id in self.active_connections:
            try:
                await self.active_connections[user_id].close()
            except Exception:
                pass
        self.active_connections[user_id] = websocket
        logger.info(f"WebSocket 연결: user_id={user_id}")

    def disconnect(self, user_id: str):
        self.active_connections.pop(user_id, None)
        logger.info(f"WebSocket 해제: user_id={user_id}")

    def is_online(self, user_id: str) -> bool:
        return user_id in self.active_connections

    async def send_to_user(self, user_id: str, message: dict) -> bool:
        """특정 사용자에게 메시지 전송. 성공하면 True."""
        ws = self.active_connections.get(user_id)
        if ws is None:
            return False
        try:
            await ws.send_json(message)
            return True
        except Exception:
            self.disconnect(user_id)
            return False


# 싱글톤 매니저
manager = ConnectionManager()


def _verify_ws_token(token: str) -> str | None:
    """JWT 토큰 검증 → user_id 반환, 실패 시 None"""
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        if payload.get("type") != "access":
            return None
        return payload.get("sub")
    except JWTError:
        return None


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str = Query(default=""),
):
    """WebSocket 엔드포인트

    연결: WS /api/ws?token={jwt_access_token}

    수신 메시지 형식:
        {"type": "ping"}

    발신 메시지 형식:
        {"type": "progress", "task_id": "...", "progress": 50, "module": "COLMAP"}
        {"type": "task_complete", "task_id": "...", "message": "..."}
        {"type": "task_failed", "task_id": "...", "message": "..."}
        {"type": "notification", "message": "...", "notification_type": "..."}
    """
    # 토큰 검증
    user_id = _verify_ws_token(token)
    if user_id is None:
        await websocket.close(code=4001, reason="인증 실패")
        return

    await manager.connect(user_id, websocket)

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        manager.disconnect(user_id)
