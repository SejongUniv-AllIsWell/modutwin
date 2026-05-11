"""add building location and confirmation fields

Revision ID: 0008_add_building_location_and_confirmation
Revises: 0007_add_floor_overview_fields
Create Date: 2026-05-09 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = "0008_building_confirm"
down_revision = "0007_add_floor_overview_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("buildings", sa.Column("kakao_place_id", sa.String(length=255), nullable=True))
    op.add_column("buildings", sa.Column("address_name", sa.String(length=500), nullable=True))
    op.add_column("buildings", sa.Column("road_address_name", sa.String(length=500), nullable=True))
    op.add_column("buildings", sa.Column("latitude", sa.Float(), nullable=True))
    op.add_column("buildings", sa.Column("longitude", sa.Float(), nullable=True))
    op.add_column(
        "buildings",
        sa.Column("is_confirmed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_buildings_kakao_place_id", "buildings", ["kakao_place_id"], unique=True)

    op.add_column(
        "floors",
        sa.Column("is_confirmed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "modules",
        sa.Column("is_confirmed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("modules", "is_confirmed")
    op.drop_column("floors", "is_confirmed")
    op.drop_index("ix_buildings_kakao_place_id", table_name="buildings")
    op.drop_column("buildings", "is_confirmed")
    op.drop_column("buildings", "longitude")
    op.drop_column("buildings", "latitude")
    op.drop_column("buildings", "road_address_name")
    op.drop_column("buildings", "address_name")
    op.drop_column("buildings", "kakao_place_id")
