"""add task dispatch outbox

Revision ID: 0017_task_dispatch_outbox
Revises: 0016_drop_upload_alignment
Create Date: 2026-06-11 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0017_task_dispatch_outbox"
down_revision = "0016_drop_upload_alignment"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "task_dispatch_outbox",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("task_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True),
        sa.Column("upload_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("uploads.id", ondelete="CASCADE"), nullable=True),
        sa.Column("celery_task_id", sa.String(length=255), nullable=False),
        sa.Column("task_name", sa.String(length=255), nullable=False),
        sa.Column("queue", sa.String(length=100), nullable=True),
        sa.Column("args", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("kwargs", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="20"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_unique_constraint(
        "uq_task_dispatch_outbox_celery_task_id",
        "task_dispatch_outbox",
        ["celery_task_id"],
    )
    op.create_index("ix_task_dispatch_outbox_task_id", "task_dispatch_outbox", ["task_id"])
    op.create_index("ix_task_dispatch_outbox_upload_id", "task_dispatch_outbox", ["upload_id"])
    op.create_index("ix_task_dispatch_outbox_status", "task_dispatch_outbox", ["status"])
    op.create_index(
        "ix_task_dispatch_outbox_due",
        "task_dispatch_outbox",
        ["status", "next_attempt_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_task_dispatch_outbox_due", table_name="task_dispatch_outbox")
    op.drop_index("ix_task_dispatch_outbox_status", table_name="task_dispatch_outbox")
    op.drop_index("ix_task_dispatch_outbox_upload_id", table_name="task_dispatch_outbox")
    op.drop_index("ix_task_dispatch_outbox_task_id", table_name="task_dispatch_outbox")
    op.drop_constraint("uq_task_dispatch_outbox_celery_task_id", "task_dispatch_outbox", type_="unique")
    op.drop_table("task_dispatch_outbox")
