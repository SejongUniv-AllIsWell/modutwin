import uuid
from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import (
    String, Integer, Boolean, DateTime, Text, BigInteger,
    ForeignKey, Enum, func, UniqueConstraint,
    false as sa_false,
    true as sa_true,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


# ── Enums ──

class UserRole(str, PyEnum):
    user = "user"
    admin = "admin"


class UploadStatus(str, PyEnum):
    uploaded = "uploaded"
    processing = "processing"
    completed = "completed"
    failed = "failed"


class PlyTarget(str, PyEnum):
    gsplat = "gsplat"
    alignment = "alignment"
    refined = "refined"
    colmap = "colmap"


class TaskType(str, PyEnum):
    training_3dgs = "3dgs_training"
    door_alignment = "door_alignment"
    basemap_realign = "basemap_realign"
    sam3_door_detection = "sam3_door_detection"
    colmap_preprocessing = "colmap_preprocessing"


class Sam3Status(str, PyEnum):
    pending = "pending"
    running = "running"
    done = "done"
    failed = "failed"


class TaskStatus(str, PyEnum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"


class BasemapStatus(str, PyEnum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    superseded = "superseded"


class NotificationType(str, PyEnum):
    task_complete = "task_complete"
    task_failed = "task_failed"
    basemap_pending = "basemap_pending"
    system = "system"


# ── Models ──

class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    google_id: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), default=UserRole.user, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    sessions: Mapped[list["Session"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    uploads: Mapped[list["Upload"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    modules: Mapped[list["Module"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    tasks: Mapped[list["Task"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    notifications: Mapped[list["Notification"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class AccessLog(Base):
    __tablename__ = "access_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False)
    endpoint: Mapped[str] = mapped_column(String(500), nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    refresh_token_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    is_revoked: Mapped[bool] = mapped_column(Boolean, default=False)

    user: Mapped["User"] = relationship(back_populates="sessions")


# ── Building / Floor / Module hierarchy ──

class Building(Base):
    __tablename__ = "buildings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    kakao_place_id: Mapped[str | None] = mapped_column(String(255), unique=True, index=True, nullable=True)
    address_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    road_address_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    latitude: Mapped[float | None] = mapped_column(nullable=True)
    longitude: Mapped[float | None] = mapped_column(nullable=True)
    is_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_false(), default=False)
    is_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_true(), default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    floors: Mapped[list["Floor"]] = relationship(back_populates="building", cascade="all, delete-orphan")


class Floor(Base):
    __tablename__ = "floors"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    building_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("buildings.id"), nullable=False)
    floor_number: Mapped[int] = mapped_column(Integer, nullable=False)
    is_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_false(), default=False)
    is_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_true(), default=True)
    overview_image_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    overview_meta_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    overview_version: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    overview_dirty: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_true(), default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("building_id", "floor_number", name="uq_floor_building_number"),)

    building: Mapped["Building"] = relationship(back_populates="floors")
    modules: Mapped[list["Module"]] = relationship(back_populates="floor", cascade="all, delete-orphan")
    basemaps: Mapped[list["Basemap"]] = relationship(back_populates="floor", cascade="all, delete-orphan")


class Module(Base):
    __tablename__ = "modules"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    floor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("floors.id"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    alignment_transform: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    is_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_false(), default=False)
    is_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_true(), default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("floor_id", "user_id", "name", name="uq_module_floor_user_name"),)

    floor: Mapped["Floor"] = relationship(back_populates="modules")
    user: Mapped["User"] = relationship(back_populates="modules")
    uploads: Mapped[list["Upload"]] = relationship(back_populates="module", cascade="all, delete-orphan")
    scene_outputs: Mapped[list["SceneOutput"]] = relationship(back_populates="module", cascade="all, delete-orphan")


# ── Upload / Task / SceneOutput ──

class Upload(Base):
    __tablename__ = "uploads"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    module_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("modules.id"), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    file_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    minio_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    ply_target: Mapped[PlyTarget | None] = mapped_column(Enum(PlyTarget), nullable=True)
    status: Mapped[UploadStatus] = mapped_column(Enum(UploadStatus), default=UploadStatus.uploaded, nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # COLMAP → 3DGS 파이프라인 결과물 (워커가 생성한 PLY 의 MinIO key)
    gsplat_ply_path: Mapped[str | None] = mapped_column(Text, nullable=True)

    # SAM3 / 정합 파이프라인 (docs/sam3_alignment_pipeline.md)
    refined_ply_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    door_corners_json_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    sam3_status: Mapped["Sam3Status | None"] = mapped_column(
        Enum(Sam3Status, name="sam3status"), nullable=True,
    )
    sam3_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    alignment_transform: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # basemap 으로 채택되어 삭제가 막힌 업로드를 사용자 대시보드 목록에서만 숨길 때 사용.
    # 파일과 DB row 자체는 유지하고, /uploads 목록에서만 제외한다.
    hidden_from_history: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=sa_false(), default=False,
    )

    user: Mapped["User"] = relationship(back_populates="uploads")
    module: Mapped["Module"] = relationship(back_populates="uploads")
    tasks: Mapped[list["Task"]] = relationship(back_populates="upload", cascade="all, delete-orphan")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    upload_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("uploads.id"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    task_type: Mapped[TaskType] = mapped_column(Enum(TaskType, values_callable=lambda x: [e.value for e in x]), nullable=False)
    celery_task_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[TaskStatus] = mapped_column(Enum(TaskStatus), default=TaskStatus.pending, nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    upload: Mapped["Upload"] = relationship(back_populates="tasks")
    user: Mapped["User"] = relationship(back_populates="tasks")
    scene_outputs: Mapped[list["SceneOutput"]] = relationship(back_populates="task", cascade="all, delete-orphan")


class SceneOutput(Base):
    __tablename__ = "scene_outputs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tasks.id"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    module_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("modules.id"), nullable=False)
    ply_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    sog_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    metadata_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    is_aligned: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    task: Mapped["Task"] = relationship(back_populates="scene_outputs")
    module: Mapped["Module"] = relationship(back_populates="scene_outputs")


class Basemap(Base):
    __tablename__ = "basemaps"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    floor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("floors.id"), nullable=False)
    source_upload_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("uploads.id"), nullable=True)
    minio_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    uploaded_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    status: Mapped[BasemapStatus] = mapped_column(Enum(BasemapStatus), default=BasemapStatus.pending, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    floor: Mapped["Floor"] = relationship(back_populates="basemaps")


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[NotificationType] = mapped_column(Enum(NotificationType), nullable=False)
    related_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("tasks.id"), nullable=True)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="notifications")


