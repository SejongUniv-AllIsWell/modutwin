from datetime import datetime, timedelta, timezone
import logging
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth_cookies import (
    clear_auth_cookies,
    get_refresh_token_from_cookie,
    set_access_cookie,
    set_auth_cookies,
    validate_csrf_for_cookie_auth,
)
from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import (
    create_access_token,
    create_refresh_token,
    hash_token,
    get_current_user,
)
from app.models import User, Session, UserRole
from app.schemas.auth import (
    SessionResponse,
    UserResponse,
    LoginUrlResponse,
    AuthCodeExchangeRequest,
    WsTicketResponse,
)
from app.services.auth_code_service import issue_auth_code, consume_auth_code
from app.services.google_oauth_service import (
    GoogleIdTokenValidationError,
    verify_google_id_token,
)
from app.services.oauth_state_service import issue_oauth_state, consume_oauth_state
from app.services.ws_ticket_service import issue_ws_ticket, WS_TICKET_TTL_SECONDS

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()
logger = logging.getLogger(__name__)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"


def _public_base_url() -> str:
    if settings.PUBLIC_BASE_URL:
        return settings.PUBLIC_BASE_URL.rstrip("/")
    return ""


def _frontend_redirect_url(path: str) -> str:
    frontend_base = _public_base_url()
    if frontend_base:
        return f"{frontend_base}{path}"
    return path


def _resolve_oauth_callback_url(request: Request) -> str:
    """OAuth callback URL 결정. 운영(non-DEV)은 PUBLIC_BASE_URL 필수."""
    public_base = _public_base_url()
    if public_base:
        return f"{public_base}/api/auth/callback"

    if settings.DEV_MODE:
        proto = request.headers.get("X-Forwarded-Proto", "http")
        host = request.headers.get("Host", request.base_url.hostname)
        return f"{proto}://{host}/api/auth/callback"

    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="운영 OAuth에는 PUBLIC_BASE_URL 설정이 필요합니다.",
    )


def _login_error_redirect(error: str) -> RedirectResponse:
    query = urlencode({"error": error})
    return RedirectResponse(url=_frontend_redirect_url(f"/login?{query}"))


async def _redirect_with_auth_code(access_token: str, refresh_token: str) -> RedirectResponse:
    """JWT를 Redis에 저장하고 1회용 코드를 쿼리로 전달하는 리다이렉트 생성."""
    code = await issue_auth_code(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )
    query = urlencode({"code": code})
    return RedirectResponse(url=_frontend_redirect_url(f"/login/callback?{query}"))


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
            role=UserRole.admin,
        )
        db.add(user)
        await db.flush()
    elif user.role != UserRole.admin:
        # DEV_MODE 진입 시 기존 dev 유저도 admin 으로 승격
        user.role = UserRole.admin
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

    return await _redirect_with_auth_code(access_token, refresh_token)


@router.get("/login", response_model=LoginUrlResponse)
async def login(request: Request):
    """Google OAuth 로그인 URL 반환 (DEV_MODE시 dev-login URL 반환)"""
    if settings.DEV_MODE:
        proto = request.headers.get("X-Forwarded-Proto", "http")
        host = request.headers.get("Host", request.base_url.hostname)
        return LoginUrlResponse(url=f"{proto}://{host}/api/auth/dev-login")

    callback_url = _resolve_oauth_callback_url(request)
    oauth_state = await issue_oauth_state(callback_url)

    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": callback_url,
        "response_type": "code",
        "scope": "openid email profile",
        "prompt": "select_account",
        "state": oauth_state["state"],
        "code_challenge": oauth_state["code_challenge"],
        "code_challenge_method": "S256",
        "nonce": oauth_state["nonce"],
    }
    url = f"{GOOGLE_AUTH_URL}?{urlencode(params)}"
    return LoginUrlResponse(url=url)


