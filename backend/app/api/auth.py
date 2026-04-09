from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import (
    create_access_token,
    create_refresh_token,
    hash_token,
    get_current_user,
)
from app.models import User, Session
from app.schemas.auth import (
    TokenResponse,
    RefreshRequest,
    AccessTokenResponse,
    UserResponse,
    LoginUrlResponse,
    AuthCodeExchangeRequest,
)
from app.services.auth_code_service import issue_auth_code, consume_auth_code

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"


def _resolve_frontend_base(request: Request) -> str:
    """프론트엔드 오리진 결정: Referer 헤더 → PUBLIC_BASE_URL → 상대 경로."""
    referer = request.headers.get("Referer", "")
    if referer:
        parsed = urlparse(referer)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    if settings.PUBLIC_BASE_URL:
        return settings.PUBLIC_BASE_URL
    return ""


async def _redirect_with_auth_code(
    request: Request, access_token: str, refresh_token: str
) -> RedirectResponse:
    """JWT를 Redis에 저장하고 1회용 코드를 쿼리로 전달하는 리다이렉트 생성."""
    code = await issue_auth_code(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )
    frontend_base = _resolve_frontend_base(request)
    return RedirectResponse(url=f"{frontend_base}/login/callback?code={code}")


@router.get("/dev-login")
async def dev_login(request: Request, db: AsyncSession = Depends(get_db)):
    """DEV_MODE 전용 — Google OAuth 없이 가짜 사용자로 JWT 발급"""
    if not settings.DEV_MODE:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    DEV_GOOGLE_ID = "dev_user_local"
    DEV_EMAIL = "dev@localhost"
    DEV_NAME = "Dev User"

    result = await db.execute(select(User).where(User.google_id == DEV_GOOGLE_ID))
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            google_id=DEV_GOOGLE_ID,
            email=DEV_EMAIL,
            name=DEV_NAME,
            avatar_url=None,
        )
        db.add(user)
        await db.flush()

    access_token = create_access_token(str(user.id), user.role.value)
    refresh_token = create_refresh_token()

    session = Session(
        user_id=user.id,
        refresh_token_hash=hash_token(refresh_token),
        expires_at=datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    )
    db.add(session)
    await db.commit()

    return await _redirect_with_auth_code(request, access_token, refresh_token)


@router.get("/login", response_model=LoginUrlResponse)
async def login(request: Request):
    """Google OAuth 로그인 URL 반환 (DEV_MODE시 dev-login URL 반환)"""
    if settings.DEV_MODE:
        proto = request.headers.get("X-Forwarded-Proto", "http")
        host = request.headers.get("Host", request.base_url.hostname)
        return LoginUrlResponse(url=f"{proto}://{host}/api/auth/dev-login")

    if settings.PUBLIC_BASE_URL:
        callback_url = f"{settings.PUBLIC_BASE_URL}/api/auth/callback"
    else:
        proto = request.headers.get("X-Forwarded-Proto", "http")
        host = request.headers.get("Host", request.base_url.hostname)
        callback_url = f"{proto}://{host}/api/auth/callback"

    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": callback_url,
        "response_type": "code",
        "scope": "openid email profile",
        "prompt": "select_account",
    }
    url = f"{GOOGLE_AUTH_URL}?{urlencode(params)}"
    return LoginUrlResponse(url=url)


