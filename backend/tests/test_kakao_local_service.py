import asyncio
import importlib
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException, status


def _reload_kakao_local_service():
    module = importlib.import_module("app.services.kakao_local_service")
    return importlib.reload(module)


class _DummyResponse:
    def __init__(self, *, is_success: bool, status_code: int, payload=None, json_error: bool = False):
        self.is_success = is_success
        self.status_code = status_code
        self._payload = payload
        self._json_error = json_error

    def json(self):
        if self._json_error:
            raise ValueError("invalid json")
        return self._payload


def test_call_kakao_local_api_requires_key(required_env: dict[str, str], monkeypatch) -> None:
    kakao_local_service = _reload_kakao_local_service()
    monkeypatch.setattr(kakao_local_service, "settings", SimpleNamespace(KAKAO_REST_API_KEY=""))

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(kakao_local_service.call_kakao_local_api(url="https://example.com", params={"query": "a"}))

    assert exc_info.value.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
    assert exc_info.value.detail == "KAKAO_REST_API_KEY 설정이 필요합니다."


def test_call_kakao_local_api_maps_httpx_error_to_502(required_env: dict[str, str], monkeypatch) -> None:
    kakao_local_service = _reload_kakao_local_service()
    monkeypatch.setattr(kakao_local_service, "settings", SimpleNamespace(KAKAO_REST_API_KEY="test-key"))

    class _FailingClient:
        def __init__(self, timeout: float):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url, headers, params):
            raise httpx.ReadTimeout("timeout")

    monkeypatch.setattr(kakao_local_service.httpx, "AsyncClient", _FailingClient)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(kakao_local_service.call_kakao_local_api(url="https://example.com", params={"query": "a"}))

    assert exc_info.value.status_code == status.HTTP_502_BAD_GATEWAY
    assert exc_info.value.detail == "Kakao Local API 호출 실패: ReadTimeout"


def test_call_kakao_local_api_maps_limit_error_to_429(required_env: dict[str, str], monkeypatch) -> None:
    kakao_local_service = _reload_kakao_local_service()
    monkeypatch.setattr(kakao_local_service, "settings", SimpleNamespace(KAKAO_REST_API_KEY="test-key"))

    class _LimitClient:
        def __init__(self, timeout: float):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url, headers, params):
            return _DummyResponse(
                is_success=False,
                status_code=400,
                payload={"code": -10, "message": "API usage limit exceeded"},
            )

    monkeypatch.setattr(kakao_local_service.httpx, "AsyncClient", _LimitClient)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(kakao_local_service.call_kakao_local_api(url="https://example.com", params={"query": "a"}))

    assert exc_info.value.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert exc_info.value.detail == "Kakao Local API 오류(code=-10): API usage limit exceeded"


def test_call_kakao_local_api_maps_other_non_success_to_502(
    required_env: dict[str, str], monkeypatch
) -> None:
    kakao_local_service = _reload_kakao_local_service()
    monkeypatch.setattr(kakao_local_service, "settings", SimpleNamespace(KAKAO_REST_API_KEY="test-key"))

    class _ErrorClient:
        def __init__(self, timeout: float):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url, headers, params):
            return _DummyResponse(
                is_success=False,
                status_code=400,
                payload={"code": -2, "message": "invalid parameter"},
            )

    monkeypatch.setattr(kakao_local_service.httpx, "AsyncClient", _ErrorClient)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(kakao_local_service.call_kakao_local_api(url="https://example.com", params={"query": "a"}))

    assert exc_info.value.status_code == status.HTTP_502_BAD_GATEWAY
    assert exc_info.value.detail == "Kakao Local API 오류(code=-2): invalid parameter"


def test_call_kakao_local_api_maps_invalid_success_json_to_502(
    required_env: dict[str, str], monkeypatch
) -> None:
    kakao_local_service = _reload_kakao_local_service()
    monkeypatch.setattr(kakao_local_service, "settings", SimpleNamespace(KAKAO_REST_API_KEY="test-key"))

    class _InvalidJsonClient:
        def __init__(self, timeout: float):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url, headers, params):
            return _DummyResponse(is_success=True, status_code=200, json_error=True)

    monkeypatch.setattr(kakao_local_service.httpx, "AsyncClient", _InvalidJsonClient)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(kakao_local_service.call_kakao_local_api(url="https://example.com", params={"query": "a"}))

    assert exc_info.value.status_code == status.HTTP_502_BAD_GATEWAY
    assert exc_info.value.detail == "Kakao Local API 응답이 JSON 형식이 아닙니다."
