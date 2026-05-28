import os
import shutil
import logging
import tempfile

from celery_app import app
from minio_helper import download_file, upload_file
from redis_helper import update_progress, clear_progress
from backend_callback import notify_upload_progress
from callback_client import notify_task_failure, notify_task_success, notify_scene_sog

from pipeline.runner import PipelineRunner
from pipeline.sog_converter import SogConverterModule, convert_to_sog

try:
    from pipeline.ffmpeg_module import FFmpegModule
    from pipeline.blur_detection import BlurDetectionModule
    from pipeline.colmap_module import ColmapModule
    from pipeline.gsplat_module import GsplatModule
    _PIPELINE_AVAILABLE = True
except ImportError:
    _PIPELINE_AVAILABLE = False

logger = logging.getLogger(__name__)

PLY_EXT = {".ply"}
VIDEO_EXT = {".mp4", ".mov", ".avi", ".mkv", ".webm"}


def _check_magic_bytes(file_path: str, ext: str) -> bool:
    """파일 헤더(magic bytes)가 확장자와 일치하는지 확인한다.
    불일치 시 False 반환. .splat/.sog 등 비표준 포맷은 True(패스) 처리.
    """
    try:
        with open(file_path, "rb") as f:
            header = f.read(16)
    except OSError:
        return False

    if len(header) < 4:
        return False

    ext = ext.lower()

    if ext in (".mp4", ".mov"):
        # ISO base media file: bytes 4-7 == b"ftyp"
        return len(header) >= 8 and header[4:8] == b"ftyp"
    elif ext == ".avi":
        return header[:4] == b"RIFF" and len(header) >= 12 and header[8:12] == b"AVI "
    elif ext in (".mkv", ".webm"):
        return header[:4] == b"\x1a\x45\xdf\xa3"
    elif ext in (".jpg", ".jpeg"):
        return header[:3] == b"\xff\xd8\xff"
    elif ext == ".png":
        return header[:8] == b"\x89PNG\r\n\x1a\n"
    elif ext == ".gif":
        return header[:4] == b"GIF8"
    elif ext == ".bmp":
        return header[:2] == b"BM"
    elif ext == ".webp":
        return header[:4] == b"RIFF" and len(header) >= 12 and header[8:12] == b"WEBP"
    elif ext == ".ply":
        return header[:3] == b"ply"
    # .splat, .sog — 비표준 포맷, 시그니처 검사 생략
    return True


def _module_base(building_id: str, floor_id: str, module_id: str, module_name: str) -> str:
    return f"buildings/{building_id}/{floor_id}/modules/{module_id}_{module_name}"


