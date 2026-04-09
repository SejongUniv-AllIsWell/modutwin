import os

from minio import Minio

MINIO_ENDPOINT = os.environ.get("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY", "changeme123")
MINIO_BUCKET = os.environ.get("MINIO_BUCKET", "3dgs-platform")
MINIO_SECURE = os.environ.get("MINIO_SECURE", "false").lower() == "true"


def get_minio_client() -> Minio:
    return Minio(
        endpoint=MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=MINIO_SECURE,
    )


def download_file(minio_key: str, local_path: str) -> str:
    """MinIO에서 파일 다운로드"""
    client = get_minio_client()
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    client.fget_object(MINIO_BUCKET, minio_key, local_path)
    return local_path


def upload_file(local_path: str, minio_key: str, content_type: str = "application/octet-stream"):
    """MinIO에 파일 업로드"""
    client = get_minio_client()
    client.fput_object(MINIO_BUCKET, minio_key, local_path, content_type=content_type)
