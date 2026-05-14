import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.middleware import AccessLogMiddleware
from app.api.auth import router as auth_router
from app.api.uploads import router as uploads_router
from app.api.scenes import router as scenes_router
from app.api.tasks import router as tasks_router
from app.api.ws import router as ws_router
from app.api.notifications import router as notifications_router
from app.api.basemaps import router as basemaps_router, public_router as basemaps_public_router
from app.api.buildings import router as buildings_router
from app.api.refine import router as refine_router
from app.api.internal_worker import router as internal_worker_router
from app.api.kakao import router as kakao_router
from app.api.module_register import router as module_register_router


from app.core.config import get_settings
from app.services.minio_service import get_minio_service
from app.services.sam3_temp_storage import cleanup_loop as sam3_temp_cleanup_loop, ensure_temp_dir as sam3_ensure_temp_dir

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_minio_service()  # MinIO 버킷 자동 생성
    sam3_ensure_temp_dir()
    cleanup_task = asyncio.create_task(sam3_temp_cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="3DGS Platform API",
    root_path="/api",
    lifespan=lifespan,
)

# CORS
cors_origins = ["*"]
if settings.PUBLIC_BASE_URL and not settings.DEV_MODE:
    cors_origins = [settings.PUBLIC_BASE_URL, "http://localhost"]
    if settings.CORS_EXTRA_ORIGINS:
        cors_origins += [o.strip() for o in settings.CORS_EXTRA_ORIGINS.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 액세스 로그
app.add_middleware(AccessLogMiddleware)

# 라우터 등록
app.include_router(auth_router)
# 새 모듈 등록 흐름 라우터는 uploads_router 보다 먼저 등록해서, 동일 prefix(/uploads) 하에서
# 새 흐름 경로(/uploads/sam3/prepare, /uploads/sam3/detect-temp, /uploads/commit-final) 가
# 기존 /uploads/{upload_id}/... 패턴보다 먼저 매칭되도록.
app.include_router(module_register_router)
app.include_router(uploads_router)
app.include_router(scenes_router)
app.include_router(tasks_router)
app.include_router(ws_router)
app.include_router(notifications_router)
app.include_router(basemaps_router)
app.include_router(basemaps_public_router)
app.include_router(buildings_router)
app.include_router(refine_router)
app.include_router(internal_worker_router)
app.include_router(kakao_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