@router.get("/callback")
async def callback(
    db: AsyncSession = Depends(get_db),
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    """Google 인증 코드로 사용자 정보 취득 → JWT 발급"""
    # Google이 access_denied 등 에러를 보낸 경우 로그인 페이지로 리다이렉트
    if error or not code:
        return _login_error_redirect(error or "unknown")

    if not settings.DEV_MODE and not _public_base_url():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="운영 OAuth에는 PUBLIC_BASE_URL 설정이 필요합니다.",
        )

    oauth_state = await consume_oauth_state(state)
    if oauth_state is None:
        return _login_error_redirect("invalid_state")

    callback_url = oauth_state.get("redirect_uri")
    code_verifier = oauth_state.get("code_verifier")
    nonce = oauth_state.get("nonce")
    if not callback_url or not code_verifier or not nonce:
        return _login_error_redirect("invalid_state")

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
                "code_verifier": code_verifier,
            },
        )

    if token_resp.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google 인증에 실패했습니다.",
        )

    google_tokens = token_resp.json()
    google_access_token = google_tokens.get("access_token")
    google_id_token = google_tokens.get("id_token")

    try:
        id_token_claims = await verify_google_id_token(
            id_token=google_id_token,
            audience=settings.GOOGLE_CLIENT_ID,
            expected_nonce=nonce,
        )
    except GoogleIdTokenValidationError as exc:
        logger.warning("Google ID token validation failed: %s", exc)
        return _login_error_redirect("invalid_id_token")

    google_id = id_token_claims["sub"]
    email = id_token_claims.get("email")
    if not email:
        return _login_error_redirect("invalid_id_token")

    name = id_token_claims.get("name")
    avatar_url = id_token_claims.get("picture")

    # ID token에 없는 프로필 정보만 userinfo에서 보강한다(식별자/이메일은 신뢰하지 않음).
    if google_access_token and (not name or not avatar_url):
        async with httpx.AsyncClient() as client:
            userinfo_resp = await client.get(
                GOOGLE_USERINFO_URL,
                headers={"Authorization": f"Bearer {google_access_token}"},
            )

        if userinfo_resp.status_code == 200:
            google_user = userinfo_resp.json()
            if not name:
                name = google_user.get("name")
            if not avatar_url:
                avatar_url = google_user.get("picture")

    if not name:
        name = email

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

    return await _redirect_with_auth_code(access_token, refresh_token)


@router.post("/refresh", response_model=SessionResponse)
async def refresh(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Refresh Token → 새 Access Token 발급"""
    refresh_token = get_refresh_token_from_cookie(request)

    if not refresh_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 Refresh Token입니다.",
        )

    validate_csrf_for_cookie_auth(request)

    token_hash = hash_token(refresh_token)

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
    set_access_cookie(response, access_token, settings)

    return SessionResponse(
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Refresh Token 무효화 (로그아웃)"""
    refresh_token = get_refresh_token_from_cookie(request)

    if refresh_token:
        validate_csrf_for_cookie_auth(request)
        token_hash = hash_token(refresh_token)
        result = await db.execute(
            select(Session).where(
                Session.refresh_token_hash == token_hash,
                Session.is_revoked == False,
            )
        )
        session = result.scalar_one_or_none()

        if session:
            session.is_revoked = True
            await db.commit()

    clear_auth_cookies(response, settings)
    return None


@router.post("/exchange", response_model=SessionResponse)
async def exchange(body: AuthCodeExchangeRequest, response: Response):
    """1회용 auth code → 세션 쿠키 설정.

    OAuth 콜백이 URL에 토큰을 직접 싣지 않도록, 짧은 수명(60s)의 1회용 코드를
    Redis에 저장하고 프론트엔드가 이 엔드포인트로 코드를 제출해 쿠키 세션을 완성한다.
    """
    payload = await consume_auth_code(body.code)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않거나 만료된 인증 코드입니다.",
        )

    set_auth_cookies(response, payload["access_token"], payload["refresh_token"], settings)
    return SessionResponse(
        expires_in=payload["expires_in"],
    )


@router.get("/me", response_model=UserResponse)
async def me(user: User = Depends(get_current_user)):
    """현재 로그인한 사용자 정보"""
    return user


@router.post("/ws-ticket", response_model=WsTicketResponse)
async def ws_ticket(user: User = Depends(get_current_user)):
    """WebSocket 핸드셰이크용 1회용 ticket 발급.

    클라이언트는 이 ticket을 `wss://.../api/ws?ticket=<ticket>` 으로 보낸다.
    access token은 URL에 노출되지 않으며, ticket은 60s 단명·1회용이다.
    """
    ticket = await issue_ws_ticket(str(user.id), user.role.value)
    return WsTicketResponse(ticket=ticket, expires_in=WS_TICKET_TTL_SECONDS)
