from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Request
from starlette.responses import Response

from app.core.auth_cookies import (
    ACCESS_TOKEN_COOKIE_NAME,
    CSRF_HEADER_NAME,
    CSRF_TOKEN_COOKIE_NAME,
    REFRESH_TOKEN_COOKIE_NAME,
    clear_auth_cookies,
    cookie_secure,
    get_access_token_from_cookie,
    get_refresh_token_from_cookie,
    set_access_cookie,
    set_auth_cookies,
    validate_csrf_for_cookie_auth,
)


def _settings(
    public_base_url: str,
    dev_mode: bool = False,
    access_token_expire_minutes: int = 30,
    refresh_token_expire_days: int = 7,
) -> SimpleNamespace:
    return SimpleNamespace(
        PUBLIC_BASE_URL=public_base_url,
        DEV_MODE=dev_mode,
        ACCESS_TOKEN_EXPIRE_MINUTES=access_token_expire_minutes,
        REFRESH_TOKEN_EXPIRE_DAYS=refresh_token_expire_days,
    )


async def _empty_receive() -> dict:
    return {"type": "http.request", "body": b"", "more_body": False}


def _request(
    method: str,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
) -> Request:
    raw_headers: list[tuple[bytes, bytes]] = []
    if headers:
        raw_headers.extend((k.lower().encode(), v.encode()) for k, v in headers.items())
    if cookies:
        cookie_header = "; ".join(f"{k}={v}" for k, v in cookies.items())
        raw_headers.append((b"cookie", cookie_header.encode()))
    scope = {
        "type": "http",
        "method": method.upper(),
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "headers": raw_headers,
    }
    return Request(scope, _empty_receive)


@pytest.mark.parametrize(
    ("public_base_url", "dev_mode", "expected"),
    [
        ("https://app.example.com", False, True),
        ("http://app.example.com", False, False),
        ("https://app.example.com", True, False),
        ("", False, False),
    ],
)
def test_cookie_secure_policy(public_base_url: str, dev_mode: bool, expected: bool) -> None:
    assert cookie_secure(_settings(public_base_url=public_base_url, dev_mode=dev_mode)) is expected


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_validate_csrf_for_cookie_auth_allows_safe_methods(method: str) -> None:
    validate_csrf_for_cookie_auth(_request(method=method))


def test_validate_csrf_for_cookie_auth_rejects_missing_token_for_unsafe_method() -> None:
    with pytest.raises(HTTPException) as exc_info:
        validate_csrf_for_cookie_auth(_request(method="POST"))

    assert exc_info.value.status_code == 403
    assert "CSRF" in exc_info.value.detail


def test_validate_csrf_for_cookie_auth_rejects_mismatch() -> None:
    request = _request(
        method="PATCH",
        headers={CSRF_HEADER_NAME: "header-token"},
        cookies={CSRF_TOKEN_COOKIE_NAME: "cookie-token"},
    )
    with pytest.raises(HTTPException) as exc_info:
        validate_csrf_for_cookie_auth(request)

    assert exc_info.value.status_code == 403
    assert "일치하지" in exc_info.value.detail


def test_validate_csrf_for_cookie_auth_accepts_matching_token() -> None:
    token = "same-token"
    request = _request(
        method="DELETE",
        headers={CSRF_HEADER_NAME: token},
        cookies={CSRF_TOKEN_COOKIE_NAME: token},
    )
    validate_csrf_for_cookie_auth(request)


def test_set_auth_cookies_writes_access_refresh_and_csrf() -> None:
    response = Response()
    set_auth_cookies(
        response,
        access_token="access-value",
        refresh_token="refresh-value",
        settings=_settings(public_base_url="https://app.example.com"),
    )

    set_cookie_headers = response.headers.getlist("set-cookie")
    assert len(set_cookie_headers) == 3

    by_cookie_name = {item.split("=", 1)[0]: item for item in set_cookie_headers}

    access_cookie = by_cookie_name[ACCESS_TOKEN_COOKIE_NAME]
    assert "HttpOnly" in access_cookie
    assert "Secure" in access_cookie
    assert "SameSite=lax" in access_cookie
    assert "Max-Age=1800" in access_cookie

    refresh_cookie = by_cookie_name[REFRESH_TOKEN_COOKIE_NAME]
    assert "HttpOnly" in refresh_cookie
    assert "Secure" in refresh_cookie
    assert "SameSite=lax" in refresh_cookie
    assert "Max-Age=604800" in refresh_cookie

    csrf_cookie = by_cookie_name[CSRF_TOKEN_COOKIE_NAME]
    assert "HttpOnly" not in csrf_cookie
    assert "Secure" in csrf_cookie
    assert "SameSite=lax" in csrf_cookie
    assert "Max-Age=604800" in csrf_cookie


def test_set_access_cookie_sets_access_and_csrf() -> None:
    response = Response()
    set_access_cookie(
        response,
        access_token="access-value",
        settings=_settings(public_base_url="http://localhost:3000"),
    )

    set_cookie_headers = response.headers.getlist("set-cookie")
    assert len(set_cookie_headers) == 2

    by_cookie_name = {item.split("=", 1)[0]: item for item in set_cookie_headers}

    access_cookie = by_cookie_name[ACCESS_TOKEN_COOKIE_NAME]
    assert "HttpOnly" in access_cookie
    assert "Secure" not in access_cookie

    csrf_cookie = by_cookie_name[CSRF_TOKEN_COOKIE_NAME]
    assert "HttpOnly" not in csrf_cookie
    assert "Secure" not in csrf_cookie


def test_clear_auth_cookies_expires_all_auth_cookies() -> None:
    response = Response()
    clear_auth_cookies(response, settings=_settings(public_base_url="https://app.example.com"))

    set_cookie_headers = response.headers.getlist("set-cookie")
    assert len(set_cookie_headers) == 3

    by_cookie_name = {item.split("=", 1)[0]: item for item in set_cookie_headers}
    for cookie_name in (ACCESS_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME, CSRF_TOKEN_COOKIE_NAME):
        assert "Max-Age=0" in by_cookie_name[cookie_name]
        assert "SameSite=lax" in by_cookie_name[cookie_name]


def test_get_token_from_cookie_helpers() -> None:
    request = _request(
        method="GET",
        cookies={
            ACCESS_TOKEN_COOKIE_NAME: "access-cookie-token",
            REFRESH_TOKEN_COOKIE_NAME: "refresh-cookie-token",
        },
    )
    assert get_access_token_from_cookie(request) == "access-cookie-token"
    assert get_refresh_token_from_cookie(request) == "refresh-cookie-token"
