import json
from typing import Any

import redis.asyncio as aioredis

from app.core.config import get_settings

settings = get_settings()


def _key(celery_task_id: str | None) -> str:
    return f"task:progress:{celery_task_id}"


async def read_task_progress(celery_task_id: str | None) -> dict[str, Any] | None:
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        data = await client.get(_key(celery_task_id))
        if not data:
            return None
        return json.loads(data)
    finally:
        await client.aclose()
