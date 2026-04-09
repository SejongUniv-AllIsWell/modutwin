import time
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.core.database import async_session
from app.models import AccessLog


class AccessLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)

        # 헬스체크는 로깅 제외
        if request.url.path in ("/api/health", "/api/docs", "/api/openapi.json"):
            return response

        try:
            ip = request.headers.get("X-Real-IP", request.client.host if request.client else "unknown")
            user_agent = request.headers.get("User-Agent", "")
            endpoint = str(request.url.path)
            method = request.method

            # JWT에서 user_id 추출 시도 (없으면 None)
            user_id = getattr(request.state, "user_id", None)

            async with async_session() as session:
                log = AccessLog(
                    user_id=user_id,
                    ip_address=ip[:45],
                    endpoint=endpoint[:500],
                    method=method[:10],
                    user_agent=user_agent[:500] if user_agent else None,
                    status_code=response.status_code,
                )
                session.add(log)
                await session.commit()
        except Exception:
            # 로깅 실패가 요청 처리를 방해하면 안 됨
            pass

        return response
