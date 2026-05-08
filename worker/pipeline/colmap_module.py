import os
import json
import logging
import tempfile
import numpy as np

from pipeline.base import PipelineModule, PipelineError

logger = logging.getLogger(__name__)

# 포인트 수가 너무 많으면 뷰어 JSON이 커지므로 최대 개수 제한
MAX_POINTS = 200_000


class ColmapModule(PipelineModule):
    """COLMAP SfM 실행 모듈.

    입력: 이미지 디렉토리
    출력: colmap_workspace 디렉토리
        ├── sparse/0/{cameras,images,points3D}.bin
        ├── database.db
        └── colmap_result.json   ← 뷰어용 파싱 결과
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
            raise PipelineError(self.name, f"COLMAP에는 최소 3장 이상의 이미지가 필요합니다. (현재 {len(images)}장)")
        return True

    def run(self, input_path: str) -> str:
        self.validate_input(input_path)

        try:
            import pycolmap
        except ImportError:
            raise PipelineError(self.name, "pycolmap이 설치되어 있지 않습니다. requirements.txt를 확인하세요.")

        work_dir = os.path.join(tempfile.gettempdir(), f"colmap_{os.getpid()}")
        os.makedirs(work_dir, exist_ok=True)

        database_path = os.path.join(work_dir, "database.db")
        sparse_dir = os.path.join(work_dir, "sparse")
        os.makedirs(sparse_dir, exist_ok=True)

        logger.info(f"[{self.name}] Feature extraction 시작: {input_path}")
        try:
            pycolmap.extract_features(database_path, input_path)
        except Exception as e:
            raise PipelineError(self.name, f"Feature extraction 실패: {e}")

        logger.info(f"[{self.name}] Feature matching 시작")
        try:
            pycolmap.match_exhaustive(database_path)
        except Exception as e:
            raise PipelineError(self.name, f"Feature matching 실패: {e}")

        logger.info(f"[{self.name}] Incremental mapping 시작")
        try:
            maps = pycolmap.incremental_mapping(database_path, input_path, sparse_dir)
        except Exception as e:
            raise PipelineError(self.name, f"Sparse reconstruction 실패: {e}")

        if not maps:
            raise PipelineError(self.name, "Reconstruction 결과가 없습니다. 이미지 수가 부족하거나 특징점을 찾지 못했습니다.")

        # 가장 큰 reconstruction 선택
        best_map = max(maps.values(), key=lambda m: len(m.images))
        sparse0_dir = os.path.join(sparse_dir, "0")
        os.makedirs(sparse0_dir, exist_ok=True)
        best_map.write(sparse0_dir)

        logger.info(
            f"[{self.name}] Reconstruction 완료: "
            f"{len(best_map.images)} 카메라, {len(best_map.points3D)} 포인트"
        )

        result_json_path = os.path.join(work_dir, "colmap_result.json")
        self._export_result_json(best_map, result_json_path)

        return work_dir

    def _export_result_json(self, reconstruction, output_path: str) -> None:
        """Reconstruction 객체를 뷰어용 JSON으로 변환."""
        points = []
        point3d_items = list(reconstruction.points3D.items())

        # 너무 많으면 균등 샘플링
        if len(point3d_items) > MAX_POINTS:
            step = len(point3d_items) // MAX_POINTS
            point3d_items = point3d_items[::step]

        for _, pt in point3d_items:
            xyz = pt.xyz.tolist()
            color = [int(c) for c in pt.color[:3]]
            points.append(xyz + color)  # [x, y, z, r, g, b]

        cameras = []
        for _, image in reconstruction.images.items():
            cam = reconstruction.cameras[image.camera_id]

            R = image.cam_from_world.rotation.matrix()   # world-to-cam, 3x3
            t = image.cam_from_world.translation          # 3-vector in cam space
            # camera center in world: -R^T @ t
            position = (-R.T @ t).tolist()

            fx, fy, cx, cy = self._parse_intrinsics(cam)

            cameras.append({
                "name": image.name,
                "position": position,
                "R": R.tolist(),     # world-to-cam (viewer에서 역변환해 frustum 계산)
                "fx": fx,
                "fy": fy,
                "cx": cx,
                "cy": cy,
                "width": cam.width,
                "height": cam.height,
            })

        result = {
            "num_points": len(points),
            "num_cameras": len(cameras),
            "points": points,
            "cameras": cameras,
        }

        with open(output_path, "w") as f:
            json.dump(result, f, separators=(",", ":"))

        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        logger.info(f"[{self.name}] colmap_result.json 생성: {len(points)}pt, {len(cameras)}cam, {size_mb:.1f}MB")

    @staticmethod
    def _parse_intrinsics(camera) -> tuple[float, float, float, float]:
        """카메라 모델별 fx, fy, cx, cy 추출."""
        try:
            import pycolmap
            model = camera.model
            params = camera.params

            # pycolmap CameraModelId 비교
            model_name = str(model)

            if "SIMPLE_PINHOLE" in model_name:
                return params[0], params[0], params[1], params[2]
            elif "PINHOLE" in model_name:
                return params[0], params[1], params[2], params[3]
            elif "SIMPLE_RADIAL" in model_name:
                return params[0], params[0], params[1], params[2]
            elif "RADIAL" in model_name:
                return params[0], params[0], params[1], params[2]
            elif "OPENCV" in model_name:
                return params[0], params[1], params[2], params[3]
            else:
                # fallback: 첫 번째 파라미터를 focal length로 가정
                f = params[0]
                cx = camera.width / 2.0
                cy = camera.height / 2.0
                return f, f, cx, cy
        except Exception:
            f = max(camera.width, camera.height) * 1.2
            return f, f, camera.width / 2.0, camera.height / 2.0
