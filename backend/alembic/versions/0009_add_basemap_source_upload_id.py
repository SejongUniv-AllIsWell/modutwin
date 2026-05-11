"""add basemap source_upload_id

Revision ID: 0009_add_basemap_source_upload_id
Revises: 0008_add_building_location_and_confirmation
Create Date: 2026-05-09 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0009_basemap_source_upload"
down_revision = "0008_building_confirm"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "basemaps",
        sa.Column("source_upload_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_basemaps_source_upload_id_uploads",
        "basemaps",
        "uploads",
        ["source_upload_id"],
        ["id"],
    )
    op.create_index("ix_basemaps_source_upload_id", "basemaps", ["source_upload_id"], unique=False)

    # Backfill from legacy inference path:
    # basemaps.minio_path == scene_outputs.ply_path -> tasks.upload_id
    op.execute(
        """
        UPDATE basemaps AS b
        SET source_upload_id = src.upload_id
        FROM (
            SELECT DISTINCT ON (so.ply_path)
                so.ply_path,
                t.upload_id
            FROM scene_outputs AS so
            JOIN tasks AS t ON t.id = so.task_id
            ORDER BY so.ply_path, so.created_at DESC
        ) AS src
        WHERE b.source_upload_id IS NULL
          AND b.minio_path = src.ply_path
        """
    )


def downgrade() -> None:
    op.drop_index("ix_basemaps_source_upload_id", table_name="basemaps")
    op.drop_constraint("fk_basemaps_source_upload_id_uploads", "basemaps", type_="foreignkey")
    op.drop_column("basemaps", "source_upload_id")
