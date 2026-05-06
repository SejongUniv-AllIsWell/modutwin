import posixpath


def normalize_minio_key(key: str) -> str:
    """MinIO object key를 정규화하고 traversal 형태를 차단한다."""
    candidate = (key or "").strip().replace("\\", "/")
    if not candidate:
        raise ValueError("MinIO key is empty.")
    if candidate.startswith("/"):
        raise ValueError("MinIO key must be relative.")

    normalized = posixpath.normpath(candidate)
    if normalized in {"", "."}:
        raise ValueError("MinIO key is invalid.")
    if normalized == ".." or normalized.startswith("../"):
        raise ValueError("MinIO key escapes base path.")
    if normalized != candidate:
        raise ValueError("MinIO key must be canonical.")
    return normalized


def is_key_under_prefix(key: str, prefix: str) -> bool:
    """정규화 기준으로 key가 prefix 하위 경로인지 검사한다."""
    try:
        normalized_key = normalize_minio_key(key)
        normalized_prefix = normalize_minio_key(prefix.rstrip("/")).rstrip("/")
    except ValueError:
        return False

    if not normalized_prefix:
        return False
    return normalized_key == normalized_prefix or normalized_key.startswith(normalized_prefix + "/")
