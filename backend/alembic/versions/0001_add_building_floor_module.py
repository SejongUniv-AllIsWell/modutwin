"""add building/floor/module hierarchy and migrate schema

Revision ID: 0001_add_building_floor_module
Revises: 82d4dfe40750
Create Date: 2026-04-02 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
import uuid

revision = '0001_add_building_floor_module'
down_revision = '82d4dfe40750'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. buildings 테이블 생성
    op.create_table(
        'buildings',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, default=uuid.uuid4),
        sa.Column('name', sa.String(255), unique=True, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # 2. floors 테이블 생성
    op.create_table(
        'floors',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, default=uuid.uuid4),
        sa.Column('building_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('buildings.id'), nullable=False),
        sa.Column('floor_number', sa.Integer, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint('building_id', 'floor_number', name='uq_floor_building_number'),
    )

    # 3. modules 테이블 생성
    op.create_table(
        'modules',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, default=uuid.uuid4),
        sa.Column('floor_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('floors.id'), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint('floor_id', 'name', name='uq_module_floor_name'),
    )

    # 4. uploads 마이그레이션: module_id 컬럼 추가 + ply_target enum 추가
    ply_target_enum = postgresql.ENUM('gsplat', 'alignment', name='plytarget', create_type=True)
    ply_target_enum.create(op.get_bind())

    op.add_column('uploads', sa.Column('module_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column('uploads', sa.Column('ply_target', sa.Enum('gsplat', 'alignment', name='plytarget'), nullable=True))

    # 5. 기존 uploads 데이터를 새 계층 구조로 마이그레이션
    conn = op.get_bind()

    # 기존 업로드에서 고유한 (building_name, floor_number, room_number) 조합 가져오기
    uploads = conn.execute(sa.text(
        "SELECT DISTINCT building_name, floor_number, room_number FROM uploads"
    )).fetchall()

    # building_name별로 buildings 생성
    building_map = {}  # building_name -> building_id
    floor_map = {}     # (building_name, floor_number) -> floor_id
    module_map = {}    # (building_name, floor_number, room_number) -> module_id

    for row in uploads:
        building_name, floor_number, room_number = row[0], row[1], row[2]

        # Building 생성 (없으면)
        if building_name not in building_map:
            building_id = str(uuid.uuid4())
            conn.execute(sa.text(
                "INSERT INTO buildings (id, name) VALUES (:id, :name)"
            ), {"id": building_id, "name": building_name})
            building_map[building_name] = building_id
        else:
            building_id = building_map[building_name]

        # Floor 생성 (없으면)
        floor_key = (building_name, floor_number)
        if floor_key not in floor_map:
            floor_id = str(uuid.uuid4())
            conn.execute(sa.text(
                "INSERT INTO floors (id, building_id, floor_number) VALUES (:id, :building_id, :floor_number)"
            ), {"id": floor_id, "building_id": building_id, "floor_number": floor_number})
            floor_map[floor_key] = floor_id
        else:
            floor_id = floor_map[floor_key]

        # Module 생성 (없으면)
        module_key = (building_name, floor_number, room_number)
        if module_key not in module_map:
            module_id = str(uuid.uuid4())
            conn.execute(sa.text(
                "INSERT INTO modules (id, floor_id, name) VALUES (:id, :floor_id, :name)"
            ), {"id": module_id, "floor_id": floor_id, "name": room_number})
            module_map[module_key] = module_id

    # 각 upload의 module_id 업데이트
    for (building_name, floor_number, room_number), module_id in module_map.items():
        conn.execute(sa.text(
            "UPDATE uploads SET module_id = :module_id "
            "WHERE building_name = :building_name AND floor_number = :floor_number AND room_number = :room_number"
        ), {
            "module_id": module_id,
            "building_name": building_name,
            "floor_number": floor_number,
            "room_number": room_number,
        })

    # 6. module_id NOT NULL 설정 및 FK 추가
    op.alter_column('uploads', 'module_id', nullable=False)
    op.create_foreign_key('uploads_module_id_fkey', 'uploads', 'modules', ['module_id'], ['id'])

    # 7. uploads 구버전 컬럼 삭제
    op.drop_column('uploads', 'building_name')
    op.drop_column('uploads', 'floor_number')
    op.drop_column('uploads', 'room_number')

    # 8. basemaps 마이그레이션: floor_id 추가
    op.add_column('basemaps', sa.Column('floor_id', postgresql.UUID(as_uuid=True), nullable=True))

    # basemaps 데이터 마이그레이션 (비어있으므로 빈 처리)
    basemaps = conn.execute(sa.text(
        "SELECT DISTINCT building_name, floor_number FROM basemaps"
    )).fetchall()

    for row in basemaps:
        building_name, floor_number = row[0], row[1]
        floor_key = (building_name, floor_number)

        if floor_key in floor_map:
            floor_id = floor_map[floor_key]
        else:
            # 해당 building/floor가 없으면 새로 생성
            if building_name not in building_map:
                building_id = str(uuid.uuid4())
                conn.execute(sa.text(
                    "INSERT INTO buildings (id, name) VALUES (:id, :name)"
                ), {"id": building_id, "name": building_name})
                building_map[building_name] = building_id
            building_id = building_map[building_name]

            floor_id = str(uuid.uuid4())
            conn.execute(sa.text(
                "INSERT INTO floors (id, building_id, floor_number) VALUES (:id, :building_id, :floor_number)"
            ), {"id": floor_id, "building_id": building_id, "floor_number": floor_number})
            floor_map[floor_key] = floor_id

        conn.execute(sa.text(
            "UPDATE basemaps SET floor_id = :floor_id "
            "WHERE building_name = :building_name AND floor_number = :floor_number"
        ), {"floor_id": floor_id, "building_name": building_name, "floor_number": floor_number})

    op.alter_column('basemaps', 'floor_id', nullable=False)
    op.create_foreign_key('basemaps_floor_id_fkey', 'basemaps', 'floors', ['floor_id'], ['id'])

    op.drop_column('basemaps', 'building_name')
    op.drop_column('basemaps', 'floor_number')

    # 9. scene_outputs 마이그레이션: module_id 추가
    op.add_column('scene_outputs', sa.Column('module_id', postgresql.UUID(as_uuid=True), nullable=True))

    scene_outputs = conn.execute(sa.text(
        "SELECT DISTINCT building_name, floor_number, room_number FROM scene_outputs"
    )).fetchall()

    for row in scene_outputs:
        building_name, floor_number, room_number = row[0], row[1], row[2]
        module_key = (building_name, floor_number, room_number)

        if module_key in module_map:
            module_id = module_map[module_key]
        else:
            # 해당 module이 없으면 새로 생성
            floor_key = (building_name, floor_number)
            if floor_key not in floor_map:
                if building_name not in building_map:
                    building_id = str(uuid.uuid4())
                    conn.execute(sa.text(
                        "INSERT INTO buildings (id, name) VALUES (:id, :name)"
                    ), {"id": building_id, "name": building_name})
                    building_map[building_name] = building_id
                building_id = building_map[building_name]

                floor_id = str(uuid.uuid4())
                conn.execute(sa.text(
                    "INSERT INTO floors (id, building_id, floor_number) VALUES (:id, :building_id, :floor_number)"
                ), {"id": floor_id, "building_id": building_id, "floor_number": floor_number})
                floor_map[floor_key] = floor_id

            floor_id = floor_map[floor_key]
            module_id = str(uuid.uuid4())
            conn.execute(sa.text(
                "INSERT INTO modules (id, floor_id, name) VALUES (:id, :floor_id, :name)"
            ), {"id": module_id, "floor_id": floor_id, "name": room_number})
            module_map[module_key] = module_id

        conn.execute(sa.text(
            "UPDATE scene_outputs SET module_id = :module_id "
            "WHERE building_name = :building_name AND floor_number = :floor_number AND room_number = :room_number"
        ), {
            "module_id": module_id,
            "building_name": building_name,
            "floor_number": floor_number,
            "room_number": room_number,
        })

    op.alter_column('scene_outputs', 'module_id', nullable=False)
    op.create_foreign_key('scene_outputs_module_id_fkey', 'scene_outputs', 'modules', ['module_id'], ['id'])

    op.drop_column('scene_outputs', 'building_name')
    op.drop_column('scene_outputs', 'floor_number')
    op.drop_column('scene_outputs', 'room_number')


def downgrade() -> None:
    # scene_outputs 롤백
    op.add_column('scene_outputs', sa.Column('building_name', sa.String(255), nullable=True))
    op.add_column('scene_outputs', sa.Column('floor_number', sa.Integer, nullable=True))
    op.add_column('scene_outputs', sa.Column('room_number', sa.String(50), nullable=True))
    op.drop_constraint('scene_outputs_module_id_fkey', 'scene_outputs', type_='foreignkey')
    op.drop_column('scene_outputs', 'module_id')

    # basemaps 롤백
    op.add_column('basemaps', sa.Column('building_name', sa.String(255), nullable=True))
    op.add_column('basemaps', sa.Column('floor_number', sa.Integer, nullable=True))
    op.drop_constraint('basemaps_floor_id_fkey', 'basemaps', type_='foreignkey')
    op.drop_column('basemaps', 'floor_id')

    # uploads 롤백
    op.add_column('uploads', sa.Column('building_name', sa.String(255), nullable=True))
    op.add_column('uploads', sa.Column('floor_number', sa.Integer, nullable=True))
    op.add_column('uploads', sa.Column('room_number', sa.String(50), nullable=True))
    op.drop_constraint('uploads_module_id_fkey', 'uploads', type_='foreignkey')
    op.drop_column('uploads', 'module_id')
    op.drop_column('uploads', 'ply_target')

    sa.Enum(name='plytarget').drop(op.get_bind())

    op.drop_table('modules')
    op.drop_table('floors')
    op.drop_table('buildings')
