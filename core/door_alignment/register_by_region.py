"""Register two scenes using spatial region around estimated door position.

Instead of relying on grouping labels (which may be noisy), this script:
1. Uses camera poses to estimate door positions in each scene
2. Extracts all Gaussians within a radius of the estimated position
3. Runs RANSAC plane fitting on those Gaussians
4. Fits oriented rectangles and matches corners for rigid registration

Usage:
    python -m core.door_alignment.register_by_region \
        --ply_a results/basemap/ply/point_cloud_29999.ply \
        --colmap_a data/basemap/sparse/0 \
        --ply_b results/submodule/ply/point_cloud_29999.ply \
        --colmap_b data/submodule/sparse/0 \
        --output results/merged.ply
"""

import argparse
import json
import os
import sys

import numpy as np
import pycolmap

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from utilities.ply_io import load_ply

from .register_scenes import (
    fit_oriented_rectangle,
    match_corners_with_reflection,
    merge_and_export,
    ransac_plane_fit,
    save_debug_corners,
    transform_gaussians,
)


def get_camera_positions(colmap_path):
    """Get camera world positions and view directions from COLMAP reconstruction."""
    rec = pycolmap.Reconstruction(colmap_path)
    results = []
    for iid in sorted(rec.images.keys()):
        im = rec.images[iid]
        w2c = im.cam_from_world.matrix()[:3]
        R = w2c[:3, :3]
        t = w2c[:3, 3]
        cam_pos = -R.T @ t
        view_dir = R.T @ np.array([0, 0, 1])
        frame_num = int(im.name.split("_")[1].split(".")[0])
        results.append((frame_num, cam_pos, view_dir, im.name))
    return results


def estimate_door_position(cameras, frame_range, distance=2.0):
    """Estimate door position from camera frames."""
    positions = []
    viewdirs = []
    for frame_num, pos, vdir, name in cameras:
        if frame_range[0] <= frame_num <= frame_range[1]:
            positions.append(pos)
            viewdirs.append(vdir)
    if not positions:
        raise ValueError(f"No cameras in frame range {frame_range}")
    avg_pos = np.mean(positions, axis=0)
    avg_dir = np.mean(viewdirs, axis=0)
    avg_dir = avg_dir / np.linalg.norm(avg_dir)
    door_pos = avg_pos + avg_dir * distance
    return door_pos, avg_dir


def extract_region_gaussians(ply_path, center, radius):
    """Extract all Gaussians within radius of center point."""
    ply_data = load_ply(ply_path)
    means = ply_data["means"]
    dists = np.linalg.norm(means - center, axis=1)
    mask = dists < radius
    return means[mask], ply_data, mask


