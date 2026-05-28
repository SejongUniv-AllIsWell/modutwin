import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import distinct, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import Building, Floor, Module, SceneOutput

router = APIRouter(prefix="/landing", tags=["landing"])


class LandingStatsResponse(BaseModel):
    buildings: int
    modules: int
    contributors: int


@router.get("/stats", response_model=LandingStatsResponse)
async def landing_stats(db: AsyncSession = Depends(get_db)):
    """랜딩 페이지 hero meta 의 3개 숫자.

    공개된(visible) 건물 / 등록된 모듈 / 모듈을 올린 distinct 사용자 수.
    """
    # 정합 미완료(placeholder) 모듈은 통계에서 제외하기 위해, feed 와 동일하게
    # SceneOutput 이 존재하는(실제 렌더 가능한) 모듈만 집계한다. ensure-registration-context
    # 가 만든 is_visible=True placeholder Module 은 SceneOutput 이 없으므로 빠진다.
    has_scene_output = exists().where(SceneOutput.module_id == Module.id)
    buildings = await db.scalar(
        select(func.count()).select_from(Building).where(Building.is_visible.is_(True))
    )
    modules = await db.scalar(
        select(func.count())
        .select_from(Module)
        .where(Module.is_visible.is_(True))
        .where(Module.name != "__basemap__")
        .where(has_scene_output)
    )
    contributors = await db.scalar(
        select(func.count(distinct(Module.user_id)))
        .where(Module.is_visible.is_(True))
        .where(Module.name != "__basemap__")
        .where(has_scene_output)
    )
    return LandingStatsResponse(
        buildings=int(buildings or 0),
        modules=int(modules or 0),
        contributors=int(contributors or 0),
    )


class LandingEntryResponse(BaseModel):
    building_id: uuid.UUID
    building_name: str
    floor_id: uuid.UUID
    floor_number: int
    module_id: uuid.UUID
    module_name: str
    uploaded_at: datetime
    # 좋아요/star 기능은 아직 없음. 클라이언트에서 0 을 그대로 표시.
    star_count: int = 0


class LandingFeedResponse(BaseModel):
    recent: list[LandingEntryResponse]
    popular: list[LandingEntryResponse]


FEED_LIMIT = 5


def _module_to_entry(module: Module, floor: Floor, building: Building) -> LandingEntryResponse:
    return LandingEntryResponse(
        building_id=building.id,
        building_name=building.name,
        floor_id=floor.id,
        floor_number=floor.floor_number,
        module_id=module.id,
        module_name=module.name,
        uploaded_at=module.created_at,
        star_count=0,
    )


@router.get("/feed", response_model=LandingFeedResponse)
async def landing_feed(db: AsyncSession = Depends(get_db)):
    """랜딩 페이지의 #02 Most liked / #03 Recently edited 에 들어가는 동적 항목.

    visible 모듈 중 SceneOutput 이 존재하는 (실제 렌더 가능한) 모듈만 대상으로,
    created_at 기준 최신 5개를 반환. popular 는 좋아요 기능이 아직 없으므로 같은
    목록을 그대로 반환하고 star_count 는 0 으로 고정. 좋아요 도입 시 정렬 기준만
    바꿔주면 된다.
    """
    stmt = (
        select(Module, Floor, Building)
        .join(Floor, Module.floor_id == Floor.id)
        .join(Building, Floor.building_id == Building.id)
        .where(Module.is_visible.is_(True))
        .where(Module.name != "__basemap__")
        .where(
            exists().where(SceneOutput.module_id == Module.id)
        )
        .order_by(Module.created_at.desc())
        .limit(FEED_LIMIT)
    )
    rows = (await db.execute(stmt)).all()
    entries = [_module_to_entry(m, f, b) for (m, f, b) in rows]
    return LandingFeedResponse(
        recent=entries,
        popular=entries,
    )
