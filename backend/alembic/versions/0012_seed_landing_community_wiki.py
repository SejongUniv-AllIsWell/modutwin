"""seed landing 'community' (Most liked) + 'wiki' (Recently edited) section titles

Revision ID: 0012_seed_community_wiki
Revises: 0011_seed_participate
Create Date: 2026-05-21 00:00:00.000000

§02·§03 는 리스트 형 섹션으로, h2 제목 (Most liked / Recently edited) 만 DB 에서 받고
실제 항목들은 /landing/feed 가 modules 테이블에서 직접 추려서 내려준다. 따라서 여기서는
섹션 행의 title 만 seed 하고 landing_cards 행은 만들지 않는다. 이전 버전이 seed 한 카드
행이 남아 있으면 청소.
"""
from alembic import op
import sqlalchemy as sa


revision = "0012_seed_community_wiki"
down_revision = "0011_seed_participate"
branch_labels = None
depends_on = None


SECTIONS = [
    ("community", "Most liked"),
    ("wiki", "Recently edited"),
]


def upgrade() -> None:
    bind = op.get_bind()
    for slug, title in SECTIONS:
        bind.execute(
            sa.text(
                """
                INSERT INTO landing_sections (slug, title, cta_label)
                VALUES (:slug, :title, NULL)
                ON CONFLICT (slug) DO UPDATE
                    SET title = EXCLUDED.title,
                        cta_label = EXCLUDED.cta_label
                """
            ),
            {"slug": slug, "title": title},
        )
        # 카드 행은 /landing/feed 가 대신하므로 정리만 한다.
        bind.execute(
            sa.text("DELETE FROM landing_cards WHERE section_slug = :slug"),
            {"slug": slug},
        )


def downgrade() -> None:
    bind = op.get_bind()
    for slug, _title in SECTIONS:
        bind.execute(
            sa.text("DELETE FROM landing_cards WHERE section_slug = :slug"),
            {"slug": slug},
        )
        bind.execute(
            sa.text("DELETE FROM landing_sections WHERE slug = :slug"),
            {"slug": slug},
        )
