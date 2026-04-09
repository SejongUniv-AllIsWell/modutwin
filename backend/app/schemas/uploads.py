import os
import re
from pydantic import BaseModel, field_validator, model_validator
from uuid import UUID
from datetime import datetime
from typing import Optional, Literal

# 허용 확장자 화이트리스트
ALLOWED_EXTENSIONS = {
    ".mp4", ".mov", ".avi", ".mkv", ".webm",  # video
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp",  # image
    ".ply", ".splat", ".sog",  # 3D scene
}
# 허용 content-type 화이트리스트
ALLOWED_CONTENT_TYPES = {
    "video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska",
    "video/webm", "image/jpeg", "image/png", "image/gif", "image/bmp",
    "image/webp", "application/octet-stream", "model/x-ply",
}
# application/octet-stream 허용 확장자 (표준 MIME 타입이 없는 3D 포맷만 허용)
OCTET_STREAM_ALLOWED_EXTENSIONS = {".ply", ".splat", ".sog"}
# 최대 파일 크기 20GB
MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024
# 경로 조작 및 URL 특수문자 패턴 (/, \, .., %, ?, #, &, 제어문자, null byte)
# 공백은 UUID minio 키 도입으로 경로 오염 위험이 없어졌으므로 허용
UNSAFE_PATH_PATTERN = re.compile(r'[/\\%?#&\t\r\n\x00]|\.\.')
# 파일명 최대 길이
MAX_FILENAME_LENGTH = 255

PLY_EXTENSIONS = {".ply"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}


def _sanitize_path_component(value: str, field_name: str) -> str:
    """경로 구성요소에서 path traversal 문자를 거부한다."""
    if UNSAFE_PATH_PATTERN.search(value):
        raise ValueError(f"{field_name}에 허용되지 않는 문자가 포함되어 있습니다.")
    return value


def get_upload_subfolder(filename: str, ply_target: str = "gsplat") -> str:
    """파일 확장자에 따라 업로드 대상 서브폴더를 반환한다."""
    ext = os.path.splitext(filename)[1].lower()
    if ext in PLY_EXTENSIONS:
        return ply_target  # "gsplat" or "alignment"
    return "web_input"


class UploadInitRequest(BaseModel):
    filename: str
    file_size: int
    content_type: str
    building_id: UUID
    floor_id: UUID
    module_id: UUID
    ply_target: Optional[Literal["gsplat", "alignment"]] = "gsplat"

    @field_validator("filename")
    @classmethod
    def validate_filename(cls, v: str) -> str:
        if len(v) > MAX_FILENAME_LENGTH:
            raise ValueError(f"파일명은 {MAX_FILENAME_LENGTH}자를 초과할 수 없습니다.")
        _sanitize_path_component(v, "filename")
        ext = os.path.splitext(v)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise ValueError(f"허용되지 않는 파일 형식입니다. 허용: {', '.join(sorted(ALLOWED_EXTENSIONS))}")
        return v

    @field_validator("content_type")
    @classmethod
    def validate_content_type(cls, v: str) -> str:
        base_type = v.split(";")[0].strip().lower()
        if base_type not in ALLOWED_CONTENT_TYPES:
            raise ValueError(f"허용되지 않는 content-type입니다: {v}")
        return base_type

    @field_validator("file_size")
    @classmethod
    def validate_file_size(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("파일 크기는 0보다 커야 합니다.")
        if v > MAX_FILE_SIZE:
            raise ValueError(f"파일 크기는 {MAX_FILE_SIZE // (1024**3)}GB를 초과할 수 없습니다.")
        return v

    @model_validator(mode="after")
    def validate_octet_stream_extension(self) -> "UploadInitRequest":
        """application/octet-stream은 표준 MIME이 없는 3D 파일 형식으로만 제한한다."""
        if self.content_type == "application/octet-stream":
            ext = os.path.splitext(self.filename)[1].lower()
            if ext not in OCTET_STREAM_ALLOWED_EXTENSIONS:
                raise ValueError(
                    f"application/octet-stream은 "
                    f"{', '.join(sorted(OCTET_STREAM_ALLOWED_EXTENSIONS))} 파일에만 허용됩니다. "
                    "적절한 content-type을 지정하세요."
                )
        return self


class UploadInitResponse(BaseModel):
    upload_id: UUID
    minio_upload_id: str
    presigned_urls: list[str]
    part_size: int
    part_count: int


class UploadPartInfo(BaseModel):
    part_number: int
    etag: str


class UploadCompleteRequest(BaseModel):
    upload_id: UUID
    minio_upload_id: str
    parts: list[UploadPartInfo]


class UploadCompleteResponse(BaseModel):
    upload_id: UUID
    status: str
    message: str


class UploadResponse(BaseModel):
    id: UUID
    module_id: UUID
    original_filename: str
    file_size: int
    status: str
    ply_target: Optional[str] = None
    uploaded_at: datetime

    class Config:
        from_attributes = True


class SceneResponse(BaseModel):
    id: UUID
    module_id: UUID
    is_aligned: bool
    created_at: datetime
    sog_url: Optional[str] = None

    class Config:
        from_attributes = True


class SceneDownloadResponse(BaseModel):
    url: str
    expires_in: int
