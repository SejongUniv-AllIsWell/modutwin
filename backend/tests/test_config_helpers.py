from app.core.config import Settings, get_settings


def test_settings_assembles_urls_from_components(required_env: dict[str, str]) -> None:
    settings = Settings(
        POSTGRES_USER="tester",
        POSTGRES_PASSWORD=required_env["POSTGRES_PASSWORD"],
        POSTGRES_DB="modutwin",
        POSTGRES_HOST="db.internal",
        REDIS_PASSWORD=required_env["REDIS_PASSWORD"],
        REDIS_HOST="redis.internal",
        RABBITMQ_DEFAULT_USER="mq-user",
        RABBITMQ_DEFAULT_PASS=required_env["RABBITMQ_DEFAULT_PASS"],
        RABBITMQ_HOST="mq.internal",
        MINIO_SECRET_KEY=required_env["MINIO_SECRET_KEY"],
        JWT_SECRET_KEY=required_env["JWT_SECRET_KEY"],
    )

    assert settings.DATABASE_URL == "postgresql+asyncpg://tester:postgres-test-password@db.internal:5432/modutwin"
    assert settings.REDIS_URL == "redis://:redis-test-password@redis.internal:6379/0"
    assert settings.RABBITMQ_URL == "amqp://mq-user:rabbitmq-test-password@mq.internal:5672//"


def test_settings_preserves_explicit_urls(required_env: dict[str, str]) -> None:
    settings = Settings(
        POSTGRES_PASSWORD=required_env["POSTGRES_PASSWORD"],
        REDIS_PASSWORD=required_env["REDIS_PASSWORD"],
        RABBITMQ_DEFAULT_PASS=required_env["RABBITMQ_DEFAULT_PASS"],
        MINIO_SECRET_KEY=required_env["MINIO_SECRET_KEY"],
        JWT_SECRET_KEY=required_env["JWT_SECRET_KEY"],
        DATABASE_URL="postgresql+asyncpg://already:set@db:5432/existing",
        REDIS_URL="redis://custom-redis",
        RABBITMQ_URL="amqp://custom-rabbit",
    )

    assert settings.DATABASE_URL == "postgresql+asyncpg://already:set@db:5432/existing"
    assert settings.REDIS_URL == "redis://custom-redis"
    assert settings.RABBITMQ_URL == "amqp://custom-rabbit"


def test_get_settings_uses_lru_cache(required_env: dict[str, str]) -> None:
    first = get_settings()
    second = get_settings()

    assert first is second


def test_sam3_dispatch_alias_controls_enable_sam3(required_env: dict[str, str]) -> None:
    settings = Settings(
        POSTGRES_PASSWORD=required_env["POSTGRES_PASSWORD"],
        REDIS_PASSWORD=required_env["REDIS_PASSWORD"],
        RABBITMQ_DEFAULT_PASS=required_env["RABBITMQ_DEFAULT_PASS"],
        MINIO_SECRET_KEY=required_env["MINIO_SECRET_KEY"],
        JWT_SECRET_KEY=required_env["JWT_SECRET_KEY"],
        ENABLE_SAM3_DISPATCH=True,
    )

    assert settings.ENABLE_SAM3 is True
