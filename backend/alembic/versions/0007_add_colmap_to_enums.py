"""add colmap to plytarget and tasktype enums

Revision ID: 0007_add_colmap_to_enums
Revises: 0006_add_sam3_tasktype
Create Date: 2026-05-05 00:00:00.000000

plytarget 에 'colmap' 값 추가 (사진 zip → COLMAP 전처리 플로우).
tasktype 에 'colmap_preprocessing' 값 추가.
"""
from alembic import op


revision = '0007_add_colmap_to_enums'
down_revision = '0006_add_sam3_tasktype'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE plytarget ADD VALUE IF NOT EXISTS 'colmap'")
        op.execute("ALTER TYPE tasktype ADD VALUE IF NOT EXISTS 'colmap_preprocessing'")


def downgrade() -> None:
    pass
