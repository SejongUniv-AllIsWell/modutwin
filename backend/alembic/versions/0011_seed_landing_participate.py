"""seed landing 'participate' section

Revision ID: 0011_seed_participate
Revises: 0010_landing_cms
Create Date: 2026-05-21 00:00:00.000000

splat.wiki Landing.html §01 'How to participate / Ways to add your record' 의 카드 내용을
ModuTwin 컨텍스트에 맞춰 한국어로 옮겨 seed. 재실행해도 같은 결과가 되도록 카드 행은
삭제 후 INSERT, 섹션 행은 UPSERT.
"""
from alembic import op
import sqlalchemy as sa


revision = "0011_seed_participate"
down_revision = "0010_landing_cms"
branch_labels = None
depends_on = None


SECTION_SLUG = "participate"
SECTION_TITLE = "기록을 추가하는 방법"
CARDS = [
    (
        0,
        "영상 업로드",
        "휴대폰이나 드론 영상 한 편을 올리면 서버가 프레임 추출 · SfM · 3DGS 학습을 "
        "자동으로 진행합니다. 학습이 끝나는 즉시 아틀라스의 일부가 됩니다.",
    ),
    (
        1,
        "포인트 클라우드 제출",
        "이미 학습한 splat 이 있다면 .ply / .sog / .splat 파일을 직접 업로드하세요. "
        "지오태그만 붙이면 즉시 둘러볼 수 있습니다.",
    ),
    (
        2,
        "이미지 + SfM 기여",
        "직접 찍은 사진과 COLMAP / OpenSfM 결과물을 가져오세요. 그 지점부터 재구성을 "
        "이어 받고, 결과 씬에 기여자를 함께 표기합니다.",
    ),
]


def upgrade() -> None:
    bind = op.get_bind()
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
        {"slug": SECTION_SLUG, "title": SECTION_TITLE},
    )
    bind.execute(
        sa.text("DELETE FROM landing_cards WHERE section_slug = :slug"),
        {"slug": SECTION_SLUG},
    )
    for idx, title, body in CARDS:
        bind.execute(
            sa.text(
                """
                INSERT INTO landing_cards (section_slug, card_index, title, body)
                VALUES (:slug, :idx, :title, :body)
                """
            ),
            {"slug": SECTION_SLUG, "idx": idx, "title": title, "body": body},
        )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text("DELETE FROM landing_cards WHERE section_slug = :slug"),
        {"slug": SECTION_SLUG},
    )
    bind.execute(
        sa.text("DELETE FROM landing_sections WHERE slug = :slug"),
        {"slug": SECTION_SLUG},
    )
