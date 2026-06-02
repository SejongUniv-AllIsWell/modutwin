import os
import logging
import shutil

from pipeline.base import PipelineModule, PipelineError

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff", ".tif"}
# Laplacian variance 기준치 — 이 값보다 낮으면 흐린 사진으로 판단
BLUR_THRESHOLD = 80.0
# 최소 이미지 수 보장 (너무 많이 걸러지면 COLMAP 실패)
MIN_IMAGES = 5


class BlurDetectionModule(PipelineModule):
    """흐린 이미지 필터링 모듈.

    OpenCV Laplacian variance로 blur 정도를 측정.
    threshold 미만이면 제거.
    """

    def __init__(self, threshold: float = BLUR_THRESHOLD):
        self.threshold = threshold

    @property
    def name(self) -> str:
        return "BlurDetection"

    def validate_input(self, input_path: str) -> bool:
        if not os.path.isdir(input_path):
            raise PipelineError(self.name, f"이미지 디렉토리가 존재하지 않습니다: {input_path}")
        return True

    def run(self, input_path: str) -> str:
        self.validate_input(input_path)

        try:
            import cv2
        except ImportError:
            logger.warning(f"[{self.name}] opencv 미설치 — blur 필터링 건너뜀.")
            return input_path

        images = sorted([
            f for f in os.listdir(input_path)
            if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS
        ])

        scores: list[tuple[str, float]] = []
        for fname in images:
            fpath = os.path.join(input_path, fname)
            img = cv2.imread(fpath, cv2.IMREAD_GRAYSCALE)
            if img is None:
                continue
            variance = cv2.Laplacian(img, cv2.CV_64F).var()
            scores.append((fname, variance))

        sharp = [(f, v) for f, v in scores if v >= self.threshold]

        # 최소 이미지 수 보장
        if len(sharp) < MIN_IMAGES:
            logger.warning(
                f"[{self.name}] sharp 이미지가 {len(sharp)}장뿐 — threshold를 낮춰 전체 사용."
            )
            sharp = scores

        removed = len(scores) - len(sharp)
        logger.info(f"[{self.name}] {len(scores)}장 중 {removed}장 제거, {len(sharp)}장 유지.")

        if removed == 0:
            return input_path

        output_dir = input_path.rstrip("/\\") + "_filtered"
        os.makedirs(output_dir, exist_ok=True)
        for fname, _ in sharp:
            shutil.copy2(os.path.join(input_path, fname), os.path.join(output_dir, fname))

        return output_dir
