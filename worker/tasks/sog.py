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

        # SOG_DEVICE=auto 면 WebGPU(Vulkan)로 GB10 사용을 시도하고, Vulkan ICD 미가용 등으로
        # 실패하면 CPU 로 자동 폴백한다. (auto 를 그대로 두면 Vulkan 없는 환경에서 SOG 가
        # 전부 죽으므로, 여기서 폴백을 보장해 auto 를 안전하게 만든다.)
        device = os.environ.get("SOG_DEVICE", "cpu")
        try:
            convert_to_sog(local_ply, output_path=local_sog, device=device)
        except Exception as gpu_err:
            if device != "cpu":
                logger.warning(
                    f"[Task {task_id}] GPU({device}) SOG 실패 → CPU 폴백: {gpu_err}"
                )
                convert_to_sog(local_ply, output_path=local_sog, device="cpu")
            else:
                raise

        sog_key = os.path.splitext(ply_key)[0] + ".sog"
        upload_file(local_sog, sog_key)

        notify_sog_ready(scene_id, sog_key)
        logger.info(f"[Task {task_id}] SOG 변환 완료: scene={scene_id} → {sog_key}")
        return {"status": "completed", "scene_id": scene_id, "sog_key": sog_key}

    except Exception as e:
        # PipelineError 등 일부 예외는 Celery result backend(Redis) pickle 이 불가해
        # UnpickleableExceptionWrapper 를 유발한다 → 평문 RuntimeError 로 변환해 raise.
        logger.error(f"[Task {task_id}] SOG 변환 실패 (scene={scene_id}): {e}")
        raise RuntimeError(f"SOG 변환 실패 (scene={scene_id}): {e}") from None

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