@router.get("/callback")
async def callback(
    request: Request,
    db: AsyncSession = Depends(get_db),
    code: str | None = None,
    error: str | None = None,
):
    """Google 인증 코드로 사용자 정보 취득 → JWT 발급"""
    # Google이 access_denied 등 에러를 보낸 경우 로그인 페이지로 리다이렉트
    if error or not code:
        frontend_base = _resolve_frontend_base(request)
        return RedirectResponse(url=f"{frontend_base}/login?error={error or 'unknown'}")
    if settings.PUBLIC_BASE_URL:
        callback_url = f"{settings.PUBLIC_BASE_URL}/api/auth/callback"
    else:
        proto = request.headers.get("X-Forwarded-Proto", "http")
        host = request.headers.get("Host", request.base_url.hostname)
        callback_url = f"{proto}://{host}/api/auth/callback"

    # 1. 인증 코드 → Google Access Token 교환
    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "redirect_uri": callback_url,
                "grant_type": "authorization_code",
            },
        )

    if token_resp.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google 인증에 실패했습니다.",
        )

    google_tokens = token_resp.json()
    google_access_token = google_tokens.get("access_token")

    # 2. Google Access Token → 사용자 정보 취득
    async with httpx.AsyncClient() as client:
        userinfo_resp = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {google_access_token}"},
        )

    if userinfo_resp.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google 사용자 정보 취득에 실패했습니다.",
        )

    google_user = userinfo_resp.json()
    google_id = google_user["id"]
    email = google_user["email"]
    name = google_user.get("name", email)
    avatar_url = google_user.get("picture")

    # 3. DB에 사용자 저장/갱신
    result = await db.execute(select(User).where(User.google_id == google_id))
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            google_id=google_id,
            email=email,
            name=name,
            avatar_url=avatar_url,
        )
        db.add(user)
        await db.flush()
    else:
        user.email = email
        user.name = name
        user.avatar_url = avatar_url

    # 4. JWT 발급
    access_token = create_access_token(str(user.id), user.role.value)
    refresh_token = create_refresh_token()

    # 5. Refresh Token을 sessions 테이블에 저장
    session = Session(
        user_id=user.id,
        refresh_token_hash=hash_token(refresh_token),
        expires_at=datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    )
    db.add(session)
    await db.commit()

    return await _redirect_with_auth_code(request, access_token, refresh_token)


@router.post("/refresh", response_model=AccessTokenResponse)
async def refresh(
    body: RefreshRequest,
    db: AsyncSession = Depends(get_db),
):
    """Refresh Token → 새 Access Token 발급"""
    token_hash = hash_token(body.refresh_token)

    result = await db.execute(
        select(Session).where(
            Session.refresh_token_hash == token_hash,
            Session.is_revoked == False,
        )
    )
    session = result.scalar_one_or_none()

    if session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 Refresh Token입니다.",
        )

    if session.expires_at < datetime.now(timezone.utc):
        session.is_revoked = True
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="만료된 Refresh Token입니다.",
        )

    # 사용자 조회
    result = await db.execute(select(User).where(User.id == session.user_id))
    user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="사용자를 찾을 수 없습니다.",
        )

    access_token = create_access_token(str(user.id), user.role.value)

    return AccessTokenResponse(
        access_token=access_token,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    body: RefreshRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Refresh Token 무효화 (로그아웃)"""
    token_hash = hash_token(body.refresh_token)

    result = await db.execute(
        select(Session).where(
            Session.refresh_token_hash == token_hash,
            Session.user_id == user.id,
        )
    )
    session = result.scalar_one_or_none()

    if session:
        session.is_revoked = True
        await db.commit()

    return None


@router.post("/exchange", response_model=TokenResponse)
async def exchange(body: AuthCodeExchangeRequest):
    """1회용 auth code → access/refresh 토큰 교환.

    OAuth 콜백이 URL에 토큰을 직접 싣지 않도록, 짧은 수명(60s)의 1회용 코드를
    Redis에 저장하고 프론트엔드가 이 엔드포인트로 코드를 제출해 토큰을 수령한다.
    """
    payload = await consume_auth_code(body.code)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않거나 만료된 인증 코드입니다.",
        )

    return TokenResponse(
        access_token=payload["access_token"],
        refresh_token=payload["refresh_token"],
        expires_in=payload["expires_in"],
    )


@router.get("/me", response_model=UserResponse)
async def me(user: User = Depends(get_current_user)):
    """현재 로그인한 사용자 정보"""
    return user
