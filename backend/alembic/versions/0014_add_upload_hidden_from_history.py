"""add hidden_from_history to uploads

Revision ID: 0014_upload_hidden
Revises: 0013_drop_landing_cms
Create Date: 2026-05-22 00:10:00.000000

채택(basemap 원본 등록)되어 삭제가 막힌 업로드를 사용자가 자신의 업로드 내역
화면에서만 숨길 수 있도록 플래그를 추가한다. 파일과 DB row 는 그대로 유지.
"""
from alembic import op
import sqlalchemy as sa


revision = "0014_upload_hidden"
down_revision = "0013_drop_landing_cms"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "uploads",
        sa.Column(
            "hidden_from_history",
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("uploads", "hidden_from_history")
