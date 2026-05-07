"""Phase 6 — post-SAM3 view quality filter.

plan v2 §Phase 6 통과 조건 (모두 만족):
  1. SAM3 prob ≥ 0.8 (Phase 3·5 출력 단계에서 이미 통과)
  2. mask area ratio ∈ [0.02, 0.6]
  3. boundary touch 없음 (가장자리 8px 이내 미접촉)
  4. mask compactness ≥ 0.6 (= area / convex_hull_area)
  5. 단일 connected component (2nd가 1st의 30% 이상이면 reject)
  6. baseline diversity (greedy): room_center 기준 카메라 위치 각도 < 5° → score 낮은 쪽 drop
미달 view < min_selected → fail-fast (D10).
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass

import numpy as np

from ..render.camera_sampler import CameraView


@dataclass
class SelectedView:
    source: str  # "coarse" | "fine"
    view_idx: int
    score: float
    mask_path: str
    mask_area_ratio: float


@dataclass
class RejectedView:
    source: str
    view_idx: int
    reason: str


@dataclass
class ViewSelection:
    selected: list[SelectedView]
    rejected: list[RejectedView]
    n_selected: int
    n_rejected: int

    def save(self, cache_dir: str) -> str:
        os.makedirs(cache_dir, exist_ok=True)
        path = os.path.join(cache_dir, "selected_views.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(asdict(self), f, indent=2)
        return path

    @classmethod
    def load(cls, cache_dir: str) -> "ViewSelection":
        path = os.path.join(cache_dir, "selected_views.json")
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        return cls(
            selected=[SelectedView(**s) for s in d["selected"]],
            rejected=[RejectedView(**r) for r in d["rejected"]],
            n_selected=d["n_selected"],
            n_rejected=d["n_rejected"],
        )


def _load_binary_mask(path: str) -> np.ndarray:
    from PIL import Image

    arr = np.asarray(Image.open(path).convert("L"))
    return arr > 127


def _check_boundary_touch(mask: np.ndarray, margin: int) -> bool:
    if margin <= 0:
        return False
    if mask[:margin, :].any() or mask[-margin:, :].any():
        return True
    if mask[:, :margin].any() or mask[:, -margin:].any():
        return True
    return False


def _connected_components_largest_two(mask: np.ndarray) -> tuple[int, int]:
    import cv2

    mask_u8 = mask.astype(np.uint8)
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    if n <= 1:
        return 0, 0
    areas = stats[1:, cv2.CC_STAT_AREA]
    areas_sorted = np.sort(areas)[::-1]
    a1 = int(areas_sorted[0])
    a2 = int(areas_sorted[1]) if len(areas_sorted) > 1 else 0
    return a1, a2


def _compactness(mask: np.ndarray) -> float:
    """area / convex_hull_area. area는 픽셀 sum (hole 반영). hull은 largest contour 기준."""
    import cv2

    area = float(mask.sum())
    if area <= 0:
        return 0.0
    mask_u8 = mask.astype(np.uint8)
    contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0.0
    largest = max(contours, key=cv2.contourArea)
    hull = cv2.convexHull(largest)
    hull_area = float(cv2.contourArea(hull))
    if hull_area <= 0:
        return 0.0
    return area / hull_area


def _greedy_baseline_filter(
    selected: list[SelectedView],
    cam_by_key: dict[tuple[str, int], CameraView],
    room_center: np.ndarray,
    min_angle_deg: float,
) -> tuple[list[SelectedView], list[RejectedView]]:
    if not selected:
        return [], []
    sorted_sel = sorted(selected, key=lambda s: s.score, reverse=True)
    kept: list[SelectedView] = []
    kept_dirs: list[np.ndarray] = []
    dropped: list[RejectedView] = []
    cos_threshold = float(np.cos(np.deg2rad(min_angle_deg)))

    for s in sorted_sel:
        cam = cam_by_key[(s.source, s.view_idx)]
        v = np.asarray(cam.position, dtype=np.float64) - room_center
        n = float(np.linalg.norm(v))
        if n < 1e-9:
            dropped.append(
                RejectedView(s.source, s.view_idx, "camera at room_center (degenerate)")
            )
            continue
        d = v / n
        too_close = any(float(np.dot(d, kd)) > cos_threshold for kd in kept_dirs)
        if too_close:
            dropped.append(
                RejectedView(
                    s.source,
                    s.view_idx,
                    f"baseline diversity (< {min_angle_deg}° from existing)",
                )
            )
            continue
        kept.append(s)
        kept_dirs.append(d)
    return kept, dropped


def filter_views(
    coarse_summary: dict,
    coarse_cameras: list[CameraView],
    fine_summary: dict,
    fine_cameras: list[CameraView],
    room_center: np.ndarray,
    cache_dir: str | None = None,
    mask_area_min: float = 0.02,
    mask_area_max: float = 0.6,
    boundary_margin_px: int = 8,
    compactness_min: float = 0.6,
    second_component_max_ratio: float = 0.3,
    min_baseline_angle_deg: float = 5.0,
    min_selected: int = 4,
) -> ViewSelection:
    """Phase 6 main entry. coarse + fine을 합쳐 품질 필터링."""
    cam_by_key: dict[tuple[str, int], CameraView] = {}
    for c in coarse_cameras:
        cam_by_key[("coarse", c.view_idx)] = c
    for c in fine_cameras:
        cam_by_key[("fine", c.view_idx)] = c

    selected: list[SelectedView] = []
    rejected: list[RejectedView] = []

    def _process(summary: dict, source: str) -> None:
        for v in summary.get("views", []):
            mask_path = v.get("mask_path")
            view_idx = int(v["view_idx"])
            if not mask_path:
                rejected.append(
                    RejectedView(source, view_idx, "no mask (sub-threshold or empty)")
                )
                continue
            if (source, view_idx) not in cam_by_key:
                rejected.append(RejectedView(source, view_idx, "no matching camera"))
                continue
            cam = cam_by_key[(source, view_idx)]
            mask = _load_binary_mask(mask_path)
            if mask.shape != (cam.h, cam.w):
                rejected.append(
                    RejectedView(
                        source,
                        view_idx,
                        f"mask shape {mask.shape} != cam ({cam.h}, {cam.w})",
                    )
                )
                continue
            area = int(mask.sum())
            ratio = area / float(cam.w * cam.h)
            if ratio < mask_area_min or ratio > mask_area_max:
                rejected.append(
                    RejectedView(source, view_idx, f"mask area ratio {ratio:.4f} out of range")
                )
                continue
            if _check_boundary_touch(mask, boundary_margin_px):
                rejected.append(RejectedView(source, view_idx, "mask touches image boundary"))
                continue
            comp = _compactness(mask)
            if comp < compactness_min:
                rejected.append(
                    RejectedView(source, view_idx, f"compactness {comp:.3f} < {compactness_min}")
                )
                continue
            a1, a2 = _connected_components_largest_two(mask)
            if a1 > 0 and a2 / a1 > second_component_max_ratio:
                rejected.append(
                    RejectedView(
                        source,
                        view_idx,
                        f"2nd component ratio {a2/a1:.3f} > {second_component_max_ratio}",
                    )
                )
                continue
            score = float(v.get("max_score") or 0.0)
            selected.append(
                SelectedView(
                    source=source,
                    view_idx=view_idx,
                    score=score,
                    mask_path=mask_path,
                    mask_area_ratio=ratio,
                )
            )

    _process(coarse_summary, "coarse")
    _process(fine_summary, "fine")

    selected, dropped_baseline = _greedy_baseline_filter(
        selected,
        cam_by_key,
        np.asarray(room_center, dtype=np.float64),
        min_baseline_angle_deg,
    )
    rejected.extend(dropped_baseline)

    result = ViewSelection(
        selected=selected,
        rejected=rejected,
        n_selected=len(selected),
        n_rejected=len(rejected),
    )
    if cache_dir:
        result.save(cache_dir)

    if result.n_selected < min_selected:
        raise RuntimeError(
            f"Phase 6: only {result.n_selected}/{min_selected} views passed quality filter. "
            f"PLY/render/SAM3 quality 점검. (D10 fail-fast)"
        )
    return result
