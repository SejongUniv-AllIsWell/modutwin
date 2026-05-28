"""merge gsplat_ply_path and basemap_source_upload branches

Revision ID: acbc8a044ca5
Revises: 0008_add_gsplat_ply_path, 0009_basemap_source_upload
Create Date: 2026-05-14 10:28:43.800877

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'acbc8a044ca5'
down_revision: Union[str, None] = ('0008_add_gsplat_ply_path', '0009_basemap_source_upload')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
