"""Phase 4 — Door direction estimation via mask centroid + DBSCAN.

plan v2 §Phase 4:
  1. 각 high-prob view에서 mask centroid (u_c, v_c) 픽셀 계산
  2. (u_c, v_c) → camera ray (Phase 9 ray.py 재사용)
  3. ray direction을 단위 벡터로 모음
  4. DBSCAN(eps_deg=15°, metric=각거리, min_samples=2)
  5. 가장 큰 클러스터의 평균 방향 = cluster_dir (D9 단일 문)
  6. 클러스터 0개 → fail-fast (D10)
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass

import numpy as np

from ..render.camera_sampler import CameraView, load_cameras
from ..triangulation.ray import pixel_to_world_ray


@dataclass
class DoorDirectionResult:
    cluster_dir: tuple[float, float, float]
    cluster_member_view_ids: list[int]
    n_total_high_prob_views: int
    n_clusters_found: int
    eps_deg: float

    def save(self, cache_dir: str) -> str:
        os.makedirs(cache_dir, exist_ok=True)
        path = os.path.join(cache_dir, "door_direction.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(asdict(self), f, indent=2)
        return path

    @classmethod
    def load(cls, cache_dir: str) -> "DoorDirectionResult":
        path = os.path.join(cache_dir, "door_direction.json")
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        d["cluster_dir"] = tuple(d["cluster_dir"])
        return cls(**d)


def _mask_centroid(mask_path: str) -> tuple[float, float] | None:
    """binary mask PNG → (u_centroid, v_centroid) 픽셀. mask 비면 None."""
    from PIL import Image

    arr = np.asarray(Image.open(mask_path).convert("L"))
    fg = arr > 127
    n = int(fg.sum())
    if n == 0:
        return None
    ys, xs = np.where(fg)
    return float(xs.mean()), float(ys.mean())


def _angular_distance_matrix(dirs: np.ndarray) -> np.ndarray:
    """unit dirs (N, 3) → pairwise 각거리 행렬 (rad)."""
    dot = np.clip(dirs @ dirs.T, -1.0, 1.0)
    return np.arccos(dot)


def estimate_door_direction(
    sam3_summary: dict,
    cameras: list[CameraView],
    cache_dir: str | None = None,
    eps_deg: float = 15.0,
    min_samples: int = 2,
) -> DoorDirectionResult:
    """Phase 4 main entry.

    Args:
        sam3_summary: run_sam3 반환값 또는 scores.json 내용. ``views`` 리스트에서
            mask_path가 None이 아닌 view들을 고른다.
        cameras: 같은 source의 CameraView 리스트 (view_idx로 매칭).
        cache_dir: 비어있지 않으면 door_direction.json 저장.
        eps_deg: DBSCAN 각거리 eps (도 단위).
        min_samples: DBSCAN 최소 샘플.

    Raises:
        RuntimeError: high-prob view 0개 또는 DBSCAN cluster 0개일 때 (D10).
    """
    from sklearn.cluster import DBSCAN

    cam_by_idx = {c.view_idx: c for c in cameras}
    view_meta = sam3_summary.get("views", [])
    high_prob_views = [v for v in view_meta if v.get("mask_path")]
    n_total = len(high_prob_views)

    if n_total == 0:
        raise RuntimeError(
            "Phase 4: no high-prob view (mask_path None for all). "
            "Phase 3 SAM3 결과 점검. (D10 fail-fast)"
        )

    dirs: list[np.ndarray] = []
    member_view_ids: list[int] = []
    for v in high_prob_views:
        idx = int(v["view_idx"])
        if idx not in cam_by_idx:
            continue
        centroid = _mask_centroid(v["mask_path"])
        if centroid is None:
            continue
        u_rot, v_rot = centroid
        # 90° CW 저장 이미지 → 원본 픽셀 역변환
        from ..triangulation.ray import pixel_rotate_cw_to_orig
        u, vc = pixel_rotate_cw_to_orig(u_rot, v_rot, img_size=cam_by_idx[idx].w)
        cam = cam_by_idx[idx]
        ray = pixel_to_world_ray(u, vc, K=cam.K, c2w=cam.c2w)
        dirs.append(ray.direction)
        member_view_ids.append(idx)

    if len(dirs) == 0:
        raise RuntimeError(
            "Phase 4: 모든 high-prob view의 mask가 비어있거나 카메라 매칭 실패. "
            "(D10 fail-fast)"
        )

    dirs_arr = np.stack(dirs, axis=0)
    eps_rad = np.deg2rad(eps_deg)

    if len(dirs_arr) >= min_samples:
        dist_mat = _angular_distance_matrix(dirs_arr)
        clustering = DBSCAN(eps=eps_rad, min_samples=min_samples, metric="precomputed")
        labels = clustering.fit_predict(dist_mat)
    else:
        # 샘플이 너무 적으면 DBSCAN 의미 없음. 전부 한 클러스터로 취급.
        labels = np.zeros(len(dirs_arr), dtype=int)

    valid = labels >= 0
    n_clusters = int(len(np.unique(labels[valid]))) if valid.any() else 0
    if n_clusters == 0:
        raise RuntimeError(
            f"Phase 4: DBSCAN found 0 cluster among {len(dirs_arr)} rays "
            f"(eps_deg={eps_deg}, min_samples={min_samples}). 모든 ray가 outlier. "
            "(D10 fail-fast)"
        )

    unique_lbls, counts = np.unique(labels[valid], return_counts=True)
    largest_label = int(unique_lbls[int(np.argmax(counts))])
    member_mask = labels == largest_label
    cluster_dirs = dirs_arr[member_mask]
    cluster_member_ids = [member_view_ids[i] for i in np.where(member_mask)[0]]

    mean_dir = cluster_dirs.mean(axis=0)
    n = float(np.linalg.norm(mean_dir))
    if n < 1e-9:
        raise RuntimeError(
            "Phase 4: cluster_dir의 평균이 0벡터 — 정반대 방향 ray가 같은 클러스터로 들어갔을 가능성. "
            "(D10 fail-fast)"
        )
    cluster_dir = mean_dir / n

    result = DoorDirectionResult(
        cluster_dir=tuple(cluster_dir.tolist()),  # type: ignore[arg-type]
        cluster_member_view_ids=sorted(int(i) for i in cluster_member_ids),
        n_total_high_prob_views=n_total,
        n_clusters_found=n_clusters,
        eps_deg=float(eps_deg),
    )
    if cache_dir:
        result.save(cache_dir)
    return result
