from datetime import timedelta

from minio import Minio
from minio.datatypes import Part

from app.core.config import get_settings

settings = get_settings()

PART_SIZE = 10 * 1024 * 1024  # 10MB per part


def get_minio_client() -> Minio:
    return Minio(
        endpoint=settings.MINIO_ENDPOINT,
        access_key=settings.MINIO_ACCESS_KEY,
        secret_key=settings.MINIO_SECRET_KEY,
        secure=settings.MINIO_SECURE,
    )


def get_minio_public_client() -> Minio:
    """브라우저에서 접근 가능한 presigned URL 생성용 클라이언트"""
    return Minio(
        endpoint=settings.MINIO_PUBLIC_ENDPOINT,
        access_key=settings.MINIO_ACCESS_KEY,
        secret_key=settings.MINIO_SECRET_KEY,
        secure=settings.MINIO_PUBLIC_SECURE,
    )


class MinioService:
    def __init__(self):
        self.client = get_minio_client()
        self.public_client = get_minio_public_client()
        self.bucket = settings.MINIO_BUCKET
        # presigned URL 생성 시 region 조회 네트워크 요청을 방지하기 위해 캐시 선점
        # MinIO 단일 인스턴스는 항상 us-east-1 region을 사용
        self.public_client._region_map[self.bucket] = "us-east-1"

    def ensure_bucket(self):
        if not self.client.bucket_exists(self.bucket):
            self.client.make_bucket(self.bucket)
        # 버킷을 명시적으로 private으로 유지: 기존 public 정책이 있으면 제거
        try:
            self.client.delete_bucket_policy(self.bucket)
        except Exception:
            pass  # 설정된 정책이 없으면 무시 (기본 private)

    def init_multipart_upload(self, key: str, content_type: str) -> str:
        return self.client._create_multipart_upload(
            self.bucket, key, {"Content-Type": content_type}
        )

    def get_presigned_upload_url(
        self, key: str, upload_id: str, part_number: int, expires: int = 3600
    ) -> str:
        return self.public_client.get_presigned_url(
            "PUT",
            self.bucket,
            key,
            expires=timedelta(seconds=expires),
            extra_query_params={
                "uploadId": upload_id,
                "partNumber": str(part_number),
            },
        )

    def get_presigned_upload_urls(
        self, key: str, upload_id: str, part_count: int, expires: int = 3600
    ) -> list[str]:
        return [
            self.get_presigned_upload_url(key, upload_id, i, expires)
            for i in range(1, part_count + 1)
        ]

    def complete_multipart_upload(
        self, key: str, upload_id: str, parts: list[dict]
    ):
        minio_parts = [
            Part(p["part_number"], p["etag"])
            for p in sorted(parts, key=lambda x: x["part_number"])
        ]
        self.client._complete_multipart_upload(
            self.bucket, key, upload_id, minio_parts
        )

    def get_presigned_download_url(self, key: str, expires: int = 3600) -> str:
        return self.public_client.presigned_get_object(
            self.bucket, key, expires=timedelta(seconds=expires)
        )

    def get_presigned_simple_upload_url(self, key: str, expires: int = 3600) -> str:
        return self.public_client.presigned_put_object(
            self.bucket, key, expires=timedelta(seconds=expires)
        )

    def download_to_file(self, key: str, local_path: str) -> None:
        """MinIO 오브젝트를 로컬 파일로 다운로드."""
        self.client.fget_object(self.bucket, key, local_path)

    def upload_from_file(self, key: str, local_path: str, content_type: str = "application/octet-stream") -> None:
        """로컬 파일을 MinIO에 업로드."""
        self.client.fput_object(self.bucket, key, local_path, content_type=content_type)

    def object_exists(self, key: str) -> bool:
        try:
            self.client.stat_object(self.bucket, key)
            return True
        except Exception:
            return False

    def delete_object(self, key: str) -> bool:
        """MinIO 오브젝트를 best-effort 로 삭제. 삭제됐으면 True."""
        try:
            self.client.remove_object(self.bucket, key)
            return True
        except Exception:
            return False

    def delete_prefix(self, prefix: str) -> int:
        """prefix 하위 오브젝트를 best-effort 로 삭제하고 삭제 시도 성공 수를 반환."""
        normalized = prefix.strip("/")
        if not normalized:
            return 0
        if not normalized.endswith("/"):
            normalized = f"{normalized}/"

        deleted = 0
        try:
            objects = list(self.client.list_objects(self.bucket, prefix=normalized, recursive=True))
        except Exception:
            return 0

        for obj in objects:
            name = getattr(obj, "object_name", None)
            if not name:
                continue
            if self.delete_object(name):
                deleted += 1
        return deleted

    def stat_object(self, key: str):
        return self.client.stat_object(self.bucket, key)

    def get_object_size(self, key: str) -> int:
        return int(self.stat_object(key).size)

    def get_object_bytes(self, key: str) -> bytes:
        """오브젝트의 바이트를 직접 읽어옴 (작은 메타데이터 파일용)."""
        resp = self.client.get_object(self.bucket, key)
        try:
            return resp.read()
        finally:
            resp.close()
            resp.release_conn()

    def put_object_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        """바이트를 MinIO에 직접 업로드 (작은 ~중간 크기 파일용)."""
        from io import BytesIO
        self.client.put_object(
            self.bucket, key, BytesIO(data), length=len(data), content_type=content_type,
        )

    def copy_object(self, dest_key: str, src_key: str) -> None:
        """버킷 내 서버사이드 복사 — 데이터가 클라이언트/프록시(Cloudflare)를 거치지 않는다.

        대용량(>100MB) PLY 를 staging 키로 청크 업로드한 뒤 최종 키로 옮길 때 사용.
        단일 copy_object 는 5GB 까지 지원하므로 refined PLY(수백 MB)엔 충분하다.
        """
        from minio.commonconfig import CopySource
        self.client.copy_object(self.bucket, dest_key, CopySource(self.bucket, src_key))


_minio_service: MinioService | None = None


def get_minio_service() -> MinioService:
    global _minio_service
    if _minio_service is None:
        _minio_service = MinioService()
        _minio_service.ensure_bucket()
    return _minio_service
