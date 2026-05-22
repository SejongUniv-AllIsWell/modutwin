"""drop landing_cms tables

Revision ID: 0013_drop_landing_cms
Revises: 0012_seed_community_wiki
Create Date: 2026-05-22 00:00:00.000000

랜딩 페이지의 섹션/카드 텍스트는 마케팅 카피로, DB 가 아닌 page.tsx 에 하드코딩하는 쪽이
유지보수에 더 적합. /landing/feed 와 /landing/stats 만 남기고 landing_sections /
landing_cards 테이블과 /landing/sections 엔드포인트는 제거한다.
"""
from alembic import op
import sqlalchemy as sa


revision = "0013_drop_landing_cms"
down_revision = "0012_seed_community_wiki"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("landing_cards")
    op.drop_table("landing_sections")


def downgrade() -> None:
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
