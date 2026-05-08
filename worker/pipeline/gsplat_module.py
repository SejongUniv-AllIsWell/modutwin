import os
import subprocess
import logging

from pipeline.base import PipelineModule, PipelineError

logger = logging.getLogger(__name__)


class GsplatModule(PipelineModule):
    """3D Gaussian Splatting 학습 모듈.

    입력: COLMAP workspace 디렉토리
        ├── sparse/0/{cameras,images,points3D}.bin
        └── images/

    출력: 학습된 PLY 파일 경로
    """

    def __init__(self, bounds: dict | None = None):
        """
        bounds: {minX, maxX, minY, maxY, minZ, maxZ} — 학습 범위 (없으면 전체)
        """
        self.bounds = bounds

    @property
    def name(self) -> str:
        return "GsplatTraining"

    def validate_input(self, input_path: str) -> bool:
        sparse0 = os.path.join(input_path, "sparse", "0")
        for fname in ["cameras.bin", "images.bin", "points3D.bin"]:
            if not os.path.isfile(os.path.join(sparse0, fname)):
                raise PipelineError(self.name, f"COLMAP 결과 파일 없음: {os.path.join(sparse0, fname)}")
        return True

    def run(self, input_path: str) -> str:
        self.validate_input(input_path)

        output_dir = os.path.join(input_path, "gsplat_output")
        os.makedirs(output_dir, exist_ok=True)

        logger.info(f"[{self.name}] 3DGS 학습 시작: {input_path}, bounds={self.bounds}")

        # TODO: 아래 경로를 Spark 가상환경에 맞게 수정
        venv_python = "python"               # 예: "/home/kyumin/gsplat/bin/python"
        train_script = "train.py"            # 예: "/home/kyumin/gaussian-splatting/train.py"

        cmd = [venv_python, train_script, "-s", input_path, "--model_path", output_dir]

        # bounding box 인자 추가 (TODO: 학습 도구의 실제 파라미터 이름으로 교체)
        if self.bounds:
            cmd += [
                "--bounding_box_min",
                str(self.bounds["minX"]), str(self.bounds["minY"]), str(self.bounds["minZ"]),
                "--bounding_box_max",
                str(self.bounds["maxX"]), str(self.bounds["maxY"]), str(self.bounds["maxZ"]),
            ]

        try:
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            logger.info(f"[{self.name}] 학습 완료\n{result.stdout[-500:]}")
        except subprocess.CalledProcessError as e:
            raise PipelineError(self.name, f"3DGS 학습 실패:\n{e.stderr[-500:]}")
        except FileNotFoundError:
            raise PipelineError(self.name, f"학습 스크립트를 찾을 수 없습니다: {train_script}")

        # TODO: 실제 출력 PLY 경로로 교체 (학습 도구마다 다름)
        # gaussian-splatting 기준: output_dir/point_cloud/iteration_30000/point_cloud.ply
        ply_path = os.path.join(output_dir, "point_cloud", "iteration_30000", "point_cloud.ply")

        if not os.path.isfile(ply_path):
            raise PipelineError(self.name, f"학습 결과 PLY 파일이 없습니다: {ply_path}")

        size_mb = os.path.getsize(ply_path) / (1024 * 1024)
        logger.info(f"[{self.name}] PLY 생성 완료: {ply_path} ({size_mb:.1f}MB)")
        return ply_path
