"""Phase 2/5 — 카메라 위치/방향 샘플러.

plan v2 §Phase 2:
  - r_coarse = min_half_extent × 0.3 (D5: 보수적으로 방 안 보장)
  - Fibonacci sphere로 N_coarse 단위 방향
  - position = room_center + r_coarse × dir
  - look-at = room_center + 2 × r_coarse × dir (outward radial)
  - up = world_up. forward과 평행하면 (0,0,1) fallback.
  - K: FOV 60°, W=H=1024, principal point 이미지 중심
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass

import numpy as np

from ..conventions import WORLD_UP, make_intrinsic


@dataclass
class CameraView:
    view_idx: int
    K: list[list[float]]          # 3x3
    c2w: list[list[float]]        # 4x4 (OpenCV cam-to-world)
    w: int
    h: int
    position: tuple[float, float, float]
    look_at: tuple[float, float, float]
    source: str                   # "coarse" | "fine"


def _fibonacci_sphere(n: int) -> np.ndarray:
    """단위 구 위 N개 균등 분포 점 (golden-ratio fibonacci)."""
    if n <= 0:
        raise ValueError(f"n must be positive, got {n}")
    phi = (1.0 + np.sqrt(5.0)) / 2.0
    indices = np.arange(n, dtype=np.float64) + 0.5
    # latitude
    z = 1.0 - 2.0 * indices / n
    r = np.sqrt(np.maximum(0.0, 1.0 - z * z))
    # longitude
    theta = 2.0 * np.pi * indices / phi
    x = r * np.cos(theta)
    y = r * np.sin(theta)
    return np.stack([x, y, z], axis=-1)


def _look_at_c2w(
    position: np.ndarray,
    target: np.ndarray,
    world_up: np.ndarray,
    fallback_up: np.ndarray = np.array([0.0, 0.0, 1.0]),
    parallel_threshold: float = 0.999,
) -> np.ndarray:
    """OpenCV camera convention의 c2w (4x4) 생성.

    cam +Z = forward (target - position 방향)
    cam +X = right  = world_up × forward (right-handed world 가정)
    cam +Y = down   = right × forward
    """
    fwd = target - position
    fwd_norm = np.linalg.norm(fwd)
    if fwd_norm < 1e-9:
        raise ValueError("position == target, cannot define forward")
    fwd /= fwd_norm

    up = world_up
    if abs(float(np.dot(fwd, up))) > parallel_threshold:
        up = fallback_up
        if abs(float(np.dot(fwd, up))) > parallel_threshold:
            # 두 fallback 모두 평행이면 임의 perp
            up = np.array([1.0, 0.0, 0.0])

    right = np.cross(up, fwd)
    right /= np.linalg.norm(right)
    down = np.cross(right, fwd)
    down /= np.linalg.norm(down)

    c2w = np.eye(4, dtype=np.float64)
    c2w[:3, 0] = right
    c2w[:3, 1] = down
    c2w[:3, 2] = fwd
    c2w[:3, 3] = position
    return c2w


def build_lookat_camera(
    position: np.ndarray,
    target: np.ndarray,
    view_idx: int,
    source: str,
    width: int = 1024,
    height: int = 1024,
    fov_x_deg: float = 60.0,
) -> "CameraView":
    """임의 위치/타겟으로 CameraView 생성 (iterative approach용).

    OpenCV convention: +X right, +Y down, +Z forward.
    """
    from ..conventions import WORLD_UP, make_intrinsic

    K = make_intrinsic(width, height, fov_x_deg)
    c2w = _look_at_c2w(
        np.asarray(position, dtype=np.float64),
        np.asarray(target, dtype=np.float64),
        WORLD_UP,
    )
    return CameraView(
        view_idx=view_idx,
        K=K.tolist(),
        c2w=c2w.tolist(),
        w=width,
        h=height,
        position=tuple(float(x) for x in position),  # type: ignore[arg-type]
        look_at=tuple(float(x) for x in target),  # type: ignore[arg-type]
        source=source,
    )


def sample_coarse_cameras(
    room_center: np.ndarray,
    min_half_extent: float,
    n_views: int,
    width: int = 1024,
    height: int = 1024,
    fov_x_deg: float = 60.0,
    radius_ratio: float = 0.3,
) -> tuple[list[CameraView], float]:
    """Phase 2: room_center 주변 fibonacci sphere outward.

    Returns:
        (cameras, r_coarse): camera 리스트와 사용된 sphere 반경.
    """
    room_center = np.asarray(room_center, dtype=np.float64)
    if room_center.shape != (3,):
        raise ValueError(f"room_center must be (3,), got {room_center.shape}")
    if min_half_extent <= 0:
        raise ValueError(f"min_half_extent must be positive, got {min_half_extent}")

    r_coarse = float(min_half_extent * radius_ratio)
    K = make_intrinsic(width, height, fov_x_deg)

    dirs = _fibonacci_sphere(n_views)  # (N, 3)
    cameras: list[CameraView] = []
    for i, d in enumerate(dirs):
        pos = room_center + r_coarse * d
        target = room_center + 2.0 * r_coarse * d  # outward radial
        c2w = _look_at_c2w(pos, target, WORLD_UP)

        # 방어적: 카메라 위치가 r_coarse 안에 있는지 (D5 강제)
        offset = np.linalg.norm(pos - room_center)
        assert offset <= r_coarse + 1e-6, (
            f"coarse camera #{i} outside r_coarse: {offset:.6f} > {r_coarse:.6f}"
        )

        cameras.append(
            CameraView(
                view_idx=i,
                K=K.tolist(),
                c2w=c2w.tolist(),
                w=width,
                h=height,
                position=tuple(pos.tolist()),  # type: ignore[arg-type]
                look_at=tuple(target.tolist()),  # type: ignore[arg-type]
                source="coarse",
            )
        )
    return cameras, r_coarse


def sample_air_positions(
    means: np.ndarray,
    room_center: np.ndarray,
    horizontal_half_extent: float,
    y_height: float,
    n_positions: int,
    n_candidates: int = 800,
    air_radius: float = 0.15,
    air_max_count: int = 20,
    min_separation_ratio: float = 0.25,
    rng_seed: int = 0,
) -> tuple[np.ndarray, np.ndarray]:
    """KDTree 기반 air-space 위치 샘플링.

    candidate를 dense하게 깐 뒤, 각 candidate가 'air'(가우시안 적게 둘러쌈)인지
    측정해 통과한 것 중 최소 분리 조건으로 N개 선택.

    Args:
        means: PLY Gaussian centers (N, 3) — opacity 필터된 것 권장.
        room_center: (3,) bbox 중심.
        horizontal_half_extent: X-Z 평면 한쪽 반지름. 후보 disk가 이 값 ×
            (1 - margin)까지 분포.
        y_height: 후보 평면의 y 좌표.
        n_positions: 최종 선택 위치 개수.
        n_candidates: 후보 개수.
        air_radius: air 검사 구 반지름 (m).
        air_max_count: air_radius 안 가우시안 수가 이 값보다 적으면 'air'.
        min_separation_ratio: 선택된 위치들 간 최소 분리 = horizontal_half_extent × ratio.
        rng_seed: 재현성.

    Returns:
        (positions (M, 3), local_density (M,)) — M ≤ n_positions.
    """
    from scipy.spatial import cKDTree

    rng = np.random.default_rng(rng_seed)
    tree = cKDTree(np.asarray(means, dtype=np.float64))

    margin = 0.05  # 벽에서 약간 떨어뜨림
    R = horizontal_half_extent * (1.0 - margin)
    # 균등 disk 샘플
    angles = rng.uniform(0.0, 2.0 * np.pi, n_candidates)
    radii = np.sqrt(rng.uniform(0.0, 1.0, n_candidates)) * R
    xs = radii * np.cos(angles) + room_center[0]
    zs = radii * np.sin(angles) + room_center[2]
    candidates = np.column_stack(
        [xs, np.full(n_candidates, float(y_height)), zs]
    )

    # 각 candidate의 air 검사: air_radius 안 가우시안 수
    counts = tree.query_ball_point(candidates, r=air_radius, return_length=True)

    # air 통과 (counts <= air_max_count)인 후보들을 nearest distance 큰 순
    air_mask = counts <= air_max_count
    if not air_mask.any():
        # 임계값 자동 완화: 가장 air-like 한 50개 통과
        order = np.argsort(counts)
        air_mask = np.zeros_like(counts, dtype=bool)
        air_mask[order[:50]] = True

    air_candidates = candidates[air_mask]
    air_counts = counts[air_mask]
    # nearest gaussian distance도 계산 (개방감 metric)
    nearest_dist, _ = tree.query(air_candidates, k=1)

    # greedy: 최소 분리 만족시키며 nearest_dist 큰 순 선택
    order = np.argsort(-nearest_dist)
    min_sep = horizontal_half_extent * min_separation_ratio
    picked: list[int] = []
    picked_pos: list[np.ndarray] = []
    for idx in order:
        p = air_candidates[idx]
        if all(float(np.linalg.norm(p - q)) > min_sep for q in picked_pos):
            picked.append(int(idx))
            picked_pos.append(p)
            if len(picked) == n_positions:
                break

    if len(picked) == 0:
        # 마지막 fallback: 최소분리 무시하고 nearest_dist 큰 N개
        picked = order[:n_positions].tolist()

    positions = air_candidates[picked]
    densities = air_counts[picked].astype(np.float64)
    return positions, densities


def sample_walk_cameras(
    room_center: np.ndarray,
    min_half_extent: float,
    n_positions: int,
    n_yaw_per_position: int,
    width: int = 1024,
    height: int = 1024,
    fov_x_deg: float = 60.0,
    radius_ratio: float = 0.6,
    pitch_deg: float = 0.0,
    horizontal_half_extent: float | None = None,
    means_for_air_check: np.ndarray | None = None,
    air_radius: float = 0.15,
    air_max_count: int = 20,
    eye_height_y: float | None = None,
) -> tuple[list[CameraView], float]:
    """사람 도보 시점 카메라 샘플링 (air-space aware).

    plan v2 D5(방 안)을 유지하면서, sphere-outward 대신 다음을 한다:
      1. (means_for_air_check 제공 시) Gaussian 밀도 낮은 air 위치들에서 N_positions 선택
         그렇지 않으면 sunflower disk fallback (legacy)
      2. 각 위치에서 yaw 0..360°를 N_yaw_per_position 등분
      3. pitch = pitch_deg (default 0 = 수평), roll = 0 (image up = world up)

    Args:
        min_half_extent: 3축 중 최소 half-extent (sphere mode와 호환용).
        horizontal_half_extent: X-Z 평면 한쪽 반지름. 권장. None이면 min_half_extent 사용.
        means_for_air_check: 가우시안 중심 (opacity 필터된 PLY means). None이면 sunflower
            fallback. ★권장: 갈색 책상 안 등에서 렌더 안 되도록 air space 검사.
        air_radius / air_max_count: air 판정 임계.

    Returns:
        (cameras, r_walk)
    """
    room_center = np.asarray(room_center, dtype=np.float64)
    if room_center.shape != (3,):
        raise ValueError(f"room_center must be (3,), got {room_center.shape}")
    if min_half_extent <= 0:
        raise ValueError(f"min_half_extent must be positive, got {min_half_extent}")
    if n_positions <= 0 or n_yaw_per_position <= 0:
        raise ValueError("n_positions/n_yaw_per_position must be > 0")

    base_extent = (
        horizontal_half_extent if horizontal_half_extent is not None else min_half_extent
    )
    r_walk = float(base_extent * radius_ratio)
    K = make_intrinsic(width, height, fov_x_deg)

    camera_y = float(eye_height_y) if eye_height_y is not None else float(room_center[1])

    if means_for_air_check is not None:
        positions, _density = sample_air_positions(
            means=means_for_air_check,
            room_center=room_center,
            horizontal_half_extent=r_walk,
            y_height=camera_y,
            n_positions=n_positions,
            air_radius=air_radius,
            air_max_count=air_max_count,
        )
        if positions.shape[0] < n_positions:
            # air 검사 통과가 부족 → 상위 후보 그대로 사용 (D10 정신: 우회 대신 표면화)
            print(
                f"[walk] WARNING: only {positions.shape[0]}/{n_positions} air positions "
                f"passed (air_radius={air_radius}, max_count={air_max_count}). "
                f"Try larger --air_radius or check PLY density.",
                flush=True,
            )
    else:
        # legacy: sunflower disk
        if n_positions == 1:
            offsets_2d = np.array([[0.0, 0.0]])
        else:
            offsets_2d = _sunflower_disk(n_positions) * r_walk
        positions = np.array(
            [room_center + np.array([px, camera_y - room_center[1], pz])
             for px, pz in offsets_2d]
        )

    pitch_rad = np.deg2rad(pitch_deg)
    cameras: list[CameraView] = []
    view_idx = 0
    for pos in positions:
        for k in range(n_yaw_per_position):
            yaw = 2.0 * np.pi * k / n_yaw_per_position
            cy = float(np.cos(yaw)); sy = float(np.sin(yaw))
            cp = float(np.cos(pitch_rad)); sp = float(np.sin(pitch_rad))
            forward = np.array([sy * cp, sp, cy * cp], dtype=np.float64)
            target = pos + forward
            c2w = _look_at_c2w(pos, target, WORLD_UP)
            cameras.append(
                CameraView(
                    view_idx=view_idx,
                    K=K.tolist(),
                    c2w=c2w.tolist(),
                    w=width,
                    h=height,
                    position=tuple(pos.tolist()),  # type: ignore[arg-type]
                    look_at=tuple(target.tolist()),  # type: ignore[arg-type]
                    source="coarse",
                )
            )
            view_idx += 1
    return cameras, r_walk


def _sunflower_disk(n: int) -> np.ndarray:
    """단위 디스크 위 N개 균등 분포 점 (sunflower / 2D fibonacci). returns (N, 2)."""
    if n <= 0:
        raise ValueError(f"n must be positive, got {n}")
    phi = (1.0 + np.sqrt(5.0)) / 2.0
    ii = np.arange(n, dtype=np.float64) + 0.5
    rr = np.sqrt(ii / n)
    th = 2.0 * np.pi * ii / phi
    return np.stack([rr * np.cos(th), rr * np.sin(th)], axis=-1)


def sample_fine_cameras(
    room_center: np.ndarray,
    min_half_extent: float,
    cluster_dir: np.ndarray,
    base_positions: np.ndarray,
    n_views: int,
    width: int = 1024,
    height: int = 1024,
    fov_x_deg: float = 60.0,
    radius_ratio: float = 0.3,
    lateral_ratio: float = 0.4,
) -> list[CameraView]:
    """Phase 5: cluster_dir 방향 기반 fine 카메라 샘플링.

    구성:
      - target T = room_center + 2 × r_coarse × cluster_dir  (대략적인 문 위치)
      - base_centroid = mean(base_positions)
      - forward = normalize(T - base_centroid)
      - perpendicular plane (right, up_perp) 위에서 sunflower 디스크 (반경 δ=r_coarse×0.4)
      - 모든 위치를 ||pos - room_center|| ≤ r_coarse로 clamp (D5 강제)
      - 각 카메라는 target T를 바라봄
    """
    room_center = np.asarray(room_center, dtype=np.float64)
    cluster_dir = np.asarray(cluster_dir, dtype=np.float64)
    if cluster_dir.shape != (3,):
        raise ValueError(f"cluster_dir must be (3,), got {cluster_dir.shape}")
    cd_norm = float(np.linalg.norm(cluster_dir))
    if cd_norm < 1e-9:
        raise ValueError("cluster_dir is zero vector")
    cluster_dir = cluster_dir / cd_norm

    base_positions = np.atleast_2d(np.asarray(base_positions, dtype=np.float64))
    if base_positions.shape[0] == 0:
        raise ValueError("base_positions is empty")

    r_coarse = float(min_half_extent * radius_ratio)
    delta = float(r_coarse * lateral_ratio)
    base_centroid = base_positions.mean(axis=0)

    target = room_center + 2.0 * r_coarse * cluster_dir
    forward = target - base_centroid
    fwd_norm = float(np.linalg.norm(forward))
    if fwd_norm < 1e-9:
        forward = cluster_dir.copy()
    else:
        forward = forward / fwd_norm

    up_world = WORLD_UP.copy()
    if abs(float(np.dot(forward, up_world))) > 0.999:
        up_world = np.array([0.0, 0.0, 1.0])
        if abs(float(np.dot(forward, up_world))) > 0.999:
            up_world = np.array([1.0, 0.0, 0.0])

    right = np.cross(up_world, forward)
    right /= np.linalg.norm(right)
    up_perp = np.cross(forward, right)
    up_perp /= np.linalg.norm(up_perp)

    K = make_intrinsic(width, height, fov_x_deg)
    offsets_2d = (
        np.array([[0.0, 0.0]]) if n_views <= 1 else _sunflower_disk(n_views) * delta
    )

    cameras: list[CameraView] = []
    for i, (lx, ly) in enumerate(offsets_2d):
        pos = base_centroid + lx * right + ly * up_perp
        offset = float(np.linalg.norm(pos - room_center))
        if offset > r_coarse:
            pos = room_center + (pos - room_center) * (r_coarse / offset)
            offset = r_coarse
        assert offset <= r_coarse + 1e-6, (
            f"fine camera #{i} outside r_coarse: {offset:.6f} > {r_coarse:.6f}"
        )
        c2w = _look_at_c2w(pos, target, WORLD_UP)
        cameras.append(
            CameraView(
                view_idx=i,
                K=K.tolist(),
                c2w=c2w.tolist(),
                w=width,
                h=height,
                position=tuple(pos.tolist()),  # type: ignore[arg-type]
                look_at=tuple(target.tolist()),  # type: ignore[arg-type]
                source="fine",
            )
        )
    return cameras


def save_cameras(
    cameras: list[CameraView],
    cache_subdir: str,
    metadata: dict | None = None,
) -> str:
    """plan v2 §2 cache: cameras.json 저장."""
    os.makedirs(cache_subdir, exist_ok=True)
    path = os.path.join(cache_subdir, "cameras.json")
    payload = {
        "n_views": len(cameras),
        "world_up": WORLD_UP.tolist(),
        "metadata": metadata or {},
        "views": [asdict(c) for c in cameras],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return path


def load_cameras(cache_subdir: str) -> list[CameraView]:
    path = os.path.join(cache_subdir, "cameras.json")
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    return [
        CameraView(
            view_idx=v["view_idx"],
            K=v["K"],
            c2w=v["c2w"],
            w=v["w"],
            h=v["h"],
            position=tuple(v["position"]),
            look_at=tuple(v["look_at"]),
            source=v["source"],
        )
        for v in payload["views"]
    ]
