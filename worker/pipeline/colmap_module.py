import os
import re
import shlex
import shutil
import logging
import subprocess
import tempfile
from typing import Callable, Optional

from pipeline.base import PipelineModule, PipelineError
from pipeline.subprocess_utils import run_capture

logger = logging.getLogger(__name__)

COLMAP_BIN = os.environ.get("COLMAP_BIN", "colmap")
COLMAP_MATCHER = os.environ.get("COLMAP_MATCHER", "sequential").lower()
COLMAP_USE_GPU = os.environ.get("COLMAP_USE_GPU", "0")
COLMAP_NUM_THREADS = os.environ.get("COLMAP_NUM_THREADS", str(min(os.cpu_count() or 2, 16)))
COLMAP_MAX_IMAGE_SIZE = os.environ.get("COLMAP_MAX_IMAGE_SIZE", "3840")
COLMAP_SEQUENTIAL_OVERLAP = os.environ.get("COLMAP_SEQUENTIAL_OVERLAP", "20")


class ColmapModule(PipelineModule):
    """COLMAP SfM + undistortion 모듈 (CLI 방식).

    입력: 이미지 디렉토리
    출력: undistorted 디렉토리
        ├── images/       ← undistorted 이미지
        └── sparse/
            └── 0/        ← cameras.bin, images.bin, points3D.bin
    """

    def __init__(self, progress_callback: Optional[Callable[[int, str], None]] = None):
        self.progress_callback = progress_callback

    @property
    def name(self) -> str:
        return "COLMAP"

    def validate_input(self, input_path: str) -> bool:
        if not os.path.isdir(input_path):
            raise PipelineError(self.name, f"이미지 디렉토리가 존재하지 않습니다: {input_path}")
        images = [
            f for f in os.listdir(input_path)
            if os.path.splitext(f)[1].lower() in {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
        ]
        if len(images) < 3:
            raise PipelineError(self.name, f"최소 3장 이상의 이미지가 필요합니다. (현재 {len(images)}장)")
        self._total_images = len(images)
        return True

    def _run_cmd(self, cmd: list, step: str) -> str:
        cmd_text = shlex.join(cmd)
        logger.info(f"[{self.name}] {step}: {cmd_text}")
        env = os.environ.copy()
        env.setdefault("QT_QPA_PLATFORM", "offscreen")
        env.setdefault("GLOG_logtostderr", "1")
        try:
            result = run_capture(cmd, text=True, env=env)
            return result.stdout + result.stderr
        except subprocess.CalledProcessError as e:
            output = "\n".join(part for part in [e.stdout, e.stderr] if part)
            if not output:
                output = "(stdout/stderr 비어 있음)"
            raise PipelineError(
                self.name,
                f"{step} 실패 (exit={e.returncode}, cmd={cmd_text}):\n{output[-4000:]}",
            )
        except FileNotFoundError:
            raise PipelineError(self.name, f"colmap 바이너리를 찾을 수 없습니다: {COLMAP_BIN}")

    def _gpu_enabled(self) -> bool:
        return str(COLMAP_USE_GPU).strip().lower() not in {"0", "false", "no", "off"}

    def _cmd_with_cpu_sift(self, cmd: list) -> list:
        cpu_cmd = list(cmd)
        for option in ("--SiftExtraction.use_gpu", "--SiftMatching.use_gpu"):
            if option in cpu_cmd:
                value_index = cpu_cmd.index(option) + 1
                if value_index < len(cpu_cmd):
                    cpu_cmd[value_index] = "0"
        return cpu_cmd

    def _run_cmd_with_cpu_fallback(self, cmd: list, step: str, cleanup_before_retry=None) -> str:
        try:
            return self._run_cmd(cmd, step)
        except PipelineError as exc:
            if not self._gpu_enabled():
                raise
            if "--SiftExtraction.use_gpu" not in cmd and "--SiftMatching.use_gpu" not in cmd:
                raise
            logger.warning(
                "[%s] %s GPU SIFT 실패, CPU SIFT로 재시도합니다: %s",
                self.name,
                step,
                exc,
            )
            if cleanup_before_retry:
                cleanup_before_retry()
            return self._run_cmd(self._cmd_with_cpu_sift(cmd), f"{step} (CPU fallback)")

    def _get_registered_images(self, folder_path: str) -> int:
        """colmap model_analyzer로 registered images 수 반환."""
        try:
            result = run_capture(
                [COLMAP_BIN, "model_analyzer", "--path", folder_path],
                text=True,
            )
            output = result.stdout + result.stderr
            match = re.search(r"Registered images:\s*(\d+)", output)
            return int(match.group(1)) if match else 0
        except Exception:
            return 0

    def _progress(self, pct: int, module_name: str) -> None:
        if self.progress_callback:
            self.progress_callback(pct, module_name)

    def run(self, input_path: str) -> str:
        self.validate_input(input_path)
        total_images = self._total_images

        parent_dir = os.path.dirname(os.path.abspath(input_path.rstrip(os.sep)))
        work_dir = tempfile.mkdtemp(prefix="colmap_", dir=parent_dir)

        database_path = os.path.join(work_dir, "database.db")
        sparse_dir    = os.path.join(work_dir, "sparse")
        undistorted_dir = os.path.join(work_dir, "undistorted")
        os.makedirs(sparse_dir, exist_ok=True)

        # 1. Feature extraction
        logger.info(f"[{self.name}] Feature extraction 시작: {input_path}")
        self._progress(60, "COLMAP feature extraction")
        feature_cmd = [
            COLMAP_BIN, "feature_extractor",
            "--database_path", database_path,
            "--image_path",    input_path,
            "--ImageReader.single_camera", "1",
            "--ImageReader.camera_model",  "OPENCV",
            "--SiftExtraction.use_gpu", COLMAP_USE_GPU,
            "--SiftExtraction.num_threads", COLMAP_NUM_THREADS,
            "--SiftExtraction.max_image_size", COLMAP_MAX_IMAGE_SIZE,
        ]
        self._run_cmd_with_cpu_fallback(
            feature_cmd,
            "feature_extractor",
            cleanup_before_retry=lambda: os.path.exists(database_path) and os.remove(database_path),
        )

        # 2. Exhaustive matching
        logger.info(f"[{self.name}] Feature matching 시작 ({COLMAP_MATCHER})")
        self._progress(68, f"COLMAP {COLMAP_MATCHER} matching")
        if COLMAP_MATCHER == "sequential":
            matcher_cmd = [
                COLMAP_BIN, "sequential_matcher",
                "--database_path", database_path,
                "--SiftMatching.use_gpu", COLMAP_USE_GPU,
                "--SiftMatching.num_threads", COLMAP_NUM_THREADS,
                "--SequentialMatching.overlap", COLMAP_SEQUENTIAL_OVERLAP,
            ]
        elif COLMAP_MATCHER == "exhaustive":
            matcher_cmd = [
                COLMAP_BIN, "exhaustive_matcher",
                "--database_path", database_path,
                "--SiftMatching.use_gpu", COLMAP_USE_GPU,
                "--SiftMatching.num_threads", COLMAP_NUM_THREADS,
            ]
        else:
            raise PipelineError(self.name, f"지원하지 않는 COLMAP_MATCHER 값입니다: {COLMAP_MATCHER}")
        self._run_cmd_with_cpu_fallback(matcher_cmd, f"{COLMAP_MATCHER}_matcher")

        # 3. Mapper
        logger.info(f"[{self.name}] Incremental mapping 시작")
        self._progress(76, "COLMAP mapping")
        self._run_cmd([
            COLMAP_BIN, "mapper",
            "--database_path", database_path,
            "--image_path",    input_path,
            "--output_path",   sparse_dir,
            "--Mapper.num_threads", COLMAP_NUM_THREADS,
        ], "mapper")

        # 4. 생성된 subfolder 목록 수집
        subfolders = sorted([
            d for d in os.listdir(sparse_dir)
            if os.path.isdir(os.path.join(sparse_dir, d))
        ])
        if not subfolders:
            raise PipelineError(self.name, "Mapper 결과가 없습니다. 이미지가 부족하거나 특징점을 찾지 못했습니다.")

        # 5. 각 subfolder model_analyzer 실행 → registered images 수집
        stats = []  # [(original_folder_name, registered_images)]
        for folder in subfolders:
            folder_path = os.path.join(sparse_dir, folder)
            reg = self._get_registered_images(folder_path)
            stats.append((folder, reg))
            logger.info(f"[{self.name}] sparse/{folder}: registered images = {reg}")

        # 6. registered images 내림차순 정렬 → 임시 이름으로 rename 후 최종 rename
        stats.sort(key=lambda x: x[1], reverse=True)

        for i, (folder, _) in enumerate(stats):
            os.rename(
                os.path.join(sparse_dir, folder),
                os.path.join(sparse_dir, f"{i}_tmp"),
            )
        for i in range(len(stats)):
            os.rename(
                os.path.join(sparse_dir, f"{i}_tmp"),
                os.path.join(sparse_dir, str(i)),
            )

        # 7. 정렬 결과 로그
        logger.info(f"[{self.name}] === Reconstruction 결과 (registered images 내림차순) ===")
        for i, (orig, reg) in enumerate(stats):
            logger.info(f"[{self.name}]   sparse/{i} ← 원래 '{orig}': {reg}장 등록")

        # 8. 품질 검증: 0번 폴더 registered images >= 총 이미지 수의 절반
        best_reg = stats[0][1]
        threshold = total_images / 2
        if best_reg < threshold:
            raise PipelineError(
                self.name,
                f"COLMAP failed: 최적 reconstruction {best_reg}장 등록 "
                f"< 총 이미지 절반 ({int(threshold)}/{total_images})",
            )
        logger.info(f"[{self.name}] COLMAP success: {best_reg}/{total_images}장 등록")

        # 9. Image undistortion
        logger.info(f"[{self.name}] Image undistortion 시작")
        self._progress(84, "COLMAP undistortion")
        os.makedirs(undistorted_dir, exist_ok=True)
        self._run_cmd([
            COLMAP_BIN, "image_undistorter",
            "--image_path", input_path,
            "--input_path", os.path.join(sparse_dir, "0"),
            "--output_path", undistorted_dir,
        ], "image_undistorter")

        # undistorted/sparse/ 파일을 undistorted/sparse/0/ 로 이동 (gsplat 호환)
        undist_sparse    = os.path.join(undistorted_dir, "sparse")
        undist_sparse_0  = os.path.join(undist_sparse, "0")
        os.makedirs(undist_sparse_0, exist_ok=True)
        for fname in os.listdir(undist_sparse):
            src = os.path.join(undist_sparse, fname)
            if os.path.isfile(src):
                shutil.move(src, os.path.join(undist_sparse_0, fname))

        logger.info(f"[{self.name}] 완료: {undistorted_dir}")
        return undistorted_dir
