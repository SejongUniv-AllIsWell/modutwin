import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Literal

from app.core.config import get_settings
from app.core.security import get_current_user
from app.models import User

router = APIRouter(prefix="/kakao", tags=["kakao"])
settings = get_settings()

KAKAO_KEYWORD_SEARCH_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
KAKAO_CATEGORY_SEARCH_URL = "https://dapi.kakao.com/v2/local/search/category.json"
KAKAO_COORD2ADDRESS_URL = "https://dapi.kakao.com/v2/local/geo/coord2address.json"

KAKAO_SORT = Literal["accuracy", "distance"]


def _build_kakao_headers() -> dict[str, str]:
    if not settings.KAKAO_REST_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="KAKAO_REST_API_KEY 설정이 필요합니다.",
        )
    return {"Authorization": f"KakaoAK {settings.KAKAO_REST_API_KEY}"}


def _validate_sort_with_location(sort: KAKAO_SORT, x: float | None, y: float | None) -> None:
    if sort == "distance" and (x is None or y is None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="sort=distance 사용 시 x, y 좌표가 필요합니다.",
        )


def _kakao_error_detail(payload: dict) -> str:
    error_code = payload.get("code")
    error_message = payload.get("message") or payload.get("msg")
    parts = ["Kakao Local API 오류"]
    if error_code is not None:
        parts.append(f"(code={error_code})")
    if error_message:
        parts.append(f": {error_message}")
    return "".join(parts)


async def _call_kakao_local_api(
    *,
    url: str,
    params: dict[str, str | int | float],
) -> dict:
    headers = _build_kakao_headers()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(url, headers=headers, params=params)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Kakao Local API 호출 실패: {exc.__class__.__name__}",
        )

    if not response.is_success:
        try:
            error_payload = response.json()
        except ValueError:
            error_payload = {}

        error_message = _kakao_error_detail(error_payload)
        lowered = str(error_payload.get("message") or error_payload.get("msg") or "").lower()
        if error_payload.get("code") == -10 or "limit" in lowered or response.status_code == 429:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=error_message)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=error_message)

    try:
        return response.json()
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Kakao Local API 응답이 JSON 형식이 아닙니다.",
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
    user: User = Depends(get_current_user),
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

    payload = await _call_kakao_local_api(url=KAKAO_KEYWORD_SEARCH_URL, params=params)
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
    user: User = Depends(get_current_user),
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

    payload = await _call_kakao_local_api(url=KAKAO_CATEGORY_SEARCH_URL, params=params)
    return {
        "documents": payload.get("documents", []),
        "meta": payload.get("meta", {}),
    }


@router.get("/geo/coord2address")
async def coord2address(
    x: float = Query(...),
    y: float = Query(...),
    user: User = Depends(get_current_user),
):
    _ = user
    params: dict[str, str | int | float] = {
        "x": x,
        "y": y,
    }
    payload = await _call_kakao_local_api(url=KAKAO_COORD2ADDRESS_URL, params=params)
    return {
        "documents": payload.get("documents", []),
        "meta": payload.get("meta", {}),
    }
