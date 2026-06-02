"""Phase 7 — robust quadrilateral extraction.

기존 구현은 largest contour에 대해 Douglas-Peucker 1경로만 시도했다.
문 mask가 jagged/fragmented 하거나 문틀 일부가 빠지면 4점이 안 나와 바로 실패했다.

개선점:
- morphology + largest component로 mask를 먼저 안정화
- contour와 convex hull 양쪽에서 approxPolyDP sweep
- 최후 fallback으로 minAreaRect 후보 생성
- 면적 비율만 보지 않고 polygon-mask IoU와 coverage까지 점수화
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


def _odd_kernel(size: int) -> int:
    size = max(3, int(size))
    return size if size % 2 == 1 else size + 1


def _largest_component(mask_u8: np.ndarray) -> np.ndarray:
    import cv2

    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    if n_labels <= 1:
        return mask_u8
    largest_idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return (labels == largest_idx).astype(np.uint8)


def _preprocess_mask(mask: np.ndarray) -> np.ndarray:
    import cv2

    mask_u8 = (mask > 0).astype(np.uint8)
    if mask_u8.sum() == 0:
        return mask_u8

    base = min(mask_u8.shape)
    k_close = _odd_kernel(min(13, max(3, round(base * 0.012))))
    k_open = _odd_kernel(min(7, max(3, round(base * 0.005))))

    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_close, k_close))
    open_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_open, k_open))

    cleaned = cv2.morphologyEx(mask_u8, cv2.MORPH_CLOSE, close_kernel)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, open_kernel)
    cleaned = _largest_component(cleaned)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, close_kernel)
    return _largest_component(cleaned)


def _normalize_quad(quad: np.ndarray) -> np.ndarray:
    return quad.reshape(4, 2).astype(np.float64)


def _quad_score(
    mask_u8: np.ndarray,
    quad: np.ndarray,
    area_min_ratio: float,
    area_max_ratio: float,
) -> Optional[float]:
    import cv2

    quad = _normalize_quad(quad)
    if not cv2.isContourConvex(quad.astype(np.float32).reshape(4, 1, 2)):
        return None
    if _quad_self_intersects(quad):
        return None

    mask_area = float(mask_u8.sum())
    if mask_area <= 0.0:
        return None

    quad_area = float(cv2.contourArea(quad.astype(np.float32)))
    if quad_area <= 1e-6:
        return None
    area_ratio = quad_area / mask_area
    if area_ratio < area_min_ratio or area_ratio > area_max_ratio:
        return None

    poly_mask = np.zeros_like(mask_u8, dtype=np.uint8)
    quad_i32 = np.round(quad).astype(np.int32)
    cv2.fillConvexPoly(poly_mask, quad_i32, 1)

    inter = float(np.logical_and(poly_mask > 0, mask_u8 > 0).sum())
    union = float(np.logical_or(poly_mask > 0, mask_u8 > 0).sum())
    if union <= 0.0:
        return None

    iou = inter / union
    coverage = inter / mask_area
    fill_ratio = mask_area / max(float(poly_mask.sum()), 1.0)

    if iou < 0.45 or coverage < 0.72 or fill_ratio < 0.55:
        return None

    return 0.55 * iou + 0.30 * coverage + 0.15 * min(fill_ratio, 1.0)


def _candidate_quads(
    contour,
    eps_min_ratio: float,
    eps_max_ratio: float,
    eps_steps: int,
) -> list[np.ndarray]:
    import cv2

    candidates: list[np.ndarray] = []
    perimeter = float(cv2.arcLength(contour, closed=True))
    if perimeter > 0.0:
        for er in np.linspace(eps_min_ratio, eps_max_ratio, eps_steps):
            approx = cv2.approxPolyDP(contour, float(er) * perimeter, closed=True)
            if approx.shape[0] == 4:
                candidates.append(_normalize_quad(approx))

    rect = cv2.minAreaRect(contour)
    box = cv2.boxPoints(rect)
    if box.shape == (4, 2):
        candidates.append(_normalize_quad(box))
    return candidates


def extract_quadrilateral(
    mask: np.ndarray,
    eps_min_ratio: float = 0.003,
    eps_max_ratio: float = 0.08,
    eps_steps: int = 28,
    area_min_ratio: float = 0.55,
    area_max_ratio: float = 1.6,
) -> Optional[np.ndarray]:
    """binary mask -> (4, 2) quadrilateral 픽셀 좌표. 실패 시 None.

    좌표 컨벤션: (x, y). x = column, y = row (OpenCV).
    """
    import cv2

    mask_u8 = _preprocess_mask(mask)
    if mask_u8.sum() == 0:
        return None

    contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    largest = max(contours, key=cv2.contourArea)
    hull = cv2.convexHull(largest)

    candidates: list[np.ndarray] = []
    candidates.extend(_candidate_quads(largest, eps_min_ratio, eps_max_ratio, eps_steps))
    candidates.extend(_candidate_quads(hull, eps_min_ratio, eps_max_ratio, eps_steps))

    if not candidates:
        return None

    best_quad: Optional[np.ndarray] = None
    best_score = -1.0
    seen: set[tuple[int, ...]] = set()
    for quad in candidates:
        key = tuple(int(v) for v in np.round(quad).reshape(-1))
        if key in seen:
            continue
        seen.add(key)

        score = _quad_score(
            mask_u8=mask_u8,
            quad=quad,
            area_min_ratio=area_min_ratio,
            area_max_ratio=area_max_ratio,
        )
        if score is None:
            continue
        if score > best_score:
            best_score = score
            best_quad = quad

    return best_quad