def main():
    parser = argparse.ArgumentParser(description="Register scenes by spatial region")
    parser.add_argument("--ply_a", required=True)
    parser.add_argument("--colmap_a", required=True,
                        help="COLMAP sparse/0 path for scene A")
    parser.add_argument("--door_frames_a", nargs=2, type=int, default=[20, 30],
                        help="Frame range where door is visible in scene A")
    parser.add_argument("--door_distance_a", type=float, default=2.0)
    parser.add_argument("--radius_a", type=float, default=3.0)

    parser.add_argument("--ply_b", required=True)
    parser.add_argument("--colmap_b", required=True,
                        help="COLMAP sparse/0 path for scene B")
    parser.add_argument("--door_frames_b", nargs=2, type=int, default=[1, 4],
                        help="Frame range where door is visible in scene B")
    parser.add_argument("--door_distance_b", type=float, default=2.0)
    parser.add_argument("--radius_b", type=float, default=3.0)

    parser.add_argument("--output", required=True)
    parser.add_argument("--save_transform", default=None)
    parser.add_argument("--save_debug_ply", default=None)
    parser.add_argument("--ransac_iters", type=int, default=5000)
    parser.add_argument("--inlier_threshold", type=float, default=0.05)
    args = parser.parse_args()

    # Scene A
    print("Scene A: Estimating door position...")
    cams_a = get_camera_positions(args.colmap_a)
    door_pos_a, door_dir_a = estimate_door_position(
        cams_a, args.door_frames_a, args.door_distance_a,
    )
    print(f"  Estimated door at: ({door_pos_a[0]:.2f}, {door_pos_a[1]:.2f}, {door_pos_a[2]:.2f})")

    print(f"  Extracting Gaussians within radius {args.radius_a}...")
    pts_a, ply_data_a, mask_a = extract_region_gaussians(
        args.ply_a, door_pos_a, args.radius_a,
    )
    opacities_a = ply_data_a["opacities"][mask_a]
    print(f"  Found {len(pts_a)} Gaussians near estimated door")

    # Scene B
    print("\nScene B: Estimating door position...")
    cams_b = get_camera_positions(args.colmap_b)
    door_pos_b, door_dir_b = estimate_door_position(
        cams_b, args.door_frames_b, args.door_distance_b,
    )
    print(f"  Estimated door at: ({door_pos_b[0]:.2f}, {door_pos_b[1]:.2f}, {door_pos_b[2]:.2f})")

    print(f"  Extracting Gaussians within radius {args.radius_b}...")
    pts_b, ply_data_b, mask_b = extract_region_gaussians(
        args.ply_b, door_pos_b, args.radius_b,
    )
    opacities_b = ply_data_b["opacities"][mask_b]
    print(f"  Found {len(pts_b)} Gaussians near estimated door")

    # RANSAC plane fitting
    print("\nRANSAC plane fitting (scene A)...")
    normal_a, point_a, inlier_mask_a = ransac_plane_fit(
        pts_a, opacities_a, n_iterations=args.ransac_iters,
        inlier_threshold=args.inlier_threshold,
    )
    print(f"  Normal: ({normal_a[0]:.3f}, {normal_a[1]:.3f}, {normal_a[2]:.3f}), "
          f"inliers: {inlier_mask_a.sum()}/{len(pts_a)}")

    print("RANSAC plane fitting (scene B)...")
    normal_b, point_b, inlier_mask_b = ransac_plane_fit(
        pts_b, opacities_b, n_iterations=args.ransac_iters,
        inlier_threshold=args.inlier_threshold,
    )
    print(f"  Normal: ({normal_b[0]:.3f}, {normal_b[1]:.3f}, {normal_b[2]:.3f}), "
          f"inliers: {inlier_mask_b.sum()}/{len(pts_b)}")

    # Oriented rectangle fitting
    print("\nFitting oriented rectangles...")
    inlier_pts_a = pts_a[inlier_mask_a]
    corners_a = fit_oriented_rectangle(inlier_pts_a, normal_a, point_a)

    inlier_pts_b = pts_b[inlier_mask_b]
    corners_b = fit_oriented_rectangle(inlier_pts_b, normal_b, point_b)

    # Corner matching
    print("Matching corners...")
    R, t, rms = match_corners_with_reflection(corners_a, corners_b)
    print(f"  RMS corner error: {rms:.6f}")

    # Transform and merge
    print("\nTransforming scene B...")
    ply_b_transformed = transform_gaussians(ply_data_b, R, t)

    print("Merging scenes...")
    merge_and_export(ply_data_a, ply_b_transformed, args.output)

    if args.save_transform:
        corners_b_transformed = (R @ corners_b.T).T + t
        meta = {
            "R": R.tolist(),
            "t": t.tolist(),
            "T_4x4": np.vstack([np.hstack([R, t.reshape(3, 1)]), [0, 0, 0, 1]]).tolist(),
            "rms_corner_error": float(rms),
            "door_pos_a": door_pos_a.tolist(),
            "door_pos_b": door_pos_b.tolist(),
            "plane_inliers_a": int(inlier_mask_a.sum()),
            "plane_inliers_b": int(inlier_mask_b.sum()),
        }
        with open(args.save_transform, "w") as f:
            json.dump(meta, f, indent=2)
        print(f"Transform saved to {args.save_transform}")

    if args.save_debug_ply:
        corners_b_transformed = (R @ corners_b.T).T + t
        save_debug_corners(corners_a, corners_b, corners_b_transformed, args.save_debug_ply)

    print("Done.")


if __name__ == "__main__":
    main()
