"""Phase 9 — pixel -> world ray.

NOTE (plan v2 dependency memo): Phase 4 (door_direction)와 Phase 8 (ordering)이
이 모듈을 먼저 사용한다. 따라서 Phase 4 구현 시점에 핵심 함수
``pixel_to_world_ray``를 채우고, Phase 9의 stack 처리 + npz IO는 별도 함수로
나중에 추가한다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np


@dataclass
class Ray:
    """Single world-space ray (origin + unit direction).

    OpenCV camera convention 가정 (x→right, y→down, z→forward).
    """

    origin: np.ndarray  # (3,) world frame
    direction: np.ndarray  # (3,) world frame, unit length
    view_idx: int = -1
    corner_type: str = ""  # "left_top" | "right_top" | "left_bottom" | "right_bottom" | ""


def pixel_rotate_cw_to_orig(
    u_rot: float, v_rot: float, img_size: int = 1024
) -> tuple[float, float]:
    """90° CW 저장 이미지의 픽셀 → 원본(렌더 프레임) 픽셀 역변환.

    splat_renderer.py가 np.rot90(k=-1) 즉 90° CW로 저장하므로:
      저장 이미지: u_rot = H-1-v_orig, v_rot = u_orig
      역변환:     u_orig = v_rot,      v_orig = H-1-u_rot
    """
    u_orig = float(v_rot)
    v_orig = float(img_size - 1 - u_rot)
    return u_orig, v_orig


def pixel_to_world_ray(
    u: float,
    v: float,
    K,
    c2w,
) -> Ray:
    """OpenCV pixel (u, v) → world-space ray.

    Args:
        u, v: pixel coords (x→right, y→down).
        K: 3x3 intrinsic.
        c2w: 4x4 cam-to-world (OpenCV convention).

    Returns:
        Ray(origin=camera position, direction=unit vector world frame).
    """
    K = np.asarray(K, dtype=np.float64)
    c2w = np.asarray(c2w, dtype=np.float64)
    if K.shape != (3, 3):
        raise ValueError(f"K must be 3x3, got {K.shape}")
    if c2w.shape != (4, 4):
        raise ValueError(f"c2w must be 4x4, got {c2w.shape}")

    fx, fy = K[0, 0], K[1, 1]
    cx, cy = K[0, 2], K[1, 2]
    if fx <= 0 or fy <= 0:
        raise ValueError(f"K has non-positive focal length: fx={fx}, fy={fy}")

    # Normalized camera-frame direction (OpenCV: +z forward).
    d_cam = np.array(
        [(float(u) - cx) / fx, (float(v) - cy) / fy, 1.0],
        dtype=np.float64,
    )
    d_cam /= np.linalg.norm(d_cam)

    R = c2w[:3, :3]
    d_world = R @ d_cam
    d_world /= np.linalg.norm(d_world)

    origin = c2w[:3, 3].copy()
    return Ray(origin=origin, direction=d_world)


def stack_rays_by_corner(
    rays: Sequence[Ray],
) -> dict[str, dict[str, np.ndarray]]:
    """Phase 9 caching helper. corner_type별로 origin/direction을 stack.

    Returns:
        {
            "left_top":     {"origins": (M,3), "directions": (M,3), "view_idx": (M,)},
            ...
        }
    """
    by_type: dict[str, list[Ray]] = {}
    for r in rays:
        by_type.setdefault(r.corner_type, []).append(r)

    out: dict[str, dict[str, np.ndarray]] = {}
    for k, lst in by_type.items():
        if not lst:
            continue
        out[k] = {
            "origins": np.stack([r.origin for r in lst], axis=0),
            "directions": np.stack([r.direction for r in lst], axis=0),
            "view_idx": np.array([r.view_idx for r in lst], dtype=np.int64),
        }
    return out


def save_rays_npz(by_corner: dict[str, dict[str, np.ndarray]], cache_dir: str) -> str:
    """plan v2 §2 cache: rays.npz."""
    import os

    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, "rays.npz")
    flat: dict[str, np.ndarray] = {}
    for corner, d in by_corner.items():
        flat[f"{corner}_origins"] = d["origins"]
        flat[f"{corner}_directions"] = d["directions"]
        flat[f"{corner}_view_idx"] = d["view_idx"]
    np.savez(path, **flat)
    return path


def load_rays_npz(cache_dir: str) -> dict[str, dict[str, np.ndarray]]:
    import os

    path = os.path.join(cache_dir, "rays.npz")
    data = np.load(path)
    by_corner: dict[str, dict[str, np.ndarray]] = {}
    for key in data.files:
        if key.endswith("_origins"):
            corner = key[: -len("_origins")]
            by_corner[corner] = {
                "origins": data[f"{corner}_origins"],
                "directions": data[f"{corner}_directions"],
                "view_idx": data[f"{corner}_view_idx"],
            }
    return by_corner
