import os
import shutil
import zipfile
import logging
import subprocess
import tempfile

from pipeline.base import PipelineModule, PipelineError

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff", ".tif"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}


class FFmpegModule(PipelineModule):
    """입력 파일 → images/ 디렉토리.

    - .zip : 압축 해제 후 이미지만 추출
    - 동영상: ffmpeg으로 fps마다 프레임 추출
    - 단일 이미지: images/ 에 복사 (테스트용)
    """

    def __init__(self, fps: int = 2):
        self.fps = fps

    @property
    def name(self) -> str:
        return "FFmpeg"

    def validate_input(self, input_path: str) -> bool:
        if not os.path.isfile(input_path):
            raise PipelineError(self.name, f"입력 파일이 존재하지 않습니다: {input_path}")
        ext = os.path.splitext(input_path)[1].lower()
        allowed = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | {".zip"}
        if ext not in allowed:
            raise PipelineError(self.name, f"지원하지 않는 파일 형식입니다: {ext}")
        return True

    def run(self, input_path: str) -> str:
        self.validate_input(input_path)
        ext = os.path.splitext(input_path)[1].lower()
        work_dir = os.path.join(tempfile.gettempdir(), f"ffmpeg_{os.getpid()}")
        output_dir = os.path.join(work_dir, "images")
        os.makedirs(output_dir, exist_ok=True)

        if ext == ".zip":
            self._extract_zip(input_path, output_dir)
        elif ext in VIDEO_EXTENSIONS:
            self._extract_video_frames(input_path, output_dir)
        else:
            shutil.copy2(input_path, os.path.join(output_dir, os.path.basename(input_path)))

        images = [f for f in os.listdir(output_dir)
                  if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS]
        if not images:
            raise PipelineError(self.name, "이미지를 추출하지 못했습니다. zip에 이미지가 없거나 동영상 변환에 실패했습니다.")

        logger.info(f"[{self.name}] {len(images)}장 이미지 준비 완료: {output_dir}")
        return output_dir

    def _extract_zip(self, zip_path: str, output_dir: str) -> None:
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                for member in zf.infolist():
                    ext = os.path.splitext(member.filename)[1].lower()
                    if ext not in IMAGE_EXTENSIONS:
                        continue
                    # 경로 조작 방지: basename만 사용
                    base = os.path.basename(member.filename)
                    if not base:
                        continue
                    target = os.path.join(output_dir, base)
                    with zf.open(member) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst)
        except zipfile.BadZipFile as e:
            raise PipelineError(self.name, f"유효하지 않은 zip 파일입니다: {e}")

    def _extract_video_frames(self, video_path: str, output_dir: str) -> None:
        pattern = os.path.join(output_dir, "%04d.jpg")
        cmd = [
            "ffmpeg", "-i", video_path,
            "-qscale:v", "1",
            "-qmin", "1",
            "-vf", f"fps={self.fps}",
            pattern,
            "-y",
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except FileNotFoundError:
            raise PipelineError(self.name, "ffmpeg이 설치되어 있지 않습니다.")
        except subprocess.CalledProcessError as e:
            raise PipelineError(self.name, f"ffmpeg 프레임 추출 실패: {e.stderr.decode()[:300]}")
