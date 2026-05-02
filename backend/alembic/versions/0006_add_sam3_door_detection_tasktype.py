"""add sam3_door_detection to tasktype enum

Revision ID: 0006_add_sam3_door_detection_tasktype
Revises: 0005_module_user_scope
Create Date: 2026-05-02 00:00:00.000000

Python TaskType 에는 sam3_door_detection 이 추가되어 있지만
Postgres tasktype enum 에는 누락되어 있어, /uploads/{id}/sam3/start 가
INSERT 단계에서 InvalidTextRepresentationError 로 500 을 낸다.
이 마이그레이션이 그 enum 값을 추가한다.
"""
from alembic import op


revision = '0006_add_sam3_tasktype'
down_revision = '0005_module_user_scope'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ALTER TYPE ... ADD VALUE 는 트랜잭션 블록 밖에서만 실행 가능 (PG <12 호환).
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE tasktype ADD VALUE IF NOT EXISTS 'sam3_door_detection'")


def downgrade() -> None:
    # Postgres 는 enum 값을 단일하게 삭제할 수 없다 — 타입을 재생성해야 함.
    # 운영 데이터에서 사용 중일 가능성이 높아 downgrade 는 no-op 으로 둔다.
    pass
