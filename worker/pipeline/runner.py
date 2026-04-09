import logging
from typing import Callable, Optional

from pipeline.base import PipelineModule, PipelineError

logger = logging.getLogger(__name__)


class PipelineRunner:
    """모듈형 파이프라인 실행기.

    모듈 리스트를 순서대로 실행하며,
    각 모듈의 출력이 다음 모듈의 입력이 된다.
    """

    def __init__(self, modules: list[PipelineModule]):
        self.modules = modules

    def run(
        self,
        input_path: str,
        progress_callback: Optional[Callable[[int, str], None]] = None,
    ) -> str:
        """파이프라인 전체 실행.

        Args:
            input_path: 최초 입력 경로
            progress_callback: 진행률 콜백 함수 (progress_percent, module_name)

        Returns:
            최종 출력 경로

        Raises:
            PipelineError: 모듈 실패 시
        """
        current_path = input_path
        total = len(self.modules)

        logger.info(f"파이프라인 시작: {total}개 모듈, 입력={input_path}")

        for i, module in enumerate(self.modules):
            module_name = module.name
            logger.info(f"[{i + 1}/{total}] {module_name} 실행 중...")

            try:
                module.validate_input(current_path)
                current_path = module.run(current_path)
            except PipelineError:
                raise
            except Exception as e:
                raise PipelineError(module_name, str(e))

            progress = int((i + 1) / total * 100)
            logger.info(f"[{i + 1}/{total}] {module_name} 완료 ({progress}%)")

            if progress_callback:
                progress_callback(progress, module_name)

        logger.info(f"파이프라인 완료: 출력={current_path}")
        return current_path
