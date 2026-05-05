from pathlib import Path
import sys

import pytest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


@pytest.fixture
def required_env(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    env = {
        "POSTGRES_PASSWORD": "postgres-test-password",
        "REDIS_PASSWORD": "redis-test-password",
        "RABBITMQ_DEFAULT_PASS": "rabbitmq-test-password",
        "MINIO_SECRET_KEY": "minio-test-secret",
        "JWT_SECRET_KEY": "jwt-test-secret",
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    from app.core.config import get_settings

    get_settings.cache_clear()
    yield env
    get_settings.cache_clear()
