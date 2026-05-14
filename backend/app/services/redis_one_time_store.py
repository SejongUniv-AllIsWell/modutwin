"""Shared helpers for Redis-backed one-time stores."""

import json

import redis.asyncio as aioredis

from app.core.config import get_settings

settings = get_settings()


async def set_json_with_ttl(key: str, payload: dict, ttl_seconds: int) -> None:
    """Serialize payload as JSON and store it with TTL."""
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        await client.set(key, json.dumps(payload), ex=ttl_seconds)
    finally:
        await client.aclose()


async def getdel_raw(key: str) -> str | None:
    """Atomically fetch-and-delete a value from Redis."""
    client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        return await client.getdel(key)
    finally:
        await client.aclose()
