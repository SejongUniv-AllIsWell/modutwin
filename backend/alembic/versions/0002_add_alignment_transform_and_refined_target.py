"""add alignment_transform to modules and 'refined' to ply_target enum

Revision ID: 0002_add_alignment_transform
Revises: 0001_add_building_floor_module
Create Date: 2026-04-29 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = '0002_add_alignment_transform'
down_revision = '0001_add_building_floor_module'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. modules.alignment_transform JSONB 추가 (정합 결과 저장용)
    op.add_column(
        'modules',
        sa.Column('alignment_transform', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )

    # 2. plytarget enum에 'refined' 값 추가
    #    PostgreSQL enum은 ALTER TYPE ... ADD VALUE 사용 (트랜잭션 외 실행 필요)
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE plytarget ADD VALUE IF NOT EXISTS 'refined'")


def downgrade() -> None:
    # alignment_transform 컬럼 제거
    op.drop_column('modules', 'alignment_transform')

    # enum 값 제거는 PostgreSQL에서 직접 지원되지 않음.
    # 필요한 경우 enum 타입을 재생성하는 복잡한 절차 필요.
    # 여기서는 컬럼 제거만 수행하고 enum 값은 그대로 둠.
