"""Phase 11 — quality metrics (4-corner only).

plan v2 §Phase 11: D1에 따라 4 corner 한정 metric만 계산. coplanarity_error,
rectangle_error, OBB extents 등은 부재.

Auto-warnings:
  - mean_perp > robust_bbox_diagonal × 0.01
  - mean_reprojection > 5 px
  - height_width_ratio ∉ [1.5, 2.7]
  - condition_number_max > 1e6
"""

from __future__ import annotations

from typing import Iterable

import numpy as np

from ..corner_extraction.ordering import OrderedCornersCache, OrderedCornersView
from ..io.result_schema import (
    PerCornerInt,
    PerCornerScalar,
    QualityMetrics,
)
from ..render.camera_sampler import CameraView
from ..triangulation.ransac import TriangulationResult


CORNER_KEYS_TUPLE = ("left_top", "right_top", "left_bottom", "right_bottom")


def _project_world_to_pixel(point_world: np.ndarray, K: np.ndarray, c2w: np.ndarray) -> tuple[float, float] | None:
    """world point → pixel (u, v). 카메라 뒤(z<=0)면 None."""
    w2c = np.linalg.inv(c2w)
    p_cam = w2c[:3, :3] @ point_world + w2c[:3, 3]
    if p_cam[2] <= 1e-6:
        return None
    u = K[0, 0] * (p_cam[0] / p_cam[2]) + K[0, 2]
    v = K[1, 1] * (p_cam[1] / p_cam[2]) + K[1, 2]
    return float(u), float(v)


def _reprojection_errors(
    corners_3d: dict[str, np.ndarray],
    ordered_cache: OrderedCornersCache,
    cam_by_key: dict[tuple[str, int], CameraView],
) -> list[float]:
    """모든 (view × corner) 에 대한 픽셀 거리. 카메라 뒤로 떨어지는 corner는 skip."""
    errs: list[float] = []
    for ov in ordered_cache.views:
        cam = cam_by_key[(ov.source, ov.view_idx)]
        K = np.asarray(cam.K, dtype=np.float64)
        c2w = np.asarray(cam.c2w, dtype=np.float64)
        for ck in CORNER_KEYS_TUPLE:
            p3d = corners_3d[ck]
            proj = _project_world_to_pixel(p3d, K, c2w)
            if proj is None:
                continue
            u_pred, v_pred = proj
            u_obs, v_obs = getattr(ov, ck)
            errs.append(float(np.hypot(u_pred - u_obs, v_pred - v_obs)))
    return errs


def compute_quality(
    corners_3d: dict[str, tuple[float, float, float]],
    tri_results: dict[str, TriangulationResult],
    ordered_cache: OrderedCornersCache,
    cam_by_key: dict[tuple[str, int], CameraView],
    n_views_total: int,
    n_views_selected: int,
    robust_bbox_diagonal: float,
) -> tuple[QualityMetrics, list[str]]:
    """Returns (QualityMetrics, warnings)."""
    if set(corners_3d.keys()) != set(CORNER_KEYS_TUPLE):
        raise ValueError(
            f"corners_3d must have exactly {CORNER_KEYS_TUPLE}, got {sorted(corners_3d.keys())}"
        )

    metrics = QualityMetrics()
    metrics.num_views_total = int(n_views_total)
    metrics.num_views_selected = int(n_views_selected)

    inl_int = PerCornerInt()
    mean_pp = PerCornerScalar()
    max_pp = PerCornerScalar()
    cond_max = 0.0
    for ck in CORNER_KEYS_TUPLE:
        tri = tri_results[ck]
        setattr(inl_int, ck, int(tri.n_inliers))
        setattr(mean_pp, ck, float(tri.mean_perp_dist))
        setattr(max_pp, ck, float(tri.max_perp_dist))
        cond_max = max(cond_max, float(tri.condition_number))
    metrics.num_inlier_rays = inl_int
    metrics.mean_point_to_ray_distance = mean_pp
    metrics.max_point_to_ray_distance = max_pp
    metrics.condition_number_max = cond_max

    # reprojection error
    p_corners = {k: np.asarray(corners_3d[k], dtype=np.float64) for k in CORNER_KEYS_TUPLE}
    errs = _reprojection_errors(p_corners, ordered_cache, cam_by_key)
    metrics.mean_reprojection_error_px = float(np.mean(errs)) if errs else 0.0

    # raw 4점 기반 width/height
    LT = p_corners["left_top"]; RT = p_corners["right_top"]
    LB = p_corners["left_bottom"]; RB = p_corners["right_bottom"]
    width_top = float(np.linalg.norm(RT - LT))
    width_bot = float(np.linalg.norm(RB - LB))
    height_left = float(np.linalg.norm(LT - LB))
    height_right = float(np.linalg.norm(RT - RB))
    width = (width_top + width_bot) / 2.0
    height = (height_left + height_right) / 2.0
    metrics.estimated_width = width
    metrics.estimated_height = height
    metrics.height_width_ratio = float(height / width) if width > 1e-9 else 0.0

    # warnings
    warnings: list[str] = []
    perp_thr = robust_bbox_diagonal * 0.01
    for ck in CORNER_KEYS_TUPLE:
        if getattr(mean_pp, ck) > perp_thr:
            warnings.append(
                f"{ck}: mean_perp_dist {getattr(mean_pp, ck):.4f} > "
                f"{perp_thr:.4f} (robust_bbox_diagonal × 0.01)"
            )
    if metrics.mean_reprojection_error_px > 5.0:
        warnings.append(
            f"mean_reprojection_error_px {metrics.mean_reprojection_error_px:.2f} > 5.0"
        )
    if metrics.height_width_ratio < 1.5 or metrics.height_width_ratio > 2.7:
        warnings.append(
            f"height/width ratio {metrics.height_width_ratio:.3f} ∉ [1.5, 2.7] "
            "(typical door range)"
        )
    if metrics.condition_number_max > 1e6:
        warnings.append(
            f"condition_number_max {metrics.condition_number_max:.2e} > 1e6 — "
            "ray bundle ill-conditioned (rays nearly parallel)"
        )
    return metrics, warnings
