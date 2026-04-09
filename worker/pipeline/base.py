import os
import shutil
import logging
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


class PipelineModule(ABC):
    """파이프라인 모듈 베이스 클래스.

    모든 파이프라인 모듈은 이 클래스를 상속하며,
    run(input_path) → output_path 인터페이스를 따른다.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """모듈 이름 (로깅/진행률 표시용)"""
        pass

    @abstractmethod
    def run(self, input_path: str) -> str:
        """입력 경로를 받아 처리 후 출력 경로를 반환한다.

        Args:
            input_path: 입력 파일 또는 디렉토리 경로

        Returns:
            출력 파일 또는 디렉토리 경로

        Raises:
            PipelineError: 처리 실패 시
        """
        pass

    @abstractmethod
    def validate_input(self, input_path: str) -> bool:
        """입력 유효성 검증.

        Args:
            input_path: 검증할 경로

        Returns:
            유효하면 True

        Raises:
            PipelineError: 유효하지 않으면
        """
        pass

    def cleanup(self, path: str) -> None:
        """실패 시 임시 파일/디렉토리 정리."""
        if path and os.path.exists(path):
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path)
                else:
                    os.remove(path)
                logger.info(f"[{self.name}] 정리 완료: {path}")
            except Exception as e:
                logger.warning(f"[{self.name}] 정리 실패: {path} - {e}")


class PipelineError(Exception):
    """파이프라인 모듈 에러"""

    def __init__(self, module_name: str, message: str):
        self.module_name = module_name
        self.message = message
        super().__init__(f"[{module_name}] {message}")
