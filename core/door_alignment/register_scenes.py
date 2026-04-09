"""Door-based 3DGS scene registration and merge pipeline.

Registers two Gaussian Splatting scenes (e.g. room interior and corridor) that
share a common door.  Each scene must have been trained with Gaussian Grouping
so that a door label exists.  The pipeline fits a plane + oriented rectangle to
each door, matches the four corners (handling the normal-flip from opposite-side
capture), computes a rigid transform via SVD Procrustes, and merges both scenes
into a single PLY.

Usage:
    python -m core.door_alignment.register_scenes \
        --ply_a results/corridor/ply/point_cloud_29999.ply \
        --grouping_a results/corridor/ply/grouping_29999.npz \
        --door_labels_a 5 12 \
        --ply_b results/room/ply/point_cloud_29999.ply \
        --grouping_b results/room/ply/grouping_29999.npz \
        --door_labels_b 8 \
        --output results/merged.ply
"""

import argparse
import json
import os
import sys

import numpy as np
import torch
from scipy.spatial import ConvexHull
from scipy.spatial.transform import Rotation

from gsplat import export_splats

# Add project root to path for utilities import
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from utilities.ply_io import load_ply


# ---------------------------------------------------------------------------
# 1. Load door Gaussians
# ---------------------------------------------------------------------------

def load_door_gaussians(
    ply_path: str,
    grouping_path: str,
    target_labels: list[int],
    min_gaussians: int = 50,
) -> tuple[dict, np.ndarray]:
    """Load a PLY and return (full_ply_data, door_mask).

    ``door_mask`` is a boolean array over all Gaussians that selects only
    those belonging to *target_labels*.
    """
    grouping = np.load(grouping_path)
    labels = grouping["labels"]
    mask = np.isin(labels, target_labels)
    n_door = int(mask.sum())
    if n_door < min_gaussians:
        raise ValueError(
            f"Only {n_door} door Gaussians found (need >= {min_gaussians}). "
            f"Labels requested: {target_labels}"
        )
    ply_data = load_ply(ply_path)
    print(
        f"  Loaded {len(labels)} Gaussians, {n_door} belong to door "
        f"(labels {target_labels})"
    )
    return ply_data, mask


# ---------------------------------------------------------------------------
# 2. RANSAC plane fit
# ---------------------------------------------------------------------------

