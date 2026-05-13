import os
import subprocess
import logging

from pipeline.base import PipelineModule, PipelineError

logger = logging.getLogger(__name__)


# 로컬 gsplat 설치 (nerfstudio/gsplat) 호출 경로.
# 필요시 환경변수로 오버라이드 가능.
GSPLAT_PYTHON = os.environ.get(
    "GSPLAT_PYTHON",
    "/home/imlabdgx1/miniforge3/envs/gsplat/bin/python",
)
GSPLAT_TRAINER = os.environ.get(
    "GSPLAT_TRAINER",
    "/home/imlabdgx1/Development/gsplat/examples/simple_trainer.py",
)
# simple_trainer.py 가 examples/ 내부에서 `from datasets.colmap import ...` 처럼
# 상대 import 를 쓰므로 examples 디렉토리에서 실행해야 한다.
GSPLAT_CWD = os.path.dirname(GSPLAT_TRAINER)
GSPLAT_MAX_STEPS = int(os.environ.get("GSPLAT_MAX_STEPS", "7000"))


class GsplatModule(PipelineModule):
    """3D Gaussian Splatting 학습 모듈 (로컬 nerfstudio/gsplat 사용).

    입력: COLMAP workspace 디렉토리
        ├── sparse/0/{cameras,images,points3D}.bin
        └── images/

    출력: 학습된 PLY 파일 경로
    """

    def __init__(self, bounds: dict | None = None):
        # bounds 는 simple_trainer.py 가 직접 지원하지 않아 현재는 메타데이터로만 보관.
        self.bounds = bounds

    @property
    def name(self) -> str:
        return "GsplatTraining"

    def validate_input(self, input_path: str) -> bool:
        sparse0 = os.path.join(input_path, "sparse", "0")
        for fname in ["cameras.bin", "images.bin", "points3D.bin"]:
            if not os.path.isfile(os.path.join(sparse0, fname)):
                raise PipelineError(self.name, f"COLMAP 결과 파일 없음: {os.path.join(sparse0, fname)}")
        if not os.path.isdir(os.path.join(input_path, "images")):
            raise PipelineError(self.name, f"images/ 디렉토리 없음: {input_path}/images")
        return True

    def run(self, input_path: str) -> str:
        self.validate_input(input_path)

        result_dir = os.path.join(input_path, "gsplat_output")
        os.makedirs(result_dir, exist_ok=True)

        if self.bounds:
            logger.info(f"[{self.name}] bounds={self.bounds} (현재 trainer 가 지원하지 않아 무시됨)")

        logger.info(
            f"[{self.name}] 3DGS 학습 시작: data_dir={input_path}, result_dir={result_dir}, "
            f"max_steps={GSPLAT_MAX_STEPS}"
        )

        cmd = [
            GSPLAT_PYTHON, GSPLAT_TRAINER, "default",
            "--data_dir", input_path,
            "--result_dir", result_dir,
            "--data_factor", "1",
            "--max_steps", str(GSPLAT_MAX_STEPS),
            "--save_ply",
            "--disable_viewer",
        ]

        try:
            result = subprocess.run(
                cmd, check=True, capture_output=True, text=True, cwd=GSPLAT_CWD,
            )
            logger.info(f"[{self.name}] 학습 완료\n{result.stdout[-500:]}")
        except subprocess.CalledProcessError as e:
            tail = (e.stderr or e.stdout or "")[-1000:]
            raise PipelineError(self.name, f"3DGS 학습 실패:\n{tail}")
        except FileNotFoundError as e:
            raise PipelineError(self.name, f"gsplat 실행 파일을 찾을 수 없습니다: {e}")

        # nerfstudio/gsplat 의 simple_trainer 는 ply_steps 의 각 값에 대해
        # `point_cloud_{step-1}.ply` 를 ply/ 디렉토리에 저장한다.
        ply_dir = os.path.join(result_dir, "ply")
        ply_path = os.path.join(ply_dir, f"point_cloud_{GSPLAT_MAX_STEPS - 1}.ply")

        if not os.path.isfile(ply_path):
            # fallback: ply 디렉토리에서 가장 최신 ply 선택
            if os.path.isdir(ply_dir):
                candidates = sorted(
                    (os.path.join(ply_dir, f) for f in os.listdir(ply_dir) if f.endswith(".ply")),
                    key=os.path.getmtime,
                )
                if candidates:
                    ply_path = candidates[-1]
                    logger.warning(f"[{self.name}] 예상 PLY 없음, 최신 PLY 사용: {ply_path}")
                else:
                    raise PipelineError(self.name, f"학습 결과 PLY 파일이 없습니다: {ply_dir}")
            else:
                raise PipelineError(self.name, f"학습 결과 ply/ 디렉토리가 없습니다: {ply_dir}")

        size_mb = os.path.getsize(ply_path) / (1024 * 1024)
        logger.info(f"[{self.name}] PLY 생성 완료: {ply_path} ({size_mb:.1f}MB)")
        return ply_path
