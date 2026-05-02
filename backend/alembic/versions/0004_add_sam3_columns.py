"""add SAM3 + alignment columns to uploads

Revision ID: 0004_add_sam3_columns
Revises: 0003_add_is_visible
Create Date: 2026-05-01 00:00:00.000000

docs/sam3_alignment_pipeline.md 의 합의 사양에 맞춰 uploads 테이블에 SAM3 자동
검출 파이프라인 + 사용자 보정 결과 + 정합 변환행렬 저장에 필요한 컬럼을 추가.

- refined_ply_path:           refined PLY MinIO key
- door_corners_json_path:     SAM3 결과(또는 사용자 보정) 저장 doors.json MinIO key
- sam3_status:                pending / running / done / failed
- sam3_prompt:                사용자 자유 텍스트 프롬프트
- alignment_transform:        upload-scoped 변환행렬 + 매칭 정보 (JSONB)
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = '0004_add_sam3_columns'
down_revision = '0003_add_is_visible'
branch_labels = None
depends_on = None


SAM3_STATUS_VALUES = ('pending', 'running', 'done', 'failed')


def upgrade() -> None:
    # 1. sam3status enum 타입 생성 (이미 있으면 스킵)
    sam3_enum = postgresql.ENUM(*SAM3_STATUS_VALUES, name='sam3status', create_type=False)
    sam3_enum.create(op.get_bind(), checkfirst=True)

    # 2. uploads 컬럼 4개 추가 (모두 nullable — 기존 row 호환)
    op.add_column('uploads', sa.Column('refined_ply_path', sa.Text(), nullable=True))
    op.add_column('uploads', sa.Column('door_corners_json_path', sa.Text(), nullable=True))
    op.add_column(
        'uploads',
        sa.Column(
            'sam3_status',
            postgresql.ENUM(*SAM3_STATUS_VALUES, name='sam3status', create_type=False),
            nullable=True,
        ),
    )
    op.add_column('uploads', sa.Column('sam3_prompt', sa.Text(), nullable=True))

    # 3. upload-scoped 정합 결과 (변환행렬 + basemap/door 매칭)
    op.add_column(
        'uploads',
        sa.Column('alignment_transform', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('uploads', 'alignment_transform')
    op.drop_column('uploads', 'sam3_prompt')
    op.drop_column('uploads', 'sam3_status')
    op.drop_column('uploads', 'door_corners_json_path')
    op.drop_column('uploads', 'refined_ply_path')

    # enum 타입 제거 (다른 테이블에서 사용 중이 아니라면)
    op.execute("DROP TYPE IF EXISTS sam3status")
