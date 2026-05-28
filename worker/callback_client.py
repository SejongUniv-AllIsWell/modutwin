import logging
import os
import requests

try:
    from callback_http import post_json
except ModuleNotFoundError:
    from worker.callback_http import post_json

logger = logging.getLogger(__name__)

_CALLBACK_BASE_URL = (os.getenv("BACKEND_CALLBACK_URL") or "").strip()
_CALLBACK_TOKEN = (os.getenv("WORKER_CALLBACK_TOKEN") or "").strip()
_TIMEOUT_SECONDS = 5


def _post_callback(path: str, payload: dict) -> None:
    if not _CALLBACK_BASE_URL:
        logger.info("BACKEND_CALLBACK_URL is not set; skipping worker callback to %s.", path)
        return
    if not _CALLBACK_TOKEN:
        logger.warning(
            "WORKER_CALLBACK_TOKEN is not set; skipping worker callback to %s despite configured BACKEND_CALLBACK_URL.",
            path,
        )
        return

    callback_url = f"{_CALLBACK_BASE_URL.rstrip('/')}{path}"
    try:
        post_json(
            callback_url,
            payload,
            headers={
                "Content-Type": "application/json",
                "X-Worker-Token": _CALLBACK_TOKEN,
            },
            timeout=_TIMEOUT_SECONDS,
        )
    except RuntimeError as exc:
        logger.error(
            "Worker callback HTTP error to %s: %s body=%s",
            callback_url,
            _extract_status_code(exc),
            _extract_error_body(exc),
        )
        raise
    except requests.RequestException:
        logger.exception("Worker callback request failed: %s", callback_url)
        raise


def _extract_status_code(exc: RuntimeError) -> str:
    message = str(exc)
    if message.startswith("HTTP "):
        return message.split(" ", 2)[1]
    return "unknown"


def _extract_error_body(exc: RuntimeError) -> str:
    marker = "body="
    message = str(exc)
    if marker not in message:
        return ""
    return message.split(marker, 1)[1][:300]


def notify_task_success(task_id: str, result_dict: dict) -> None:
    payload = {
        "celery_task_id": task_id,
        "upload_id": result_dict.get("upload_id"),
        "ply_key": result_dict.get("ply_key"),
        "sog_key": result_dict.get("sog_key"),
        "web_sog_key": result_dict.get("web_sog_key"),
        "metadata_key": result_dict.get("metadata_key"),
    }
    _post_callback("/internal/worker/tasks/success", payload)


def notify_sog_ready(scene_id: str, sog_key: str) -> None:
    payload = {
        "scene_id": scene_id,
        "sog_key": sog_key,
    }
    _post_callback("/internal/worker/scenes/sog-ready", payload)


def notify_task_failure(task_id: str, upload_id: str | None, error_message: str | None) -> None:
    payload = {
        "celery_task_id": task_id,
        "upload_id": upload_id,
        "error_message": error_message,
    }
    _post_callback("/internal/worker/tasks/failure", payload)
