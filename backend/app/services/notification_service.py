import logging
from uuid import UUID
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.ws import manager
from app.core.database import async_session
from app.models import Notification, NotificationType

logger = logging.getLogger(__name__)


class NotificationService:
    """알림 서비스

    - 사용자 접속 중: WebSocket push
    - 사용자 미접속: DB 저장 → 다음 로그인 시 전달
    """

    async def notify(
        self,
        user_id: str,
        message: str,
        notification_type: NotificationType,
        related_task_id: Optional[str] = None,
    ):
        """사용자에게 알림 전송"""
        ws_message = {
            "type": "notification",
            "message": message,
            "notification_type": notification_type.value,
        }
        if related_task_id:
            ws_message["task_id"] = related_task_id

        # WebSocket으로 전송 시도
        sent = await manager.send_to_user(user_id, ws_message)

        if not sent:
            # 미접속 → DB 저장
            await self._save_to_db(user_id, message, notification_type, related_task_id)
            logger.info(f"알림 DB 저장: user_id={user_id}, type={notification_type.value}")

    async def notify_task_progress(
        self, user_id: str, task_id: str, progress: int, module: str,
    ):
        """태스크 진행률 알림 (WebSocket only, DB 저장 안 함)"""
        await manager.send_to_user(user_id, {
            "type": "progress",
            "task_id": task_id,
            "progress": progress,
            "module": module,
        })

    async def notify_task_complete(self, user_id: str, task_id: str, message: str):
        """태스크 완료 알림 — WebSocket 전송 실패 시 DB에 저장"""
        sent = await manager.send_to_user(user_id, {
            "type": "task_complete",
            "task_id": task_id,
            "message": message,
        })
        if not sent:
            await self._save_to_db(
                user_id, message, NotificationType.task_complete, task_id,
            )

    async def notify_task_failed(self, user_id: str, task_id: str, message: str):
        """태스크 실패 알림 — WebSocket 전송 실패 시 DB에 저장"""
        sent = await manager.send_to_user(user_id, {
            "type": "task_failed",
            "task_id": task_id,
            "message": message,
        })
        if not sent:
            await self._save_to_db(
                user_id, message, NotificationType.task_failed, task_id,
            )

    async def get_unread(self, user_id: str, db: AsyncSession) -> list[Notification]:
        """읽지 않은 알림 목록"""
        result = await db.execute(
            select(Notification)
            .where(Notification.user_id == user_id, Notification.is_read == False)
            .order_by(Notification.created_at.desc())
        )
        return result.scalars().all()

    async def mark_as_read(self, notification_id: int, user_id: str, db: AsyncSession) -> bool:
        """알림 읽음 처리"""
        result = await db.execute(
            select(Notification)
            .where(Notification.id == notification_id, Notification.user_id == user_id)
        )
        notification = result.scalar_one_or_none()
        if notification:
            notification.is_read = True
            await db.commit()
            return True
        return False

    async def mark_all_as_read(self, user_id: str, db: AsyncSession):
        """모든 알림 읽음 처리"""
        result = await db.execute(
            select(Notification)
            .where(Notification.user_id == user_id, Notification.is_read == False)
        )
        for notification in result.scalars().all():
            notification.is_read = True
        await db.commit()

    async def _save_to_db(
        self,
        user_id: str,
        message: str,
        notification_type: NotificationType,
        related_task_id: Optional[str] = None,
    ):
        """알림을 DB에 저장"""
        try:
            async with async_session() as session:
                notification = Notification(
                    user_id=user_id,
                    message=message,
                    type=notification_type,
                    related_task_id=related_task_id if related_task_id else None,
                )
                session.add(notification)
                await session.commit()
        except Exception as e:
            logger.error(f"알림 DB 저장 실패: {e}")


# 싱글톤
notification_service = NotificationService()
