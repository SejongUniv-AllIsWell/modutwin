"""drop legacy upload-scoped alignment transform

Revision ID: 0016_drop_upload_alignment
Revises: 0015_nullable_scene_sog
Create Date: 2026-05-27 02:10:00.000000

modules.alignment_transform is the canonical alignment state. The upload-scoped
alignment_transform column and POST /uploads/{id}/alignment legacy path were
removed after commit-final became the module registration persistence path.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0016_drop_upload_alignment"
down_revision = "0015_nullable_scene_sog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("uploads", "alignment_transform")


def downgrade() -> None:
    op.add_column(
        "uploads",
        sa.Column("alignment_transform", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
