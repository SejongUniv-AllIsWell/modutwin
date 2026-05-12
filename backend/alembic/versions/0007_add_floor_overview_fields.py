"""add floor overview metadata fields

Revision ID: 0007_add_floor_overview_fields
Revises: 0006_add_sam3_tasktype
Create Date: 2026-05-07 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "0007_add_floor_overview_fields"
down_revision = "0006_add_sam3_tasktype"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("floors", sa.Column("overview_image_path", sa.String(length=1000), nullable=True))
    op.add_column("floors", sa.Column("overview_meta_path", sa.String(length=1000), nullable=True))
    op.add_column("floors", sa.Column("overview_version", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "floors",
        sa.Column("overview_dirty", sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    op.drop_column("floors", "overview_dirty")
    op.drop_column("floors", "overview_version")
    op.drop_column("floors", "overview_meta_path")
    op.drop_column("floors", "overview_image_path")
