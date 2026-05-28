import os
import shutil
import logging
import tempfile

from celery_app import app
from minio_helper import download_file, upload_file
from callback_client import notify_sog_ready
from pipeline.sog_converter import convert_to_sog

logger = logging.getLogger(__name__)


@app.task(
    name="tasks.sog.convert_scene_to_sog",
    bind=True,
    max_retries=2,
    default_retry_delay=60,
)
def convert_scene_to_sog(self, scene_id: str, ply_key: str):
    """refined(정합 완료) PLY → SOG 변환 후 SceneOutput.sog_path 갱신 콜백.

    module 은 commit_final, basemap 은 다듬기 확정 시점에 발행된다. SOG 는 뷰어용
    경량 파생물이라 실패해도 표시는 PLY 로 폴백되므로 치명적이지 않다.
    """
    task_id = self.request.id
    work_dir = tempfile.mkdtemp(prefix=f"sog_{scene_id}_")
    try:
        local_ply = os.path.join(work_dir, "input.ply")
        download_file(ply_key, local_ply)

        local_sog = os.path.join(work_dir, "output.sog")
        convert_to_sog(local_ply, output_path=local_sog)

        sog_key = os.path.splitext(ply_key)[0] + ".sog"
        upload_file(local_sog, sog_key)

        notify_sog_ready(scene_id, sog_key)
        logger.info(f"[Task {task_id}] SOG 변환 완료: scene={scene_id} → {sog_key}")
        return {"status": "completed", "scene_id": scene_id, "sog_key": sog_key}

    except Exception as e:
        logger.error(f"[Task {task_id}] SOG 변환 실패 (scene={scene_id}): {e}")
        raise

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
