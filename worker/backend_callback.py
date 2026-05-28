"""워커 → 백엔드 콜백 호출 헬퍼.

워커는 호스트에서 실행되어 backend 컨테이너 (nginx 경유) 로 HTTP 요청을 보낸다.
환경변수:
  BACKEND_INTERNAL_URL : 백엔드 base URL (default: http://localhost)
  INTERNAL_API_TOKEN   : 백엔드와 공유하는 시크릿
"""
import logging
import os
from typing import Optional

import requests
try:
    from callback_http import post_json
except ModuleNotFoundError:
    from worker.callback_http import post_json

logger = logging.getLogger(__name__)

BACKEND_URL = os.environ.get("BACKEND_INTERNAL_URL", "http://localhost").rstrip("/")
INTERNAL_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")


def _parse_http_error(message: str) -> tuple[str, str]:
    if not message.startswith("HTTP "):
        return "unknown", message[:200]
    code_and_rest = message[5:]
    if " body=" not in code_and_rest:
        return code_and_rest.strip() or "unknown", ""
    code, body = code_and_rest.split(" body=", 1)
    return code.strip() or "unknown", body[:200]


def notify_upload_progress(
    upload_id: str,
    stage: str,
    *,
    status: str = "completed",
    ply_key: Optional[str] = None,
    celery_task_id: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    """파이프라인 단계 완료 / 실패 시 백엔드에 통지. 실패해도 워커 작업 자체는 성공으로 둔다."""
    if not INTERNAL_TOKEN:
        logger.warning("[backend_callback] INTERNAL_API_TOKEN 미설정 — 콜백 스킵")
        return

    url = f"{BACKEND_URL}/api/internal/uploads/{upload_id}/complete"
    payload = {"stage": stage, "status": status}
    if ply_key:
        payload["ply_key"] = ply_key
    if celery_task_id:
        payload["celery_task_id"] = celery_task_id
    if error_message:
        payload["error_message"] = error_message

    try:
        post_json(
            url,
            payload,
            headers={
                "X-Internal-Token": INTERNAL_TOKEN,
            },
            timeout=10,
        )
        logger.info(f"[backend_callback] {stage} {status} 통지 완료 (upload_id={upload_id})")
    except RuntimeError as e:
        status_code, response_body = _parse_http_error(str(e))
        logger.error(f"[backend_callback] {url} -> {status_code} {response_body}")
    except requests.RequestException as e:
        logger.error(f"[backend_callback] {url} 요청 실패: {e}")
