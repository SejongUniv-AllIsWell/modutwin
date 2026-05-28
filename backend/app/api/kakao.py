from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Literal

from app.core.rate_limit import TokenBucketLimiter, rate_limited
from app.models import User
from app.services.kakao_local_service import (
    KAKAO_CATEGORY_SEARCH_URL,
    KAKAO_COORD2ADDRESS_URL,
    KAKAO_KEYWORD_SEARCH_URL,
    call_kakao_local_api,
)

router = APIRouter(prefix="/kakao", tags=["kakao"])

# Why: explore 페이지의 지도 클릭 1회로 최대 45 페이지를 fanout 할 수 있어
#      카카오 무료 quota 를 빠르게 소진할 위험이 있다.
#      30 토큰 + 초당 2 토큰 회복 = 정상 사용은 통과, 폭주는 차단.
_kakao_limiter = TokenBucketLimiter(capacity=30, refill_per_second=2.0)
kakao_rate_limit = rate_limited(_kakao_limiter, scope="kakao")

KAKAO_SORT = Literal["accuracy", "distance"]


def _validate_sort_with_location(sort: KAKAO_SORT, x: float | None, y: float | None) -> None:
    if sort == "distance" and (x is None or y is None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="sort=distance 사용 시 x, y 좌표가 필요합니다.",
        )


@router.get("/search/keyword")
async def search_keyword(
    query: str = Query(..., min_length=1),
    x: float | None = Query(None),
    y: float | None = Query(None),
    radius: int | None = Query(None, ge=0, le=20000),
    page: int = Query(1, ge=1, le=45),
    size: int = Query(10, ge=1, le=15),
    sort: KAKAO_SORT = "accuracy",
    user: User = Depends(kakao_rate_limit),
):
    _ = user
    trimmed_query = query.strip()
    if not trimmed_query:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="query는 공백만으로 요청할 수 없습니다.")
    _validate_sort_with_location(sort, x, y)
    params: dict[str, str | int | float] = {
        "query": trimmed_query,
        "page": page,
        "size": size,
        "sort": sort,
    }
    if x is not None:
        params["x"] = x
    if y is not None:
        params["y"] = y
    if radius is not None:
        params["radius"] = radius

    payload = await call_kakao_local_api(url=KAKAO_KEYWORD_SEARCH_URL, params=params)
    return {
        "documents": payload.get("documents", []),
        "meta": payload.get("meta", {}),
    }


@router.get("/search/category")
async def search_category(
    category_group_code: str = Query(..., min_length=2),
    x: float | None = Query(None),
    y: float | None = Query(None),
    radius: int | None = Query(None, ge=0, le=20000),
    page: int = Query(1, ge=1, le=45),
    size: int = Query(15, ge=1, le=15),
    sort: KAKAO_SORT = "accuracy",
    user: User = Depends(kakao_rate_limit),
):
    _ = user
    _validate_sort_with_location(sort, x, y)

    code = category_group_code.strip()
    if not code:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="category_group_code가 필요합니다.")

    params: dict[str, str | int | float] = {
        "category_group_code": code,
        "page": page,
        "size": size,
        "sort": sort,
    }
    if x is not None:
        params["x"] = x
    if y is not None:
        params["y"] = y
    if radius is not None:
        params["radius"] = radius

    payload = await call_kakao_local_api(url=KAKAO_CATEGORY_SEARCH_URL, params=params)
    return {
        "documents": payload.get("documents", []),
        "meta": payload.get("meta", {}),
    }


@router.get("/geo/coord2address")
async def coord2address(
    x: float = Query(...),
    y: float = Query(...),
    user: User = Depends(kakao_rate_limit),
):
    _ = user
    params: dict[str, str | int | float] = {
        "x": x,
        "y": y,
    }
    payload = await call_kakao_local_api(url=KAKAO_COORD2ADDRESS_URL, params=params)
    return {
        "documents": payload.get("documents", []),
        "meta": payload.get("meta", {}),
    }
