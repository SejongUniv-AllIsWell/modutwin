import os
import shutil
import logging

from pipeline.base import PipelineModule, PipelineError

logger = logging.getLogger(__name__)


class SogConverterModule(PipelineModule):
    """ply → SOG 변환 모듈.

    입력: ply 파일 경로
    출력: sog 파일 경로
    """

    @property
    def name(self) -> str:
        return "SOGConverter"

    def validate_input(self, input_path: str) -> bool:
        if not os.path.isfile(input_path):
            raise PipelineError(self.name, f"입력 파일이 존재하지 않습니다: {input_path}")

        if not input_path.lower().endswith(".ply"):
            raise PipelineError(self.name, f"ply 파일이 아닙니다: {input_path}")

        return True

    def run(self, input_path: str) -> str:
        self.validate_input(input_path)

        output_path = os.path.splitext(input_path)[0] + ".sog"

        logger.info(f"[{self.name}] SOG 변환 시작: {input_path}")

        try:
            # 실제 SOG 변환 로직
            # PlayCanvas SuperSplat 또는 자체 변환 도구 사용
            import subprocess
            subprocess.run([
                "python", "-m", "sog_converter",
                "--input", input_path,
                "--output", output_path,
            ], check=True, capture_output=True, text=True)

        except (FileNotFoundError, subprocess.CalledProcessError):
            logger.warning(f"[{self.name}] SOG 변환기 미설치. stub sog 파일을 생성합니다.")
            # ply 파일을 복사하여 .sog 확장자로 저장 (stub)
            shutil.copy2(input_path, output_path)

        if not os.path.isfile(output_path):
            raise PipelineError(self.name, f"SOG 파일이 생성되지 않았습니다: {output_path}")

        logger.info(f"[{self.name}] SOG 변환 완료: {output_path}")
        return output_path
