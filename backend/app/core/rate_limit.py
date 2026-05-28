"""In-process per-user token bucket rate limiter.

단일 워커 프로세스 가정. 다중 워커로 확장 시 Redis 백엔드로 교체할 것.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Callable

from fastapi import Depends, HTTPException, status

from app.core.security import get_current_user
from app.models import User


@dataclass
class _Bucket:
    tokens: float
    last_refill: float


class TokenBucketLimiter:
    def __init__(self, capacity: int, refill_per_second: float) -> None:
        if capacity <= 0 or refill_per_second <= 0:
            raise ValueError("capacity and refill_per_second must be positive")
        self.capacity = float(capacity)
        self.refill_per_second = refill_per_second
        self._buckets: dict[str, _Bucket] = {}
        self._lock = asyncio.Lock()

    async def consume(self, key: str, cost: float = 1.0) -> bool:
        now = time.monotonic()
        async with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = _Bucket(tokens=self.capacity, last_refill=now)
                self._buckets[key] = bucket
            elapsed = now - bucket.last_refill
            if elapsed > 0:
                bucket.tokens = min(self.capacity, bucket.tokens + elapsed * self.refill_per_second)
                bucket.last_refill = now
            if bucket.tokens >= cost:
                bucket.tokens -= cost
                return True
            return False


def rate_limited(
    limiter: TokenBucketLimiter,
    *,
    scope: str,
) -> Callable:
    """FastAPI dependency factory: 사용자별로 limiter 를 소비한다."""

    async def dependency(user: User = Depends(get_current_user)) -> User:
        key = f"{scope}:{user.id}"
        ok = await limiter.consume(key)
        if not ok:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.",
            )
        return user

    return dependency
