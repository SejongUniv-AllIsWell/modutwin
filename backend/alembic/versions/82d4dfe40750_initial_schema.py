"""initial schema (old flat structure)

Revision ID: 82d4dfe40750
Revises:
Create Date: 2025-01-01 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '82d4dfe40750'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    # Enums — IF NOT EXISTS 방식으로 생성
    for name, values in [
        ('userrole', ['user', 'admin']),
        ('uploadstatus', ['uploaded', 'processing', 'completed', 'failed']),
        ('tasktype', ['3dgs_training', 'door_alignment', 'basemap_realign']),
        ('taskstatus', ['pending', 'running', 'completed', 'failed']),
        ('basemapstatus', ['pending', 'approved', 'rejected', 'superseded']),
        ('notificationtype', ['task_complete', 'task_failed', 'basemap_pending', 'system']),
    ]:
        postgresql.ENUM(*values, name=name).create(bind, checkfirst=True)

    op.create_table(
        'users',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('google_id', sa.String(255), unique=True, nullable=False),
        sa.Column('email', sa.String(255), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('avatar_url', sa.String(500), nullable=True),
        sa.Column('role', postgresql.ENUM('user', 'admin', name='userrole', create_type=False), nullable=False, server_default='user'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        'access_logs',
        sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('ip_address', sa.String(45), nullable=False),
        sa.Column('endpoint', sa.String(500), nullable=False),
        sa.Column('method', sa.String(10), nullable=False),
        sa.Column('user_agent', sa.String(500), nullable=True),
        sa.Column('status_code', sa.Integer, nullable=False),
        sa.Column('timestamp', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        'sessions',
        sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('refresh_token_hash', sa.String(255), nullable=False),
        sa.Column('issued_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('is_revoked', sa.Boolean, nullable=False, server_default='false'),
    )

    op.create_table(
        'uploads',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('building_name', sa.String(255), nullable=False),
        sa.Column('floor_number', sa.Integer, nullable=False),
        sa.Column('room_number', sa.String(50), nullable=False),
        sa.Column('original_filename', sa.String(500), nullable=False),
        sa.Column('file_size', sa.BigInteger, nullable=False),
        sa.Column('content_type', sa.String(100), nullable=False),
        sa.Column('minio_path', sa.String(1000), nullable=False),
        sa.Column('status', postgresql.ENUM('uploaded', 'processing', 'completed', 'failed', name='uploadstatus', create_type=False), nullable=False, server_default='uploaded'),
        sa.Column('uploaded_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        'tasks',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('upload_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('uploads.id'), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('task_type', postgresql.ENUM('3dgs_training', 'door_alignment', 'basemap_realign', name='tasktype', create_type=False), nullable=False),
        sa.Column('celery_task_id', sa.String(255), nullable=True),
        sa.Column('status', postgresql.ENUM('pending', 'running', 'completed', 'failed', name='taskstatus', create_type=False), nullable=False, server_default='pending'),
        sa.Column('progress', sa.Integer, nullable=False, server_default='0'),
        sa.Column('error_message', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        'scene_outputs',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('task_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('tasks.id'), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('building_name', sa.String(255), nullable=False),
        sa.Column('floor_number', sa.Integer, nullable=False),
        sa.Column('room_number', sa.String(50), nullable=False),
        sa.Column('ply_path', sa.String(1000), nullable=False),
        sa.Column('sog_path', sa.String(1000), nullable=False),
        sa.Column('metadata_path', sa.String(1000), nullable=True),
        sa.Column('is_aligned', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        'basemaps',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('building_name', sa.String(255), nullable=False),
        sa.Column('floor_number', sa.Integer, nullable=False),
        sa.Column('minio_path', sa.String(1000), nullable=False),
        sa.Column('version', sa.Integer, nullable=False, server_default='1'),
        sa.Column('uploaded_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('approved_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('status', postgresql.ENUM('pending', 'approved', 'rejected', 'superseded', name='basemapstatus', create_type=False), nullable=False, server_default='pending'),
        sa.Column('is_active', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        'notifications',
        sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('message', sa.Text, nullable=False),
        sa.Column('type', postgresql.ENUM('task_complete', 'task_failed', 'basemap_pending', 'system', name='notificationtype', create_type=False), nullable=False),
        sa.Column('related_task_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('tasks.id'), nullable=True),
        sa.Column('is_read', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('notifications')
    op.drop_table('basemaps')
    op.drop_table('scene_outputs')
    op.drop_table('tasks')
    op.drop_table('uploads')
    op.drop_table('sessions')
    op.drop_table('access_logs')
    op.drop_table('users')

    for name in ['notificationtype', 'basemapstatus', 'taskstatus', 'tasktype', 'uploadstatus', 'userrole']:
        sa.Enum(name=name).drop(op.get_bind(), checkfirst=True)
