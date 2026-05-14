from __future__ import annotations

from collections.abc import Iterable


def safe_object_exists(minio, key: str | None) -> bool:
    if not key:
        return False
    try:
        return bool(minio.object_exists(key))
    except Exception:
        return False


def safe_presigned_download_url(minio, key: str | None, expires: int | None = None) -> str | None:
    if not safe_object_exists(minio, key):
        return None
    try:
        if expires is None:
            return minio.get_presigned_download_url(key)
        return minio.get_presigned_download_url(key, expires=expires)
    except Exception:
        return None


def add_storage_key(keys: set[str], key: str | None) -> None:
    if key:
        normalized = key.strip()
        if normalized:
            keys.add(normalized)


def delete_storage_best_effort(
    minio,
    prefixes: Iterable[str],
    keys: Iterable[str],
    *,
    sort_items: bool = False,
    suppress_errors: bool = True,
) -> int:
    deleted = 0
    prefix_iter = sorted(prefixes) if sort_items else prefixes
    for prefix in prefix_iter:
        try:
            deleted += minio.delete_prefix(prefix)
        except Exception:
            if not suppress_errors:
                raise

    key_iter = sorted(keys) if sort_items else keys
    for key in key_iter:
        try:
            if minio.delete_object(key):
                deleted += 1
        except Exception:
            if not suppress_errors:
                raise
    return deleted