@app.task(
    name="tasks.training.run_3dgs_training",
    bind=True,
    max_retries=2,
    default_retry_delay=60,
)
def run_3dgs_training(self, upload_id: str, user_id: str, minio_input_key: str,
                       building_id: str, floor_id: str, module_id: str,
                       module_name: str, ply_target: str = "gsplat"):
    """3DGS 학습 파이프라인 태스크.

    입력이 PLY인 경우:
      - ply_target="gsplat": gsplat/ 폴더에 이미 저장됨. SOG 변환만 수행.
      - ply_target="alignment": alignment/ 폴더에 저장됨 (skip_training으로 여기 도달 안 함).

    입력이 video/image인 경우:
      - 전체 파이프라인 실행 → gsplat/ 에 결과 저장.
    """
    task_id = self.request.id
    work_dir = tempfile.mkdtemp(prefix=f"3dgs_{upload_id}_")
    module_base = _module_base(building_id, floor_id, module_id, module_name)

    logger.info(f"[Task {task_id}] 3DGS 학습 시작: upload_id={upload_id}")
    processing_completed = False
    success_callback_failed = False

    try:
        ext = os.path.splitext(minio_input_key)[1].lower()
        is_ply = ext in PLY_EXT

        # 1. MinIO에서 원본 파일 다운로드
        update_progress(task_id, 0, "다운로드")
        local_input = os.path.join(work_dir, f"input{ext}")
        download_file(minio_input_key, local_input)
        logger.info(f"[Task {task_id}] 다운로드 완료: {minio_input_key}")

        # 파일 시그니처 검증 (magic bytes)
        if not _check_magic_bytes(local_input, ext):
            raise ValueError(
                f"파일 시그니처 불일치: 확장자 '{ext}'에 맞지 않는 파일입니다. "
                "위장된 파일 업로드가 차단되었습니다."
            )
        logger.info(f"[Task {task_id}] 파일 시그니처 검증 통과: {ext}")

        if is_ply:
            # PLY 파일: SOG 변환만 수행하여 gsplat/ 에 저장
            update_progress(task_id, 50, "SOG 변환")
            sog_local = os.path.join(work_dir, f"{module_name}.sog")
            convert_to_sog(local_input, output_path=sog_local)

            update_progress(task_id, 90, "업로드")
            ply_key = f"{module_base}/gsplat/{module_name}.ply"
            sog_key = f"{module_base}/gsplat/{module_name}.sog"
            upload_file(local_input, ply_key)
            upload_file(sog_local, sog_key)

            update_progress(task_id, 100, "완료")
            result = {
                "status": "completed",
                "upload_id": upload_id,
                "ply_key": ply_key,
                "sog_key": sog_key,
            }
            processing_completed = True
            try:
                notify_task_success(task_id, result)
            except Exception as callback_err:
                success_callback_failed = True
                logger.error(f"[Task {task_id}] 성공 콜백 전송 실패: {callback_err}")
                raise
            return result

        # 2. 파이프라인 실행 (video / image)
        if not _PIPELINE_AVAILABLE:
            raise RuntimeError(
                "학습 파이프라인 모듈이 설치되지 않았습니다. "
                "FFmpegModule, BlurDetectionModule, ColmapModule, GsplatModule을 확인하세요."
            )

        def progress_callback(progress, module_nm):
            scaled = 5 + int(progress * 0.85)
            update_progress(task_id, scaled, module_nm)

        modules = [
            FFmpegModule(fps=2),
            BlurDetectionModule(),
            ColmapModule(),
            GsplatModule(),
            SogConverterModule(),
        ]

        runner = PipelineRunner(modules)
        sog_path = runner.run(local_input, progress_callback)
        ply_path = os.path.splitext(sog_path)[0] + ".ply"

        # 3. MinIO에 결과 업로드 → gsplat/ 폴더
        update_progress(task_id, 90, "업로드")
        ply_key = f"{module_base}/gsplat/{module_name}.ply"
        sog_key = f"{module_base}/gsplat/{module_name}.sog"

        if os.path.isfile(ply_path):
            upload_file(ply_path, ply_key)
        upload_file(sog_path, sog_key)

        logger.info(f"[Task {task_id}] 결과 업로드 완료")

        update_progress(task_id, 100, "완료")

        result = {
            "status": "completed",
            "upload_id": upload_id,
            "ply_key": ply_key,
            "sog_key": sog_key,
        }
        processing_completed = True
        try:
            notify_task_success(task_id, result)
        except Exception as callback_err:
            success_callback_failed = True
            logger.error(f"[Task {task_id}] 성공 콜백 전송 실패: {callback_err}")
            raise
        return result

    except Exception as e:
        if not processing_completed and not success_callback_failed:
            logger.error(f"[Task {task_id}] 실패: {e}")
            try:
                notify_task_failure(task_id, upload_id, str(e))
            except Exception as callback_err:
                logger.error(f"[Task {task_id}] 실패 콜백 전송 실패: {callback_err}")
            update_progress(task_id, -1, f"실패: {str(e)[:200]}")
        raise

    finally:
        if os.path.exists(work_dir):
            shutil.rmtree(work_dir, ignore_errors=True)
        clear_progress(task_id)


