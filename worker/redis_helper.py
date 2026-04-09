import os
import json
import redis

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

_redis_client = None


def get_redis_client() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(REDIS_URL, decode_responses=True)
    return _redis_client


def update_progress(task_id: str, progress: int, module_name: str = ""):
    """Redis에 태스크 진행률 업데이트"""
    client = get_redis_client()
    data = json.dumps({
        "progress": progress,
        "module": module_name,
    })
    client.set(f"task:progress:{task_id}", data)


def clear_progress(task_id: str):
    """태스크 완료 시 진행률 키 삭제"""
    client = get_redis_client()
    client.delete(f"task:progress:{task_id}")
