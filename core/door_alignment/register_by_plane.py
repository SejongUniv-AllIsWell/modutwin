"""Register two scenes by aligning door planes + gravity direction.

Strategy:
1. Find the door plane in each scene using RANSAC
2. Align scene B's plane normal to face opposite of scene A's
   (since they view the door from opposite sides)
3. Use gravity (y-axis) alignment to resolve rotational ambiguity
4. Translate to bring the planes together

Usage:
    python -m core.door_alignment.register_by_plane \
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
from scipy.spatial.transform import Rotation

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from utilities.ply_io import load_ply

from .register_scenes import (
    merge_and_export,
    ransac_plane_fit,
    save_debug_corners,
    transform_gaussians,
)


def get_camera_positions(colmap_path):
    """Get camera world positions, view directions, and up vectors."""
    rec = pycolmap.Reconstruction(colmap_path)
    results = []
    for iid in sorted(rec.images.keys()):
        im = rec.images[iid]
        w2c = im.cam_from_world.matrix()[:3]
        R = w2c[:3, :3]
        t = w2c[:3, 3]
        cam_pos = -R.T @ t
        view_dir = R.T @ np.array([0, 0, 1])
        up_dir = -R.T @ np.array([0, 1, 0])
        frame_num = int(im.name.split("_")[1].split(".")[0])
        results.append((frame_num, cam_pos, view_dir, up_dir, im.name))
    return results


def estimate_door_and_up(cameras, frame_range, distance=2.0):
    """Estimate door position and up direction from camera frames."""
    positions, viewdirs, updirs = [], [], []
    for frame_num, pos, vdir, udir, name in cameras:
        if frame_range[0] <= frame_num <= frame_range[1]:
            positions.append(pos)
            viewdirs.append(vdir)
            updirs.append(udir)
    avg_pos = np.mean(positions, axis=0)
    avg_dir = np.mean(viewdirs, axis=0)
    avg_dir /= np.linalg.norm(avg_dir)
    avg_up = np.mean(updirs, axis=0)
    avg_up /= np.linalg.norm(avg_up)
    door_pos = avg_pos + avg_dir * distance
    return door_pos, avg_dir, avg_up


def align_planes_with_gravity(normal_a, point_a, up_a, normal_b, point_b, up_b):
    """Compute rigid transform that aligns plane B to face opposite of plane A,
    with consistent gravity direction.

    The door is viewed from opposite sides, so normal_b should face -normal_a.
    """
    n_a = normal_a / np.linalg.norm(normal_a)
    up_a_proj = up_a - np.dot(up_a, n_a) * n_a
    up_a_proj /= np.linalg.norm(up_a_proj)
    right_a = np.cross(up_a_proj, n_a)
    right_a /= np.linalg.norm(right_a)
    up_a_proj = np.cross(n_a, right_a)
    R_a = np.column_stack([n_a, up_a_proj, right_a])

    n_b = normal_b / np.linalg.norm(normal_b)
    up_b_proj = up_b - np.dot(up_b, n_b) * n_b
    up_b_proj /= np.linalg.norm(up_b_proj)
    right_b = np.cross(up_b_proj, n_b)
    right_b /= np.linalg.norm(right_b)
    up_b_proj = np.cross(n_b, right_b)
    R_b = np.column_stack([n_b, up_b_proj, right_b])

    R_target = np.column_stack([-n_a, up_a_proj, -right_a])
    R = R_target @ R_b.T

    if np.linalg.det(R) < 0:
        R_target_alt = np.column_stack([-n_a, -up_a_proj, right_a])
        R = R_target_alt @ R_b.T

    t = point_a - R @ point_b
    return R, t


def load_door_gaussians_by_labels(ply_path, grouping_path, labels):
    """Load door Gaussians selected by grouping labels."""
    ply_data = load_ply(ply_path)
    grp = np.load(grouping_path)
    lbl = grp["labels"]
    mask = np.isin(lbl, labels)
    return ply_data["means"][mask], ply_data["opacities"][mask], ply_data


def main():
    parser = argparse.ArgumentParser(description="Register scenes by plane alignment")
    parser.add_argument("--ply_a", required=True)
    parser.add_argument("--colmap_a", required=True)
    parser.add_argument("--grouping_a", default=None)
    parser.add_argument("--door_labels_a", nargs="*", type=int, default=None)
    parser.add_argument("--door_frames_a", nargs=2, type=int, default=[20, 27])
    parser.add_argument("--door_distance_a", type=float, default=1.5)
    parser.add_argument("--radius_a", type=float, default=2.0)

    parser.add_argument("--ply_b", required=True)
    parser.add_argument("--colmap_b", required=True)
    parser.add_argument("--grouping_b", default=None)
    parser.add_argument("--door_labels_b", nargs="*", type=int, default=None)
    parser.add_argument("--door_frames_b", nargs=2, type=int, default=[1, 4])
    parser.add_argument("--door_distance_b", type=float, default=2.0)
    parser.add_argument("--radius_b", type=float, default=4.0)

    parser.add_argument("--output", required=True)
    parser.add_argument("--save_transform", default=None)
    parser.add_argument("--ransac_iters", type=int, default=5000)
    parser.add_argument("--inlier_threshold", type=float, default=0.03)
    args = parser.parse_args()

    cams_a = get_camera_positions(args.colmap_a)
    door_pos_a, view_dir_a, up_a = estimate_door_and_up(
        cams_a, args.door_frames_a, args.door_distance_a,
    )
    print(f"Scene A door estimate: ({door_pos_a[0]:.2f}, {door_pos_a[1]:.2f}, {door_pos_a[2]:.2f})")

    cams_b = get_camera_positions(args.colmap_b)
    door_pos_b, view_dir_b, up_b = estimate_door_and_up(
        cams_b, args.door_frames_b, args.door_distance_b,
    )
    print(f"Scene B door estimate: ({door_pos_b[0]:.2f}, {door_pos_b[1]:.2f}, {door_pos_b[2]:.2f})")

    if args.door_labels_a and args.grouping_a:
        pts_a, opa_a, ply_data_a = load_door_gaussians_by_labels(
            args.ply_a, args.grouping_a, args.door_labels_a,
        )
        print(f"Scene A: {len(pts_a)} Gaussians from labels {args.door_labels_a}")
    else:
        ply_data_a = load_ply(args.ply_a)
        dists = np.linalg.norm(ply_data_a["means"] - door_pos_a, axis=1)
        mask = dists < args.radius_a
        pts_a = ply_data_a["means"][mask]
        opa_a = ply_data_a["opacities"][mask]
        print(f"Scene A: {len(pts_a)} Gaussians within {args.radius_a} of door estimate")

    if args.door_labels_b and args.grouping_b:
        pts_b, opa_b, ply_data_b = load_door_gaussians_by_labels(
            args.ply_b, args.grouping_b, args.door_labels_b,
        )
        print(f"Scene B: {len(pts_b)} Gaussians from labels {args.door_labels_b}")
    else:
        ply_data_b = load_ply(args.ply_b)
        dists = np.linalg.norm(ply_data_b["means"] - door_pos_b, axis=1)
        mask = dists < args.radius_b
        pts_b = ply_data_b["means"][mask]
        opa_b = ply_data_b["opacities"][mask]
        print(f"Scene B: {len(pts_b)} Gaussians within {args.radius_b} of door estimate")

    print("\nRANSAC plane fitting...")
    normal_a, point_a, inliers_a = ransac_plane_fit(
        pts_a, opa_a, args.ransac_iters, args.inlier_threshold,
    )
    if np.dot(normal_a, view_dir_a) < 0:
        normal_a = -normal_a
    print(f"  Plane A: normal=({normal_a[0]:.3f}, {normal_a[1]:.3f}, {normal_a[2]:.3f}), "
          f"inliers={inliers_a.sum()}/{len(pts_a)}")

    normal_b, point_b, inliers_b = ransac_plane_fit(
        pts_b, opa_b, args.ransac_iters, args.inlier_threshold,
    )
    if np.dot(normal_b, view_dir_b) < 0:
        normal_b = -normal_b
    print(f"  Plane B: normal=({normal_b[0]:.3f}, {normal_b[1]:.3f}, {normal_b[2]:.3f}), "
          f"inliers={inliers_b.sum()}/{len(pts_b)}")

    print("\nComputing plane-based alignment...")
    R, t = align_planes_with_gravity(normal_a, point_a, up_a, normal_b, point_b, up_b)

    normal_b_transformed = R @ normal_b
    dot = np.dot(normal_a, -normal_b_transformed)
    print(f"  Normal alignment dot (should be ~1): {dot:.6f}")

    point_b_transformed = R @ point_b + t
    dist = abs(np.dot(point_b_transformed - point_a, normal_a))
    print(f"  Plane distance after alignment: {dist:.6f}")

    print("\nTransforming scene B...")
    ply_b_transformed = transform_gaussians(ply_data_b, R, t)

    print("Merging scenes...")
    merge_and_export(ply_data_a, ply_b_transformed, args.output)

    if args.save_transform:
        meta = {
            "R": R.tolist(),
            "t": t.tolist(),
            "T_4x4": np.vstack([np.hstack([R, t.reshape(3, 1)]), [0, 0, 0, 1]]).tolist(),
            "normal_a": normal_a.tolist(),
            "normal_b": normal_b.tolist(),
            "normal_alignment_dot": float(dot),
            "plane_distance_after": float(dist),
        }
        with open(args.save_transform, "w") as f:
            json.dump(meta, f, indent=2)
        print(f"Transform saved to {args.save_transform}")

    print("Done.")


if __name__ == "__main__":
    main()
