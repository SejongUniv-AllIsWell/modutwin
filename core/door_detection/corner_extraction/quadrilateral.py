"""Phase 7 — Douglas-Peucker 단일 경로 quadrilateral extraction.

plan v2 §Phase 7 (D11: fallback 금지):
  1. cv2.findContours → 가장 큰 외곽선
  2. cv2.approxPolyDP epsilon sweep ε ∈ [0.005, 0.05] × perimeter, 4-vertex 첫 ε 채택
  3. validation:
     - convex (cv2.isContourConvex)
     - self-intersection 없음
     - 면적이 mask area의 [0.7, 1.3]
  4. 셋 중 하나라도 실패 → return None (= view drop)
"""

from __future__ import annotations

from typing import Optional

import numpy as np


def _segments_intersect_strict(p1, p2, p3, p4) -> bool:
    """선분 p1-p2와 p3-p4가 진성 교차 (끝점 공유 제외)."""

    def _ccw(a, b, c) -> float:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    d1 = _ccw(p3, p4, p1)
    d2 = _ccw(p3, p4, p2)
    d3 = _ccw(p1, p2, p3)
    d4 = _ccw(p1, p2, p4)
    if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and (
        (d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)
    ):
        return True
    return False


def _quad_self_intersects(quad: np.ndarray) -> bool:
    """4-vertex polygon (4,2): non-adjacent edge 쌍의 교차 검사."""
    p = [tuple(map(float, quad[i])) for i in range(4)]
    pairs = [((0, 1), (2, 3)), ((1, 2), (3, 0))]
    for (i, j), (k, l) in pairs:
        if _segments_intersect_strict(p[i], p[j], p[k], p[l]):
            return True
    return False


def extract_quadrilateral(
    mask: np.ndarray,
    eps_min_ratio: float = 0.005,
    eps_max_ratio: float = 0.05,
    eps_steps: int = 18,
    area_min_ratio: float = 0.7,
    area_max_ratio: float = 1.3,
) -> Optional[np.ndarray]:
    """binary mask → (4, 2) quadrilateral 픽셀 좌표 (cv2 contour 순서). 실패 시 None.

    좌표 컨벤션: (x, y). x = column, y = row (OpenCV).
    """
    import cv2

    mask_b = mask > 0 if mask.dtype != bool else mask
    mask_u8 = mask_b.astype(np.uint8)
    if mask_u8.sum() == 0:
        return None

    contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    largest = max(contours, key=cv2.contourArea)
    perimeter = float(cv2.arcLength(largest, closed=True))
    if perimeter <= 0:
        return None
    mask_area = float(mask_b.sum())
    if mask_area <= 0:
        return None

    quad: Optional[np.ndarray] = None
    eps_ratios = np.linspace(eps_min_ratio, eps_max_ratio, eps_steps)
    for er in eps_ratios:
        approx = cv2.approxPolyDP(largest, float(er) * perimeter, closed=True)
        if approx.shape[0] == 4:
            quad = approx.reshape(4, 2).astype(np.float64)
            break

    if quad is None:
        return None

    if not cv2.isContourConvex(quad.astype(np.float32).reshape(4, 1, 2)):
        return None
    if _quad_self_intersects(quad):
        return None

    quad_area = float(cv2.contourArea(quad.astype(np.float32)))
    if quad_area <= 0:
        return None
    ratio = quad_area / mask_area
    if ratio < area_min_ratio or ratio > area_max_ratio:
        return None

    return quad
