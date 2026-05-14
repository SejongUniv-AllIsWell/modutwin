"""add gsplat_ply_path to uploads

Revision ID: 0008_add_gsplat_ply_path
Revises: 0007_add_colmap_to_enums
Create Date: 2026-05-13 00:00:00.000000

COLMAP→3DGS 파이프라인 워커가 생성한 결과 PLY 의 MinIO 키를 보관하는 컬럼.
업로드 한 건당 1개의 결과 PLY 가 매핑되므로 단순 nullable Text 로 추가.
"""
from alembic import op
import sqlalchemy as sa


revision = '0008_add_gsplat_ply_path'
down_revision = '0007_add_colmap_to_enums'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('uploads', sa.Column('gsplat_ply_path', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('uploads', 'gsplat_ply_path')
