import os
import shutil
import logging
import tempfile

from celery_app import app
from minio_helper import download_file, upload_file
from redis_helper import update_progress, clear_progress

logger = logging.getLogger(__name__)


@app.task(
    name="tasks.colmap.run_colmap_preprocessing",
    bind=True,
    max_retries=1,
    default_retry_delay=30,
)
def run_colmap_preprocessing(self, upload_id: str, user_id: str, minio_input_key: str):
    """사진 zip → COLMAP SfM 전처리 태스크.

    파이프라인:
      FFmpegModule (zip 해제) → BlurDetectionModule → ColmapModule
    결과:
      users/{user_id}/colmap/{upload_id}/sparse/0/*.bin
      users/{user_id}/colmap/{upload_id}/colmap_result.json
    """
    task_id = self.request.id
    work_dir = tempfile.mkdtemp(prefix=f"colmap_{upload_id}_")
    result_base = f"users/{user_id}/colmap/{upload_id}"

    logger.info(f"[Task {task_id}] COLMAP 전처리 시작: upload_id={upload_id}")

    try:
        from pipeline.ffmpeg_module import FFmpegModule
        from pipeline.blur_detection import BlurDetectionModule
        from pipeline.colmap_module import ColmapModule
        from pipeline.runner import PipelineRunner
    except ImportError as e:
        update_progress(task_id, -1, f"파이프라인 모듈 로드 실패: {e}")
        raise RuntimeError(f"파이프라인 모듈이 설치되어 있지 않습니다: {e}")

    try:
        # 1. MinIO에서 zip 다운로드
        update_progress(task_id, 5, "다운로드")
        ext = os.path.splitext(minio_input_key)[1].lower()
        local_input = os.path.join(work_dir, f"input{ext}")
        download_file(minio_input_key, local_input)
        logger.info(f"[Task {task_id}] 다운로드 완료")

        # 2. 파이프라인 실행
        def _progress(pct: int, module_name: str):
            # 5~85% 구간을 파이프라인 진행률에 매핑
            scaled = 5 + int(pct * 0.80)
            update_progress(task_id, scaled, module_name)

        modules = [
            FFmpegModule(fps=2),
            BlurDetectionModule(),
            ColmapModule(),
        ]
        runner = PipelineRunner(modules)
        colmap_workspace = runner.run(local_input, _progress)

        # 3. 결과를 MinIO에 업로드
        update_progress(task_id, 88, "결과 업로드")

        # sparse/0/*.bin 업로드
        sparse0 = os.path.join(colmap_workspace, "sparse", "0")
        if os.path.isdir(sparse0):
            for fname in os.listdir(sparse0):
                local_bin = os.path.join(sparse0, fname)
                remote_key = f"{result_base}/sparse/0/{fname}"
                upload_file(local_bin, remote_key)
                logger.info(f"[Task {task_id}] 업로드: {remote_key}")

        # colmap_result.json 업로드 (뷰어용)
        result_json = os.path.join(colmap_workspace, "colmap_result.json")
        if os.path.isfile(result_json):
            remote_json_key = f"{result_base}/colmap_result.json"
            upload_file(result_json, remote_json_key, content_type="application/json")
            logger.info(f"[Task {task_id}] 결과 JSON 업로드: {remote_json_key}")
        else:
            raise RuntimeError("colmap_result.json이 생성되지 않았습니다.")

        update_progress(task_id, 100, "완료")
        logger.info(f"[Task {task_id}] COLMAP 전처리 완료")

        return {
            "status": "completed",
            "upload_id": upload_id,
            "result_key": f"{result_base}/colmap_result.json",
        }

    except Exception as e:
        logger.error(f"[Task {task_id}] 실패: {e}")
        update_progress(task_id, -1, f"실패: {str(e)[:200]}")
        raise

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
        clear_progress(task_id)
