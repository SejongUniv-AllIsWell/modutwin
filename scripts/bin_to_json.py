"""
COLMAP .bin 파일 → colmap_result.json 변환 스크립트

COLMAP GUI 또는 CLI로 이미 reconstruction이 완료된 경우 사용.

사용법:
    pip install pycolmap
    python scripts/bin_to_json.py ./sparse/0/
    python scripts/bin_to_json.py ./sparse/0/ --output ./colmap_result.json

입력 폴더에는 다음 파일이 있어야 합니다:
    cameras.bin
    images.bin
    points3D.bin
"""

import argparse
import json
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

MAX_POINTS = 200_000


def parse_intrinsics(camera) -> tuple[float, float, float, float]:
    params = camera.params
    model_name = str(camera.model)
    if "SIMPLE_PINHOLE" in model_name:
        return params[0], params[0], params[1], params[2]
    elif "PINHOLE" in model_name:
        return params[0], params[1], params[2], params[3]
    elif "SIMPLE_RADIAL" in model_name or "RADIAL" in model_name:
        return params[0], params[0], params[1], params[2]
    elif "OPENCV" in model_name:
        return params[0], params[1], params[2], params[3]
    else:
        f = params[0]
        return f, f, camera.width / 2.0, camera.height / 2.0


def main():
    parser = argparse.ArgumentParser(description="COLMAP .bin → colmap_result.json")
    parser.add_argument("sparse_dir", help="sparse/0/ 폴더 경로 (cameras.bin, images.bin, points3D.bin 있는 곳)")
    parser.add_argument("--output", "-o", default="colmap_result.json", help="출력 JSON 경로 (기본: colmap_result.json)")
    args = parser.parse_args()

    # 필수 파일 확인
    required = ["cameras.bin", "images.bin", "points3D.bin"]
    for fname in required:
        fpath = os.path.join(args.sparse_dir, fname)
        if not os.path.isfile(fpath):
            log.error(f"파일 없음: {fpath}")
            log.error(f"필요한 파일: {required}")
            sys.exit(1)

    try:
        import pycolmap
    except ImportError:
        log.error("pycolmap 미설치. 설치 후 다시 실행하세요: pip install pycolmap")
        sys.exit(1)

    log.info(f"읽는 중: {args.sparse_dir}")
    reconstruction = pycolmap.Reconstruction(args.sparse_dir)
    log.info(f"로드 완료: 카메라 {len(reconstruction.images)}개, 포인트 {len(reconstruction.points3D)}개")

    # 포인트 변환
    point_items = list(reconstruction.points3D.items())
    total = len(point_items)
    if total > MAX_POINTS:
        step = total // MAX_POINTS
        point_items = point_items[::step]
        log.info(f"포인트 샘플링: {total}개 → {len(point_items)}개")

    points = []
    for _, pt in point_items:
        xyz = pt.xyz.tolist()
        rgb = [int(c) for c in pt.color[:3]]
        points.append(xyz + rgb)

    # 카메라 변환
    cameras = []
    for _, image in reconstruction.images.items():
        cam = reconstruction.cameras[image.camera_id]
        pose = image.cam_from_world
        if callable(pose):
            pose = pose()
        R   = pose.rotation.matrix()
        t   = pose.translation
        pos = (-R.T @ t).tolist()
        fx, fy, cx, cy = parse_intrinsics(cam)
        cameras.append({
            "name":     image.name,
            "position": pos,
            "R":        R.tolist(),
            "fx": fx, "fy": fy,
            "cx": cx, "cy": cy,
            "width":  cam.width,
            "height": cam.height,
        })

    result = {
        "num_points":  len(points),
        "num_cameras": len(cameras),
        "points":      points,
        "cameras":     cameras,
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, separators=(",", ":"))

    size_mb = os.path.getsize(args.output) / (1024 * 1024)
    log.info(f"저장 완료: {args.output}  ({len(points)}pt, {len(cameras)}cam, {size_mb:.1f}MB)")
    log.info(f"뷰어: http://localhost/colmap-viewer/demo  →  '{args.output}' 파일 불러오기")


if __name__ == "__main__":
    main()
