"""SAM3 자동 문 검출용 PLY 임시 저장소.

새 모듈 등록 흐름에서 파일 업로드 단계부터 백그라운드로 PLY를 백엔드로 보내두고,
정합 완료 전까지 영구 저장소(MinIO/DB)에 흔적을 남기지 않기 위함.

- 위치: /var/lib/sam3-temp/ (Docker volume `sam3-temp`)
- 파일명: {session_uuid}.ply
- TTL: 30분 (mtime 기준). 만료 파일은 주기적으로 자동 삭제.
- 청소 주기: 5분.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path

TEMP_DIR = Path("/var/lib/sam3-temp")
TTL_SECONDS = 30 * 60
CLEANUP_INTERVAL_SECONDS = 5 * 60
logger = logging.getLogger(__name__)


def ensure_temp_dir() -> None:
    TEMP_DIR.mkdir(parents=True, exist_ok=True)


def new_session_id() -> str:
    return uuid.uuid4().hex


def temp_path(session_id: str) -> Path:
    # 안전: session_id 에 path separator 들어가지 못하게 검증
    if "/" in session_id or "\\" in session_id or ".." in session_id:
        raise ValueError(f"invalid session id: {session_id!r}")
    return TEMP_DIR / f"{session_id}.ply"


def is_expired(path: Path) -> bool:
    if not path.exists():
        return True
    return (time.time() - path.stat().st_mtime) > TTL_SECONDS


def delete_temp(session_id: str) -> bool:
    path = temp_path(session_id)
    if path.exists():
        try:
            path.unlink()
            return True
        except OSError:
            return False
    return False


def cleanup_expired() -> int:
    """만료된 임시 PLY 파일 삭제. 삭제 개수 반환."""
    ensure_temp_dir()
    now = time.time()
    deleted = 0
    for f in TEMP_DIR.iterdir():
        if not f.is_file():
            continue
        try:
            if now - f.stat().st_mtime > TTL_SECONDS:
                f.unlink()
                deleted += 1
        except OSError:
            continue
    return deleted


async def cleanup_loop() -> None:
    """백엔드 lifespan 에서 백그라운드로 도는 루프. CLEANUP_INTERVAL_SECONDS 마다 청소."""
    ensure_temp_dir()
    while True:
        try:
            deleted = cleanup_expired()
            if deleted:
                logger.info(f"[sam3_temp] cleaned up {deleted} expired temp PLYs")
        except Exception as e:  # noqa: BLE001
            logger.exception(f"[sam3_temp] cleanup error: {e}")
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