def ransac_plane_fit(
    points: np.ndarray,
    opacities: np.ndarray,
    n_iterations: int = 2000,
    inlier_threshold: float = 0.02,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Fit a plane to *points* using RANSAC with opacity weighting.

    Returns (normal, point_on_plane, inlier_mask).
    """
    N = len(points)
    best_inlier_score = -1.0
    best_inlier_mask = np.zeros(N, dtype=bool)

    weights = 1.0 / (1.0 + np.exp(-opacities))  # sigmoid

    rng = np.random.default_rng(42)
    for _ in range(n_iterations):
        idx = rng.choice(N, size=3, replace=False)
        p0, p1, p2 = points[idx]
        normal = np.cross(p1 - p0, p2 - p0)
        norm = np.linalg.norm(normal)
        if norm < 1e-12:
            continue
        normal /= norm
        d = np.abs((points - p0) @ normal)
        inlier_mask = d < inlier_threshold
        score = weights[inlier_mask].sum()
        if score > best_inlier_score:
            best_inlier_score = score
            best_inlier_mask = inlier_mask

    # Weighted least-squares refit on best inliers
    inlier_pts = points[best_inlier_mask]
    inlier_w = weights[best_inlier_mask]
    centroid = np.average(inlier_pts, axis=0, weights=inlier_w)
    diff = inlier_pts - centroid
    cov = (diff * inlier_w[:, None]).T @ diff
    eigvals, eigvecs = np.linalg.eigh(cov)
    normal = eigvecs[:, 0]  # smallest eigenvalue

    return normal, centroid, best_inlier_mask


# ---------------------------------------------------------------------------
# 3. Fit oriented rectangle (minimum-area OBB on the plane)
# ---------------------------------------------------------------------------

def _rotating_calipers_min_area(hull_pts_2d: np.ndarray) -> np.ndarray:
    """Return the 4 corners (CCW) of the minimum-area OBB around a 2-D convex hull."""
    hull = ConvexHull(hull_pts_2d)
    verts = hull_pts_2d[hull.vertices]
    edges = np.diff(np.vstack([verts, verts[0:1]]), axis=0)
    edge_angles = np.arctan2(edges[:, 1], edges[:, 0])
    edge_angles = np.unique(edge_angles % (np.pi / 2))

    min_area = np.inf
    best_corners = None
    for angle in edge_angles:
        c, s = np.cos(angle), np.sin(angle)
        R = np.array([[c, s], [-s, c]])
        rotated = verts @ R.T
        min_xy = rotated.min(axis=0)
        max_xy = rotated.max(axis=0)
        area = (max_xy[0] - min_xy[0]) * (max_xy[1] - min_xy[1])
        if area < min_area:
            min_area = area
            corners_rot = np.array([
                [min_xy[0], min_xy[1]],
                [max_xy[0], min_xy[1]],
                [max_xy[0], max_xy[1]],
                [min_xy[0], max_xy[1]],
            ])
            best_corners = corners_rot @ R

    return best_corners


def fit_oriented_rectangle(
    points: np.ndarray,
    normal: np.ndarray,
    point_on_plane: np.ndarray,
) -> np.ndarray:
    """Project *points* onto the plane and return 4 OBB corners in 3-D (CCW).

    Falls back to a PCA-aligned bounding box when ConvexHull fails.
    """
    hint = np.array([0.0, 0.0, 1.0])
    if abs(np.dot(normal, hint)) > 0.9:
        hint = np.array([0.0, 1.0, 0.0])
    u = np.cross(normal, hint)
    u /= np.linalg.norm(u)
    v = np.cross(normal, u)
    v /= np.linalg.norm(v)

    diff = points - point_on_plane
    coords_2d = np.column_stack([diff @ u, diff @ v])

    try:
        corners_2d = _rotating_calipers_min_area(coords_2d)
    except Exception:
        cov2 = np.cov(coords_2d, rowvar=False)
        eigvals, eigvecs = np.linalg.eigh(cov2)
        proj = coords_2d @ eigvecs
        lo, hi = proj.min(axis=0), proj.max(axis=0)
        box = np.array([
            [lo[0], lo[1]],
            [hi[0], lo[1]],
            [hi[0], hi[1]],
            [lo[0], hi[1]],
        ])
        corners_2d = box @ eigvecs.T

    corners_3d = (
        point_on_plane
        + corners_2d[:, 0:1] * u
        + corners_2d[:, 1:2] * v
    )
    return corners_3d.astype(np.float64)


# ---------------------------------------------------------------------------
# 4. Procrustes rigid transform (SVD)
# ---------------------------------------------------------------------------

def procrustes_rigid(
    source: np.ndarray,
    target: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Compute rigid (R, t) that maps *source* to *target* via SVD.

    target ~ (R @ source.T).T + t
    """
    src_c = source.mean(axis=0)
    tgt_c = target.mean(axis=0)
    src_centered = source - src_c
    tgt_centered = target - tgt_c
    H = src_centered.T @ tgt_centered
    U, _S, Vt = np.linalg.svd(H)
    R = Vt.T @ U.T
    if np.linalg.det(R) < 0:
        Vt[-1, :] *= -1
        R = Vt.T @ U.T
    t = tgt_c - R @ src_c
    return R, t


# ---------------------------------------------------------------------------
# 5. Corner matching with reflection handling
# ---------------------------------------------------------------------------

def match_corners_with_reflection(
    corners_a: np.ndarray,
    corners_b: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Try 8 corner orderings (4 rotations x 2 flips) and return best (R, t, rms)."""
    best_rms = np.inf
    best_R, best_t = None, None

    for flip in [False, True]:
        cb = corners_b if not flip else corners_b[::-1].copy()
        for rot in range(4):
            cb_rot = np.roll(cb, rot, axis=0)
            R, t = procrustes_rigid(cb_rot, corners_a)
            residual = (R @ cb_rot.T).T + t - corners_a
            rms = np.sqrt((residual ** 2).sum() / len(corners_a))
            if rms < best_rms:
                best_rms = rms
                best_R, best_t = R, t

    return best_R, best_t, best_rms


# ---------------------------------------------------------------------------
# 6. Transform all Gaussians in scene B
# ---------------------------------------------------------------------------

def transform_gaussians(
    ply_data: dict,
    R: np.ndarray,
    t: np.ndarray,
    drop_sh_higher: bool = True,
) -> dict:
    """Apply rigid transform (R, t) to all Gaussian parameters.

    * means: rotated + translated
    * quats: composed with rotation (wxyz convention)
    * scales, opacities, sh0: unchanged
    * shN: zeroed when *drop_sh_higher* (default) to avoid incorrect SH rotation
    """
    out = {}

    means = ply_data["means"].astype(np.float64)
    out["means"] = ((R @ means.T).T + t).astype(np.float32)

    quats_wxyz = ply_data["quats"]  # [N, 4] w, x, y, z
    quats_xyzw = quats_wxyz[:, [1, 2, 3, 0]]  # scipy expects xyzw
    rot_gaussians = Rotation.from_quat(quats_xyzw)
    rot_transform = Rotation.from_matrix(R)
    composed = rot_transform * rot_gaussians
    composed_xyzw = composed.as_quat()  # [N, 4] xyzw
    out["quats"] = composed_xyzw[:, [3, 0, 1, 2]].astype(np.float32)  # back to wxyz

    out["scales"] = ply_data["scales"].copy()
    out["opacities"] = ply_data["opacities"].copy()
    out["sh0"] = ply_data["sh0"].copy()

    if drop_sh_higher:
        N = ply_data["shN"].shape[0]
        K = ply_data["shN"].shape[1]
        out["shN"] = np.zeros((N, K, 3), dtype=np.float32)
    else:
        out["shN"] = ply_data["shN"].copy()

    return out


# ---------------------------------------------------------------------------
# 7. Merge and export
# ---------------------------------------------------------------------------

def merge_and_export(
    ply_a: dict,
    ply_b: dict,
    output_path: str,
) -> None:
    """Concatenate two scenes and export as PLY via ``export_splats``."""
    Ka = ply_a["shN"].shape[1]
    Kb = ply_b["shN"].shape[1]
    if Ka < Kb:
        pad = np.zeros((ply_a["shN"].shape[0], Kb - Ka, 3), dtype=np.float32)
        ply_a["shN"] = np.concatenate([ply_a["shN"], pad], axis=1)
    elif Kb < Ka:
        pad = np.zeros((ply_b["shN"].shape[0], Ka - Kb, 3), dtype=np.float32)
        ply_b["shN"] = np.concatenate([ply_b["shN"], pad], axis=1)

    def _cat(key):
        return torch.from_numpy(np.concatenate([ply_a[key], ply_b[key]], axis=0))

    export_splats(
        means=_cat("means"),
        scales=_cat("scales"),
        quats=_cat("quats"),
        opacities=_cat("opacities"),
        sh0=_cat("sh0"),
        shN=_cat("shN"),
        format="ply",
        save_to=output_path,
    )
    total = len(ply_a["means"]) + len(ply_b["means"])
    print(f"Exported {total} Gaussians to {output_path}")


# ---------------------------------------------------------------------------
# 8. Debug corner visualisation
# ---------------------------------------------------------------------------

def save_debug_corners(
    corners_a: np.ndarray,
    corners_b_original: np.ndarray,
    corners_b_transformed: np.ndarray,
    output_path: str,
) -> None:
    """Write 12 tiny Gaussians as a PLY for visual sanity-checking.

    Red = scene A corners, Blue = scene B (original), Green = scene B (transformed).
    """
    C0 = 0.28209479177387814
    all_pts = np.concatenate([corners_a, corners_b_original, corners_b_transformed])
    N = len(all_pts)

    means = torch.from_numpy(all_pts.astype(np.float32))
    scales = torch.full((N, 3), fill_value=-6.0)
    quats = torch.tensor([[1.0, 0.0, 0.0, 0.0]]).expand(N, -1).clone()
    opacities = torch.full((N,), fill_value=5.0)

    colors = np.zeros((N, 3), dtype=np.float32)
    colors[:4] = [1.0, 0.0, 0.0]   # red = A
    colors[4:8] = [0.0, 0.0, 1.0]  # blue = B original
    colors[8:] = [0.0, 1.0, 0.0]   # green = B transformed
    sh0_vals = (colors - 0.5) / C0
    sh0 = torch.from_numpy(sh0_vals[:, None, :])
    shN = torch.zeros(N, 0, 3)

    export_splats(
        means=means, scales=scales, quats=quats, opacities=opacities,
        sh0=sh0, shN=shN, format="ply", save_to=output_path,
    )
    print(f"Debug corners saved to {output_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Register two 3DGS scenes via a shared door and merge into one PLY"
    )
    parser.add_argument("--ply_a", required=True, help="PLY for scene A")
    parser.add_argument("--grouping_a", required=True, help="Grouping NPZ for scene A")
    parser.add_argument(
        "--door_labels_a", type=int, nargs="+", required=True,
        help="Door label IDs in scene A",
    )
    parser.add_argument("--ply_b", required=True, help="PLY for scene B")
    parser.add_argument("--grouping_b", required=True, help="Grouping NPZ for scene B")
    parser.add_argument(
        "--door_labels_b", type=int, nargs="+", required=True,
        help="Door label IDs in scene B",
    )
    parser.add_argument("--output", required=True, help="Output merged PLY path")
    parser.add_argument("--save_transform", default=None,
                        help="Optional path to save R, t, 4x4 matrix as JSON")
    parser.add_argument("--save_debug_ply", default=None,
                        help="Optional path to save debug corner PLY")
    parser.add_argument("--ransac_iterations", type=int, default=2000)
    parser.add_argument("--inlier_threshold", type=float, default=0.02)
    parser.add_argument("--keep_sh", action="store_true",
                        help="Keep higher-order SH coefficients")
    args = parser.parse_args()

    print("Loading scene A ...")
    ply_a, mask_a = load_door_gaussians(args.ply_a, args.grouping_a, args.door_labels_a)
    print("Loading scene B ...")
    ply_b, mask_b = load_door_gaussians(args.ply_b, args.grouping_b, args.door_labels_b)

    door_pts_a = ply_a["means"][mask_a]
    door_opa_a = ply_a["opacities"][mask_a]
    door_pts_b = ply_b["means"][mask_b]
    door_opa_b = ply_b["opacities"][mask_b]

    print("Fitting plane to door A ...")
    normal_a, center_a, inlier_a = ransac_plane_fit(
        door_pts_a, door_opa_a, args.ransac_iterations, args.inlier_threshold,
    )
    print(f"  Normal A: {normal_a},  inliers: {inlier_a.sum()}/{len(door_pts_a)}")

    print("Fitting plane to door B ...")
    normal_b, center_b, inlier_b = ransac_plane_fit(
        door_pts_b, door_opa_b, args.ransac_iterations, args.inlier_threshold,
    )
    print(f"  Normal B: {normal_b},  inliers: {inlier_b.sum()}/{len(door_pts_b)}")

    print("Fitting oriented rectangles ...")
    corners_a = fit_oriented_rectangle(door_pts_a[inlier_a], normal_a, center_a)
    corners_b = fit_oriented_rectangle(door_pts_b[inlier_b], normal_b, center_b)

    print("Matching corners (8 candidates) ...")
    R, t, rms = match_corners_with_reflection(corners_a, corners_b)
    print(f"  Best RMS corner error: {rms:.6f}")

    print("Transforming scene B ...")
    ply_b_transformed = transform_gaussians(ply_b, R, t, drop_sh_higher=not args.keep_sh)

    print("Merging scenes ...")
    merge_and_export(ply_a, ply_b_transformed, args.output)

    if args.save_transform:
        T = np.eye(4)
        T[:3, :3] = R
        T[:3, 3] = t
        info = {
            "R": R.tolist(),
            "t": t.tolist(),
            "T_4x4": T.tolist(),
            "rms_corner_error": float(rms),
            "door_gaussians_a": int(mask_a.sum()),
            "door_gaussians_b": int(mask_b.sum()),
            "plane_inliers_a": int(inlier_a.sum()),
            "plane_inliers_b": int(inlier_b.sum()),
        }
        with open(args.save_transform, "w") as f:
            json.dump(info, f, indent=2)
        print(f"Transform saved to {args.save_transform}")

    if args.save_debug_ply:
        corners_b_xformed = (R @ corners_b.T).T + t
        save_debug_corners(corners_a, corners_b, corners_b_xformed, args.save_debug_ply)

    print("Done.")


if __name__ == "__main__":
    main()
