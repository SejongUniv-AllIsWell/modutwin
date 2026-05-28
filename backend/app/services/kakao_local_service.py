import httpx
from fastapi import HTTPException, status

from app.core.config import get_settings

settings = get_settings()

KAKAO_KEYWORD_SEARCH_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
KAKAO_CATEGORY_SEARCH_URL = "https://dapi.kakao.com/v2/local/search/category.json"
KAKAO_COORD2ADDRESS_URL = "https://dapi.kakao.com/v2/local/geo/coord2address.json"


def _build_kakao_headers() -> dict[str, str]:
    if not settings.KAKAO_REST_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="KAKAO_REST_API_KEY 설정이 필요합니다.",
        )
    return {"Authorization": f"KakaoAK {settings.KAKAO_REST_API_KEY}"}


def _kakao_error_detail(payload: dict) -> str:
    error_code = payload.get("code")
    error_message = payload.get("message") or payload.get("msg")
    parts = ["Kakao Local API 오류"]
    if error_code is not None:
        parts.append(f"(code={error_code})")
    if error_message:
        parts.append(f": {error_message}")
    return "".join(parts)


async def call_kakao_local_api(
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

