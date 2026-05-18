"""
로컬 COLMAP 실행 스크립트
사진 폴더 → colmap_result.json 생성

사용법:
    pip install pycolmap opencv-python
    python scripts/run_colmap.py ./사진폴더/
    python scripts/run_colmap.py ./사진폴더/ --output ./colmap_result.json
"""

import argparse
import json
import logging
import os
import shutil
import sys
import tempfile

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff", ".tif"}
MAX_POINTS = 200_000


def find_images(folder: str) -> list[str]:
    images = [
        f for f in os.listdir(folder)
        if os.path.splitext(f)[1].lower() in IMAGE_EXTS
    ]
    return sorted(images)


def filter_blurry(folder: str, threshold: float = 80.0, min_keep: int = 5) -> str:
    """흐린 사진 제거 후 filtered/ 폴더 반환. opencv 없으면 원본 폴더 반환."""
    try:
        import cv2
    except ImportError:
        log.warning("opencv 미설치 — blur 필터 건너뜀.")
        return folder

    images = find_images(folder)
    scores = []
    for fname in images:
        img = cv2.imread(os.path.join(folder, fname), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        v = cv2.Laplacian(img, cv2.CV_64F).var()
        scores.append((fname, v))

    sharp = [(f, v) for f, v in scores if v >= threshold]
    if len(sharp) < min_keep:
        log.warning(f"sharp 이미지 {len(sharp)}장뿐 — 전체 사용.")
        sharp = scores

    removed = len(scores) - len(sharp)
    log.info(f"Blur 필터: {len(scores)}장 중 {removed}장 제거, {len(sharp)}장 유지.")

    if removed == 0:
        return folder

    out = folder.rstrip("/\\") + "_filtered"
    os.makedirs(out, exist_ok=True)
    for fname, _ in sharp:
        shutil.copy2(os.path.join(folder, fname), os.path.join(out, fname))
    return out


def run_colmap(image_dir: str, work_dir: str):
    try:
        import pycolmap
    except ImportError:
        log.error("pycolmap 미설치. 설치 후 다시 실행하세요: pip install pycolmap")
        sys.exit(1)

    database_path = os.path.join(work_dir, "database.db")
    sparse_dir    = os.path.join(work_dir, "sparse")
    os.makedirs(sparse_dir, exist_ok=True)

    images = find_images(image_dir)
    log.info(f"이미지 {len(images)}장으로 COLMAP 실행 시작")

    if len(images) < 3:
        log.error(f"이미지가 {len(images)}장뿐입니다. 최소 3장 필요.")
        sys.exit(1)

    log.info("1/3 Feature extraction...")
    pycolmap.extract_features(database_path, image_dir)

    log.info("2/3 Feature matching...")
    pycolmap.match_exhaustive(database_path)

    log.info("3/3 Sparse reconstruction (Incremental mapping)...")
    maps = pycolmap.incremental_mapping(database_path, image_dir, sparse_dir)

    if not maps:
        log.error("Reconstruction 실패. 이미지 수가 부족하거나 특징점을 찾지 못했습니다.")
        sys.exit(1)

    best = max(maps.values(), key=lambda m: len(m.images))
    log.info(f"Reconstruction 완료: 카메라 {len(best.images)}개, 포인트 {len(best.points3D)}개")

    sparse0 = os.path.join(sparse_dir, "0")
    os.makedirs(sparse0, exist_ok=True)
    best.write(sparse0)

    return best


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


def export_json(reconstruction, output_path: str) -> None:
    import numpy as np

    # 포인트
    point_items = list(reconstruction.points3D.items())
    if len(point_items) > MAX_POINTS:
        step = len(point_items) // MAX_POINTS
        point_items = point_items[::step]

    points = []
    for _, pt in point_items:
        xyz = pt.xyz.tolist()
        rgb = [int(c) for c in pt.color[:3]]
        points.append(xyz + rgb)

    # 카메라
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

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, separators=(",", ":"))

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    log.info(f"저장 완료: {output_path}  ({len(points)}pt, {len(cameras)}cam, {size_mb:.1f}MB)")


def main():
    parser = argparse.ArgumentParser(description="사진 폴더 → colmap_result.json")
    parser.add_argument("image_folder", help="입력 사진 폴더 경로")
    parser.add_argument("--output", "-o", default="colmap_result.json", help="출력 JSON 파일 경로 (기본: colmap_result.json)")
    parser.add_argument("--no-blur-filter", action="store_true", help="blur 필터 건너뜀")
    parser.add_argument("--blur-threshold", type=float, default=80.0, help="blur 기준값 (기본: 80)")
    args = parser.parse_args()

    if not os.path.isdir(args.image_folder):
        log.error(f"폴더가 존재하지 않습니다: {args.image_folder}")
        sys.exit(1)

    images = find_images(args.image_folder)
    if not images:
        log.error("이미지 파일(.jpg/.png 등)이 없습니다.")
        sys.exit(1)

    log.info(f"입력 폴더: {args.image_folder}  ({len(images)}장)")

    # Blur 필터
    if args.no_blur_filter:
        image_dir = args.image_folder
    else:
        image_dir = filter_blurry(args.image_folder, threshold=args.blur_threshold)

    # COLMAP 실행
    work_dir = tempfile.mkdtemp(prefix="colmap_local_")
    log.info(f"작업 디렉토리: {work_dir}")

    try:
        reconstruction = run_colmap(image_dir, work_dir)
        export_json(reconstruction, args.output)
        log.info("완료!")
        log.info(f"뷰어에서 확인: http://localhost/colmap-viewer/demo  →  '{args.output}' 파일 불러오기")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
