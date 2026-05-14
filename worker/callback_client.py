import json
import logging
import os
import urllib.error
import urllib.request

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
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        callback_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Worker-Token": _CALLBACK_TOKEN,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
            status_code = response.getcode()
            if status_code >= 400:
                response_body = response.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"Worker callback failed: HTTP {status_code} body={response_body[:300]}")
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        logger.error(
            "Worker callback HTTP error to %s: %s body=%s",
            callback_url,
            exc.code,
            response_body[:300],
        )
        raise
    except Exception:
        logger.exception("Worker callback request failed: %s", callback_url)
        raise


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


def notify_task_failure(task_id: str, upload_id: str | None, error_message: str | None) -> None:
    payload = {
        "celery_task_id": task_id,
        "upload_id": upload_id,
        "error_message": error_message,
    }
    _post_callback("/internal/worker/tasks/failure", payload)
