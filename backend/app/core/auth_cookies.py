import secrets
from typing import Any

from fastapi import HTTPException, Request, status
from starlette.responses import Response

ACCESS_TOKEN_COOKIE_NAME = "access_token"
REFRESH_TOKEN_COOKIE_NAME = "refresh_token"
CSRF_TOKEN_COOKIE_NAME = "csrf_token"
CSRF_HEADER_NAME = "X-CSRF-Token"

UNSAFE_HTTP_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def cookie_secure(settings: Any) -> bool:
    public_base_url = (settings.PUBLIC_BASE_URL or "").strip().lower()
    return public_base_url.startswith("https://") and not settings.DEV_MODE


def new_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def _access_token_max_age(settings: Any) -> int:
    return int(settings.ACCESS_TOKEN_EXPIRE_MINUTES) * 60


def _refresh_token_max_age(settings: Any) -> int:
    return int(settings.REFRESH_TOKEN_EXPIRE_DAYS) * 24 * 60 * 60


def _cookie_kwargs(settings: Any) -> dict[str, Any]:
    return {
        "path": "/",
        "samesite": "lax",
        "secure": cookie_secure(settings),
    }


def set_auth_cookies(response: Response, access_token: str, refresh_token: str, settings: Any) -> None:
    response.set_cookie(
        key=ACCESS_TOKEN_COOKIE_NAME,
        value=access_token,
        httponly=True,
        max_age=_access_token_max_age(settings),
        **_cookie_kwargs(settings),
    )
    response.set_cookie(
        key=REFRESH_TOKEN_COOKIE_NAME,
        value=refresh_token,
        httponly=True,
        max_age=_refresh_token_max_age(settings),
        **_cookie_kwargs(settings),
    )
    response.set_cookie(
        key=CSRF_TOKEN_COOKIE_NAME,
        value=new_csrf_token(),
        httponly=False,
        max_age=_refresh_token_max_age(settings),
        **_cookie_kwargs(settings),
    )


def set_access_cookie(response: Response, access_token: str, settings: Any) -> None:
    response.set_cookie(
        key=ACCESS_TOKEN_COOKIE_NAME,
        value=access_token,
        httponly=True,
        max_age=_access_token_max_age(settings),
        **_cookie_kwargs(settings),
    )
    response.set_cookie(
        key=CSRF_TOKEN_COOKIE_NAME,
        value=new_csrf_token(),
        httponly=False,
        max_age=_refresh_token_max_age(settings),
        **_cookie_kwargs(settings),
    )


def _clear_cookie(response: Response, cookie_name: str, httponly: bool, settings: Any) -> None:
    response.set_cookie(
        key=cookie_name,
        value="",
        httponly=httponly,
        max_age=0,
        expires=0,
        **_cookie_kwargs(settings),
    )


def clear_auth_cookies(response: Response, settings: Any) -> None:
    _clear_cookie(response, ACCESS_TOKEN_COOKIE_NAME, httponly=True, settings=settings)
    _clear_cookie(response, REFRESH_TOKEN_COOKIE_NAME, httponly=True, settings=settings)
    _clear_cookie(response, CSRF_TOKEN_COOKIE_NAME, httponly=False, settings=settings)


def get_access_token_from_cookie(request: Request) -> str | None:
    return request.cookies.get(ACCESS_TOKEN_COOKIE_NAME)


def get_refresh_token_from_cookie(request: Request) -> str | None:
    return request.cookies.get(REFRESH_TOKEN_COOKIE_NAME)


def validate_csrf_for_cookie_auth(request: Request) -> None:
    if request.method.upper() not in UNSAFE_HTTP_METHODS:
        return

    csrf_cookie = request.cookies.get(CSRF_TOKEN_COOKIE_NAME)
    csrf_header = request.headers.get(CSRF_HEADER_NAME)

    if not csrf_cookie or not csrf_header:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="CSRF 토큰이 없거나 요청 헤더가 누락되었습니다.",
        )

    if not secrets.compare_digest(csrf_cookie, csrf_header):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="CSRF 토큰이 일치하지 않습니다.",
        )
