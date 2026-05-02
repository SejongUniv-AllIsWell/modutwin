"""add is_visible flag to buildings, floors, modules

Revision ID: 0003_add_is_visible
Revises: 0002_add_alignment_transform
Create Date: 2026-04-30 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = '0003_add_is_visible'
down_revision = '0002_add_alignment_transform'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'buildings',
        sa.Column('is_visible', sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        'floors',
        sa.Column('is_visible', sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        'modules',
        sa.Column('is_visible', sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    op.drop_column('modules', 'is_visible')
    op.drop_column('floors', 'is_visible')
    op.drop_column('buildings', 'is_visible')
