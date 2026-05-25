import os
import subprocess
import logging

from pipeline.base import PipelineModule, PipelineError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# SOG 변환기 (splat-transform 트리밍 빌드 호출)
#
# worker/splat-transform/ 에 PlayCanvas splat-transform 을 ply/compressed.ply/
# sog/splat/spz -> sog 변환 파이프라인만 남기고 트리밍해 두었다. 이 모듈은 그
# Node CLI(bin/cli.mjs)를 subprocess 로 호출해 입력과 동일한 폴더에 .sog 를
#생성한다. 기본 디바이스는 CPU 이므로 GPU 없이도 동작한다.
# ---------------------------------------------------------------------------

# 지원 입력 확장자 (소문자, 긴 것부터 검사)
SUPPORTED_EXTS = (".compressed.ply", ".ply", ".sog", ".splat", ".spz")

# 환경변수 오버라이드
NODE_BIN = os.environ.get("SPLAT_TO_SOG_NODE", "node")
SOG_CLI = os.environ.get(
    "SPLAT_TO_SOG_CLI",
    os.path.join(os.path.dirname(__file__), "..", "splat-transform", "bin", "cli.mjs"),
)
SOG_DEVICE = os.environ.get("SOG_DEVICE", "cpu")          # cpu | auto | <gpu index>
SOG_ITERATIONS = os.environ.get("SOG_ITERATIONS", "10")    # SH 압축 반복 횟수
SOG_TIMEOUT = int(os.environ.get("SOG_TIMEOUT", "1800"))   # 초


def _strip_known_ext(path: str) -> str:
    """입력 경로에서 인식된 확장자를 제거한 stem(디렉토리 포함)을 반환한다."""
    lower = path.lower()
    if lower.endswith(".compressed.ply"):
        return path[: -len(".compressed.ply")]
    for ext in (".ply", ".splat", ".spz", ".sog"):
        if lower.endswith(ext):
            return path[: -len(ext)]
    if lower.endswith("meta.json"):
        # 비번들 SOG (dir/meta.json) → 상위 디렉토리명 사용
        parent = os.path.dirname(path)
        return parent if parent else path[: -len("meta.json")].rstrip("._-")
    return path


def default_sog_output(input_path: str) -> str:
    """입력과 동일한 폴더에 생성될 .sog 출력 경로."""
    return _strip_known_ext(input_path) + ".sog"


def convert_to_sog(input_path: str, output_path: str | None = None,
                   device: str | None = None, iterations: str | None = None) -> str:
    """입력 splat 파일을 SOG 로 변환한다.

    Args:
        input_path:  ply / compressed.ply / sog / splat / spz 파일
        output_path: 출력 .sog 경로. None 이면 입력과 동일 폴더에 생성.
        device:      'cpu'(기본) | 'auto' | GPU 인덱스
        iterations:  SH 압축 반복 횟수 (기본 10)

    Returns:
        생성된 .sog 파일 경로

    Raises:
        PipelineError: 변환 실패 시
    """
    if not os.path.isfile(input_path):
        raise PipelineError("SOGConverter", f"입력 파일이 존재하지 않습니다: {input_path}")

    lower = input_path.lower()
    if not (lower.endswith(SUPPORTED_EXTS) or lower.endswith("meta.json")):
        raise PipelineError(
            "SOGConverter",
            f"지원하지 않는 입력 포맷입니다: {input_path} "
            f"(지원: ply, compressed.ply, sog, splat, spz)",
        )

    if output_path is None:
        output_path = default_sog_output(input_path)

    # 이미 SOG 이고 출력이 입력과 같으면 변환 불필요 (그대로 사용)
    if lower.endswith(".sog") and os.path.abspath(output_path) == os.path.abspath(input_path):
        logger.info(f"[SOGConverter] 이미 SOG 형식입니다. 그대로 사용: {input_path}")
        return input_path

    cli = os.path.abspath(SOG_CLI)
    if not os.path.isfile(cli):
        raise PipelineError(
            "SOGConverter",
            f"SOG 변환 CLI 를 찾을 수 없습니다: {cli}. "
            "worker/splat-transform 에서 `npm install && npm run build` 를 실행했는지 확인하세요.",
        )

    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)

    cmd = [
        NODE_BIN, cli,
        "-w",
        "-g", device or SOG_DEVICE,
        "-i", iterations or SOG_ITERATIONS,
        input_path,
        output_path,
    ]

    logger.info(f"[SOGConverter] SOG 변환 시작: {input_path} → {output_path}")
    logger.debug(f"[SOGConverter] cmd: {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd, check=True, capture_output=True, text=True, timeout=SOG_TIMEOUT,
        )
        if result.stderr:
            logger.debug(f"[SOGConverter] {result.stderr.strip()[-500:]}")
    except FileNotFoundError:
        raise PipelineError(
            "SOGConverter",
            f"Node 실행 파일을 찾을 수 없습니다: {NODE_BIN}. "
            "Node.js 가 설치되어 있는지 확인하세요.",
        )
    except subprocess.TimeoutExpired:
        raise PipelineError("SOGConverter", f"SOG 변환 시간 초과 ({SOG_TIMEOUT}s): {input_path}")
    except subprocess.CalledProcessError as e:
        tail = (e.stderr or e.stdout or "")[-1000:]
        raise PipelineError("SOGConverter", f"SOG 변환 실패:\n{tail}")

    if not os.path.isfile(output_path):
        raise PipelineError("SOGConverter", f"SOG 파일이 생성되지 않았습니다: {output_path}")

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    logger.info(f"[SOGConverter] SOG 변환 완료: {output_path} ({size_mb:.2f}MB)")
    return output_path


class SogConverterModule(PipelineModule):
    """splat → SOG 변환 모듈.

    입력: ply / compressed.ply / sog / splat / spz 파일 경로
    출력: 동일 폴더의 .sog 파일 경로
    """

    def __init__(self, device: str | None = None, iterations: str | None = None):
        self.device = device
        self.iterations = iterations

    @property
    def name(self) -> str:
        return "SOGConverter"

    def validate_input(self, input_path: str) -> bool:
        if not os.path.isfile(input_path):
            raise PipelineError(self.name, f"입력 파일이 존재하지 않습니다: {input_path}")

        lower = input_path.lower()
        if not (lower.endswith(SUPPORTED_EXTS) or lower.endswith("meta.json")):
            raise PipelineError(
                self.name,
                f"지원하지 않는 입력 포맷입니다: {input_path} "
                f"(지원: ply, compressed.ply, sog, splat, spz)",
            )
        return True

    def run(self, input_path: str) -> str:
        self.validate_input(input_path)
        return convert_to_sog(
            input_path,
            device=self.device,
            iterations=self.iterations,
        )
