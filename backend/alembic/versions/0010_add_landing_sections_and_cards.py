"""add landing_sections and landing_cards

Revision ID: 0010_landing_cms
Revises: acbc8a044ca5
Create Date: 2026-05-21 00:00:00.000000

랜딩 페이지의 카드 섹션 텍스트만 DB 에서 관리. 카드 자체의 위치/슬러그/CTA 동작은
프론트엔드 코드에 박혀 있으므로 행이 없으면 프론트는 빈 카드로 렌더.
"""
from alembic import op
import sqlalchemy as sa


revision = "0010_landing_cms"
down_revision = "acbc8a044ca5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "landing_sections",
        sa.Column("slug", sa.String(length=64), primary_key=True),
        sa.Column("title", sa.String(length=255), nullable=True),
        sa.Column("cta_label", sa.String(length=255), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    op.create_table(
        "landing_cards",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("section_slug", sa.String(length=64), nullable=False),
        sa.Column("card_index", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["section_slug"],
            ["landing_sections.slug"],
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "section_slug", "card_index", name="uq_landing_card_section_index"
        ),
    )


def downgrade() -> None:
    op.drop_table("landing_cards")
    op.drop_table("landing_sections")
