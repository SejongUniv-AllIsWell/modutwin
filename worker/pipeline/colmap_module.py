import os
import re
import shutil
import logging
import subprocess
import tempfile

from pipeline.base import PipelineModule, PipelineError

logger = logging.getLogger(__name__)

COLMAP_BIN = os.environ.get("COLMAP_BIN", "colmap")


class ColmapModule(PipelineModule):
    """COLMAP SfM + undistortion 모듈 (CLI 방식).

    입력: 이미지 디렉토리
    출력: undistorted 디렉토리
        ├── images/       ← undistorted 이미지
        └── sparse/
            └── 0/        ← cameras.bin, images.bin, points3D.bin
    """

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
        logger.info(f"[{self.name}] {step}: {' '.join(cmd)}")
        try:
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            return result.stdout + result.stderr
        except subprocess.CalledProcessError as e:
            raise PipelineError(self.name, f"{step} 실패:\n{(e.stderr or '')[-500:]}")
        except FileNotFoundError:
            raise PipelineError(self.name, f"colmap 바이너리를 찾을 수 없습니다: {COLMAP_BIN}")

    def _get_registered_images(self, folder_path: str) -> int:
        """colmap model_analyzer로 registered images 수 반환."""
        try:
            result = subprocess.run(
                [COLMAP_BIN, "model_analyzer", "--path", folder_path],
                check=True, capture_output=True, text=True,
            )
            output = result.stdout + result.stderr
            match = re.search(r"Registered images:\s*(\d+)", output)
            return int(match.group(1)) if match else 0
        except Exception:
            return 0

    def run(self, input_path: str) -> str:
        self.validate_input(input_path)
        total_images = self._total_images

        work_dir = os.path.join(tempfile.gettempdir(), f"colmap_{os.getpid()}")
        os.makedirs(work_dir, exist_ok=True)

        database_path = os.path.join(work_dir, "database.db")
        sparse_dir    = os.path.join(work_dir, "sparse")
        undistorted_dir = os.path.join(work_dir, "undistorted")
        os.makedirs(sparse_dir, exist_ok=True)

        # 1. Feature extraction
        logger.info(f"[{self.name}] Feature extraction 시작: {input_path}")
        self._run_cmd([
            COLMAP_BIN, "feature_extractor",
            "--database_path", database_path,
            "--image_path",    input_path,
            "--ImageReader.single_camera", "1",
            "--ImageReader.camera_model",  "OPENCV",
        ], "feature_extractor")

        # 2. Exhaustive matching
        logger.info(f"[{self.name}] Feature matching 시작")
        self._run_cmd([
            COLMAP_BIN, "exhaustive_matcher",
            "--database_path", database_path,
        ], "exhaustive_matcher")

        # 3. Mapper
        logger.info(f"[{self.name}] Incremental mapping 시작")
        self._run_cmd([
            COLMAP_BIN, "mapper",
            "--database_path", database_path,
            "--image_path",    input_path,
            "--output_path",   sparse_dir,
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
