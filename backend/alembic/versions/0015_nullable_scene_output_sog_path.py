"""make scene_outputs.sog_path nullable

Revision ID: 0015_nullable_scene_sog
Revises: 0014_upload_hidden
Create Date: 2026-05-27 01:20:00.000000

scene_outputs.ply_path is the canonical viewer asset path. sog_path is optional
and is populated only when an actual SOG object exists.
"""
from alembic import op
import sqlalchemy as sa


revision = "0015_nullable_scene_sog"
down_revision = "0014_upload_hidden"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "scene_outputs",
        "sog_path",
        existing_type=sa.String(length=1000),
        nullable=True,
    )


def downgrade() -> None:
    op.execute("UPDATE scene_outputs SET sog_path = ply_path WHERE sog_path IS NULL")
    op.alter_column(
        "scene_outputs",
        "sog_path",
        existing_type=sa.String(length=1000),
        nullable=False,
    )
