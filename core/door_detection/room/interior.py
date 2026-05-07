"""Phase 1 — Room interior estimation.

plan v2 §Phase 1:
  1. PLY load → opacity ≥ 0.1 (sigmoid 후) 만 남겨 1차 floater 제거
  2. 각 축 5–95 percentile clip → robust bbox
  3. center = bbox 기하 중심, min_half_extent = min((max-min)/2),
     robust_bbox_diagonal = ||max - min||
  4. 26-ray interior validation:
     - 26 cube/edge/corner 방향 ray
     - 점-ray 수직거리 < diag × 0.01 인 점이 거리 < diag × 0.5 안에 있으면 hit
     - hits ≥ 22 → interior_ok=True. 미달 시 fail-fast (D10).
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass

import numpy as np

from utilities.ply_io import load_ply


def estimate_floor_y(
    means: np.ndarray,
    bbox_min_y: float,
    bbox_max_y: float,
    n_bins: int = 40,
) -> float:
    """Gaussian 밀도 히스토그램으로 바닥(floor) Y 추정.

    바닥은 Y 범위 하위 65% 안에서 가우시안이 가장 밀집된 수평 레이어.
    floater가 bbox_min 아래로 연장돼 있어도 실제 바닥을 찾을 수 있도록
    검색 범위를 전체 Y range의 65%까지 열어둔다.
    """
    y_vals = means[:, 1]
    hist, edges = np.histogram(y_vals, bins=n_bins,
                               range=(float(bbox_min_y), float(bbox_max_y)))
    bin_centers = (edges[:-1] + edges[1:]) / 2.0

    # 하위 65% 범위 안에서 가장 밀집된 bin → 바닥 레이어
    y_search_max = float(bbox_min_y) + 0.65 * (float(bbox_max_y) - float(bbox_min_y))
    search_mask = bin_centers <= y_search_max
    if search_mask.any():
        h_search = hist.copy()
        h_search[~search_mask] = 0
        floor_bin = int(np.argmax(h_search))
    else:
        floor_bin = int(np.argmax(hist))

    return float(bin_centers[floor_bin])


def estimate_eye_height_y(
    means: np.ndarray,
    bbox_min_y: float,
    bbox_max_y: float,
    eye_height_m: float = 1.5,
) -> float:
    """바닥 Y + eye_height_m 로 눈높이 Y 반환. 방 범위 안으로 clamp."""
    floor_y = estimate_floor_y(means, bbox_min_y, bbox_max_y)
    eye_y = float(floor_y + eye_height_m)
    # 천장에 너무 가깝지 않게
    eye_y = min(eye_y, float(bbox_max_y) - 0.3)
    eye_y = max(eye_y, float(bbox_min_y) + 0.3)
    return eye_y


@dataclass
class RoomInfo:
    """plan v2 §2의 room.json schema와 1:1 대응."""

    robust_bbox_min: tuple[float, float, float]
    robust_bbox_max: tuple[float, float, float]
    robust_bbox_diagonal: float
    room_center: tuple[float, float, float]
    interior_ok: bool
    interior_hits_26: int
    min_half_extent: float

    def save(self, cache_dir: str) -> str:
        os.makedirs(cache_dir, exist_ok=True)
        path = os.path.join(cache_dir, "room.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(asdict(self), f, indent=2)
        return path

    @classmethod
    def load(cls, cache_dir: str) -> "RoomInfo":
        path = os.path.join(cache_dir, "room.json")
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        d["robust_bbox_min"] = tuple(d["robust_bbox_min"])
        d["robust_bbox_max"] = tuple(d["robust_bbox_max"])
        d["room_center"] = tuple(d["room_center"])
        return cls(**d)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _generate_26_directions() -> np.ndarray:
    """6 cube faces + 12 edges + 8 corners = 26 unit directions."""
    dirs: list[list[float]] = []
    for x in (-1, 0, 1):
        for y in (-1, 0, 1):
            for z in (-1, 0, 1):
                if x == 0 and y == 0 and z == 0:
                    continue
                dirs.append([float(x), float(y), float(z)])
    arr = np.asarray(dirs, dtype=np.float64)
    arr /= np.linalg.norm(arr, axis=1, keepdims=True)
    assert arr.shape == (26, 3)
    return arr


def _count_26_ray_hits(
    center: np.ndarray,
    points: np.ndarray,
    bbox_diagonal: float,
    perp_threshold_ratio: float,
    max_distance_ratio: float,
) -> int:
    """center에서 26방향으로 ray 발사 → 각 ray가 perp_threshold 안에 점 1개라도
    가지면 hit. forward (dot > 0)인 점만 후보.
    """
    if len(points) == 0 or bbox_diagonal <= 0:
        return 0

    perp_threshold = bbox_diagonal * perp_threshold_ratio
    max_distance = bbox_diagonal * max_distance_ratio

    rel = points - center  # (N, 3)
    rel_dist = np.linalg.norm(rel, axis=1)
    in_range = rel_dist <= max_distance
    rel = rel[in_range]
    if len(rel) == 0:
        return 0

    dirs = _generate_26_directions()
    hits = 0
    for d in dirs:
        t = rel @ d  # (M,)
        forward = t > 0.0
        if not forward.any():
            continue
        rel_f = rel[forward]
        t_f = t[forward]
        perp = rel_f - t_f[:, None] * d[None, :]
        perp_d = np.linalg.norm(perp, axis=1)
        if (perp_d < perp_threshold).any():
            hits += 1
    return hits


def estimate_room(
    ply_path: str,
    cache_dir: str | None = None,
    opacity_threshold: float = 0.1,
    percentile_low: float = 5.0,
    percentile_high: float = 95.0,
    interior_perp_ratio: float = 0.01,
    interior_max_distance_ratio: float = 0.5,
    interior_min_hits: int = 22,
    strict: bool = True,
) -> RoomInfo:
    """Phase 1 main entry. plan v2 §Phase 1.

    Args:
        ply_path: 입력 3DGS PLY 경로.
        cache_dir: 비어있지 않으면 room.json을 cache_dir에 저장.
        opacity_threshold: sigmoid 후 opacity 임계값. default 0.1.
        percentile_low/high: 각 축 robust bbox percentile.
        interior_*: 26-ray validation 파라미터.
        strict: True면 interior_ok=False일 때 RuntimeError raise (D10 fail-fast).

    Raises:
        RuntimeError: opaque 점이 너무 적거나 interior validation 실패 시 (strict=True).
    """
    splats = load_ply(ply_path)
    means = np.asarray(splats["means"], dtype=np.float64)
    opac_logit = np.asarray(splats["opacities"], dtype=np.float64)

    if means.ndim != 2 or means.shape[1] != 3:
        raise RuntimeError(f"Unexpected PLY means shape: {means.shape}")

    opac = _sigmoid(opac_logit)
    keep = opac >= opacity_threshold
    n_kept = int(keep.sum())
    if n_kept < 100:
        raise RuntimeError(
            f"Too few opaque points after sigmoid threshold "
            f"({n_kept} ≥ {opacity_threshold}). PLY 품질 또는 임계값 점검."
        )
    means_kept = means[keep]

    bbox_min = np.percentile(means_kept, percentile_low, axis=0)
    bbox_max = np.percentile(means_kept, percentile_high, axis=0)
    if not np.all(bbox_max > bbox_min):
        raise RuntimeError(
            f"Degenerate robust bbox: min={bbox_min.tolist()}, "
            f"max={bbox_max.tolist()}"
        )

    bbox_diagonal = float(np.linalg.norm(bbox_max - bbox_min))
    center = (bbox_min + bbox_max) / 2.0
    half_extent = (bbox_max - bbox_min) / 2.0
    min_half_extent = float(half_extent.min())

    in_bbox = np.all((means_kept >= bbox_min) & (means_kept <= bbox_max), axis=1)
    pts_in = means_kept[in_bbox]

    hits = _count_26_ray_hits(
        center=center,
        points=pts_in,
        bbox_diagonal=bbox_diagonal,
        perp_threshold_ratio=interior_perp_ratio,
        max_distance_ratio=interior_max_distance_ratio,
    )
    interior_ok = hits >= interior_min_hits

    info = RoomInfo(
        robust_bbox_min=tuple(bbox_min.tolist()),  # type: ignore[arg-type]
        robust_bbox_max=tuple(bbox_max.tolist()),  # type: ignore[arg-type]
        robust_bbox_diagonal=bbox_diagonal,
        room_center=tuple(center.tolist()),  # type: ignore[arg-type]
        interior_ok=interior_ok,
        interior_hits_26=int(hits),
        min_half_extent=min_half_extent,
    )

    # 진단성을 위해 fail-fast 전에 room.json 먼저 저장
    if cache_dir:
        info.save(cache_dir)

    if not interior_ok and strict:
        raise RuntimeError(
            f"Room center not interior: {hits}/26 hits (need ≥{interior_min_hits}). "
            f"bbox_min={tuple(round(v, 3) for v in info.robust_bbox_min)}, "
            f"bbox_max={tuple(round(v, 3) for v in info.robust_bbox_max)}, "
            f"diag={info.robust_bbox_diagonal:.3f}, "
            f"center={tuple(round(v, 3) for v in info.room_center)}. "
            f"Possible causes: non-convex room, large furniture at center, partial "
            f"reconstruction. (D10 fail-fast)"
        )

    return info
