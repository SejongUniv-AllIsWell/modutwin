"""scope module uniqueness by user_id

Revision ID: 0005_module_user_scope
Revises: 0004_add_sam3_columns
Create Date: 2026-05-01 00:00:00.000000

modules 테이블에 user_id (FK→users.id, NOT NULL) 추가.
UniqueConstraint 를 (floor_id, name) 에서 (floor_id, user_id, name) 으로 교체.

전제: dev DB 는 초기화하고 다시 시작. 기존 row 백필은 하지 않음 — NOT NULL 컬럼을
바로 만든다. 이미 row 가 있는 환경에서 적용하려면 본 마이그레이션을 돌리기 전에
modules + 의존 테이블을 비우거나 user_id 백필 단계를 추가해야 한다.
"""
from alembic import op
import sqlalchemy as sa


revision = '0005_module_user_scope'
down_revision = '0004_add_sam3_columns'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'modules',
        sa.Column('user_id', sa.UUID(as_uuid=True), nullable=False),
    )
    op.create_foreign_key(
        'fk_modules_user_id_users',
        'modules', 'users',
        ['user_id'], ['id'],
    )
    op.drop_constraint('uq_module_floor_name', 'modules', type_='unique')
    op.create_unique_constraint(
        'uq_module_floor_user_name', 'modules',
        ['floor_id', 'user_id', 'name'],
    )


def downgrade() -> None:
    op.drop_constraint('uq_module_floor_user_name', 'modules', type_='unique')
    op.create_unique_constraint(
        'uq_module_floor_name', 'modules',
        ['floor_id', 'name'],
    )
    op.drop_constraint('fk_modules_user_id_users', 'modules', type_='foreignkey')
    op.drop_column('modules', 'user_id')
