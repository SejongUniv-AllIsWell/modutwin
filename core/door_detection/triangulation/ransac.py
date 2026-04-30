"""Phase 10 — RANSAC robust triangulation per corner.

plan v2 §Phase 10:
  D6: threshold_abs = robust_bbox_diagonal * ransac_ratio (default 0.005).
  - 매 iter: ray 2개 sample → 두 ray의 closed-form 2-ray midpoint
    → 모든 ray의 perpendicular distance < threshold_abs인 것 inlier
  - 최대 inlier set으로 최종 closed-form LSQ refit
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .nearest_point import closed_form_lsq, perpendicular_distances


@dataclass
class TriangulationResult:
    point: tuple[float, float, float]
    inlier_view_idx: list[int]
    n_inliers: int
    mean_perp_dist: float
    max_perp_dist: float
    condition_number: float


def ransac_triangulate(
    origins: np.ndarray,
    directions: np.ndarray,
    view_idx: np.ndarray,
    threshold_abs: float,
    max_iters: int = 200,
    min_inliers: int = 3,
    rng_seed: int = 0,
) -> TriangulationResult:
    """RANSAC + LSQ triangulation for one corner_type's ray set.

    Args:
        origins: (M, 3).
        directions: (M, 3) unit.
        view_idx: (M,) view 인덱스.
        threshold_abs: perpendicular distance inlier 임계값 (D6).
        max_iters: RANSAC max iterations.
        min_inliers: 최종 inlier 수가 이 값보다 작으면 fail.
        rng_seed: 재현성.

    Raises:
        RuntimeError: best inlier set이 min_inliers 미만 (D10).
    """
    M = origins.shape[0]
    if M != directions.shape[0]:
        raise ValueError("origins/directions length mismatch")
    if M < 2:
        raise RuntimeError(f"need ≥ 2 rays, got {M}")

    rng = np.random.default_rng(rng_seed)
    best_inlier_mask: np.ndarray | None = None
    best_count = -1

    if M == 2:
        # iter 1번. 두 ray의 closed-form midpoint.
        p, _ = closed_form_lsq(origins, directions)
        d = perpendicular_distances(p, origins, directions)
        best_inlier_mask = d < threshold_abs
        best_count = int(best_inlier_mask.sum())
    else:
        for _ in range(max_iters):
            i, j = rng.choice(M, size=2, replace=False)
            try:
                p_hyp, _ = closed_form_lsq(
                    origins[[i, j]], directions[[i, j]]
                )
            except (np.linalg.LinAlgError, ValueError):
                continue
            d = perpendicular_distances(p_hyp, origins, directions)
            inlier_mask = d < threshold_abs
            count = int(inlier_mask.sum())
            if count > best_count:
                best_count = count
                best_inlier_mask = inlier_mask

    if best_inlier_mask is None or best_count < min_inliers:
        raise RuntimeError(
            f"Phase 10 RANSAC: only {best_count}/{min_inliers} inliers found "
            f"(threshold_abs={threshold_abs:.6f}). Bad rays / threshold too tight. (D10)"
        )

    # final refit on inliers
    inlier_origins = origins[best_inlier_mask]
    inlier_dirs = directions[best_inlier_mask]
    p_final, cond = closed_form_lsq(inlier_origins, inlier_dirs)

    perp = perpendicular_distances(p_final, inlier_origins, inlier_dirs)
    inlier_views = [int(view_idx[i]) for i in np.where(best_inlier_mask)[0]]

    return TriangulationResult(
        point=tuple(float(x) for x in p_final.tolist()),  # type: ignore[arg-type]
        inlier_view_idx=inlier_views,
        n_inliers=int(best_count),
        mean_perp_dist=float(perp.mean()),
        max_perp_dist=float(perp.max()),
        condition_number=cond,
    )