@app.task(
    name="tasks.training.run_gs_training_from_colmap",
    bind=True,
    max_retries=1,
    default_retry_delay=60,
)
def run_gs_training_from_colmap(self, upload_id: str, user_id: str, zip_minio_key: str, bounds: dict):
    """COLMAP 전처리 결과 + bounding box → GS 학습 태스크.

    파이프라인:
      1. MinIO에서 원본 zip 다운로드 → 이미지 추출
      2. MinIO에서 sparse/0/*.bin 다운로드 (COLMAP 재실행 없음)
      3. GsplatModule(bounds) → PLY 생성
      4. MinIO에 PLY 저장

    결과:
      users/{user_id}/gsplat/{upload_id}/output.ply
    """
    task_id  = self.request.id
    work_dir = tempfile.mkdtemp(prefix=f"gs_{upload_id}_")
    result_base = f"users/{user_id}/gsplat/{upload_id}"

    logger.info(f"[Task {task_id}] GS 학습 시작: upload_id={upload_id}, bounds={bounds}")

    try:
        from pipeline.ffmpeg_module import FFmpegModule
        from pipeline.gsplat_module import GsplatModule
    except ImportError as e:
        update_progress(task_id, -1, f"파이프라인 모듈 로드 실패: {e}")
        raise RuntimeError(str(e))

    try:
        # 1. zip 다운로드 → 이미지 추출
        update_progress(task_id, 5, "이미지 추출")
        ext = os.path.splitext(zip_minio_key)[1].lower()
        local_zip = os.path.join(work_dir, f"input{ext}")
        download_file(zip_minio_key, local_zip)

        ffmpeg = FFmpegModule(fps=2)
        image_dir = ffmpeg.run(local_zip)
        logger.info(f"[Task {task_id}] 이미지 추출 완료: {image_dir}")

        # 2. pre-computed sparse/0/*.bin 다운로드
        update_progress(task_id, 20, "COLMAP 결과 다운로드")
        sparse0_dir = os.path.join(work_dir, "sparse", "0")
        os.makedirs(sparse0_dir, exist_ok=True)

        colmap_base = f"users/{user_id}/colmap/{upload_id}/sparse/0"
        for fname in ["cameras.bin", "images.bin", "points3D.bin"]:
            download_file(f"{colmap_base}/{fname}", os.path.join(sparse0_dir, fname))
            logger.info(f"[Task {task_id}] 다운로드: {fname}")

        # images/ 폴더를 work_dir 하위로 이동
        images_link = os.path.join(work_dir, "images")
        if os.path.isdir(image_dir) and not os.path.exists(images_link):
            os.rename(image_dir, images_link)

        # 3. GS 학습
        update_progress(task_id, 30, "GS 학습 중")
        gsplat = GsplatModule(bounds=bounds)
        ply_path = gsplat.run(work_dir)
        logger.info(f"[Task {task_id}] 학습 완료: {ply_path}")

        # 4. MinIO 업로드 (PLY 만)
        #    중간 SOG 는 만들지 않는다 — DB 가 가리키지 않는 고아 파일이었고,
        #    최종 씬 SOG 는 commit_final/save_refined 이후 convert_scene_sog 가
        #    최종 PLY 로 별도 생성한다.
        update_progress(task_id, 90, "업로드")
        ply_key = f"{result_base}/output.ply"
        upload_file(ply_path, ply_key)
        logger.info(f"[Task {task_id}] PLY 업로드: {ply_key}")

        update_progress(task_id, 100, "완료")

        # 백엔드에 GS 단계 완료 통지 — Upload.status=completed + gsplat_ply_path 저장
        notify_upload_progress(
            upload_id, "gsplat", status="completed",
            ply_key=ply_key, celery_task_id=task_id,
        )

        return {"status": "completed", "upload_id": upload_id, "ply_key": ply_key}

    except Exception as e:
        logger.error(f"[Task {task_id}] 실패: {e}")
        update_progress(task_id, -1, f"실패: {str(e)[:200]}")
        notify_upload_progress(
            upload_id, "gsplat", status="failed",
            celery_task_id=task_id, error_message=str(e)[:500],
        )
        raise

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
        clear_progress(task_id)


@app.task(
    name="tasks.training.convert_scene_sog",
    bind=True,
    max_retries=2,
    default_retry_delay=30,
)
def convert_scene_sog(self, scene_id: str, ply_key: str, sog_key: str):
    """이미 저장된 최종 씬 PLY 를 SOG 로 변환해 SceneOutput.sog_path 를 갱신한다.

    commit_final / save_refined 가 final PLY 를 MinIO 에 올린 뒤 호출한다. 변환 전엔
    sog_path 가 PLY fallback 이라 뷰어는 즉시 동작하고, 변환이 끝나면 콜백으로 실제
    SOG 키로 교체된다. 변환이 실패해도(예: 비-가우시안 PLY) sog_path 는 PLY 그대로
    남아 뷰어 동작에는 지장이 없다.
    """
    task_id = self.request.id
    work_dir = tempfile.mkdtemp(prefix=f"scenesog_{scene_id}_")

    logger.info(f"[Task {task_id}] 씬 SOG 변환 시작: scene_id={scene_id}, ply={ply_key}")
    try:
        ext = os.path.splitext(ply_key)[1].lower() or ".ply"
        local_ply = os.path.join(work_dir, f"input{ext}")
        download_file(ply_key, local_ply)

        sog_local = os.path.join(work_dir, "scene.sog")
        convert_to_sog(local_ply, output_path=sog_local)
        upload_file(sog_local, sog_key)

        notify_scene_sog(scene_id, sog_key)
        logger.info(f"[Task {task_id}] 씬 SOG 변환 완료: {sog_key}")
        return {"status": "completed", "scene_id": scene_id, "sog_key": sog_key}

    except Exception as e:
        logger.error(f"[Task {task_id}] 씬 SOG 변환 실패 (sog_path 는 PLY fallback 유지): {e}")
        raise

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
