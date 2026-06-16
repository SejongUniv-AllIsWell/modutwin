"""벽 평면 + ray ∩ 평면 코너 추출 (다중뷰 삼각측량 대체).

문은 벽 위에 있으므로, 검출된 문 코너 픽셀의 world ray 를 그 벽 평면에 꽂으면
단일 뷰만으로 3D 코너가 확정된다(삼각측량의 ≥2뷰 제약 제거).

좌표는 A' 프레임 (known-room). 벽 평면은 수직(법선이 XZ 평면 안).
"""

from __future__ import annotations

import numpy as np


def build_wall_planes(polygon_xz, floor_y: float, ceiling_y: float) -> list[dict]:
    """방 footprint 폴리곤(A' X-Z) → 각 변의 수직 벽 평면 리스트.

    각 wall dict: a, b (XZ 끝점), dir2 (단위), len, point (평면 위 한 점, 3D),
    normal (3D, XZ 법선), floor_y, ceiling_y.
    """
    poly = np.asarray(polygon_xz, dtype=np.float64).reshape(-1, 2)
    n = poly.shape[0]
    walls: list[dict] = []
    for i in range(n):
        a = poly[i]
        b = poly[(i + 1) % n]
        seg = b - a
        L = float(np.hypot(seg[0], seg[1]))
        if L < 1e-9:
            continue
        d2 = seg / L
        nrm2 = np.array([d2[1], -d2[0]], dtype=np.float64)  # XZ 수직
        walls.append({
            "a": a, "b": b, "dir2": d2, "len": L,
            "point": np.array([a[0], 0.0, a[1]], dtype=np.float64),
            "normal": np.array([nrm2[0], 0.0, nrm2[1]], dtype=np.float64),
            "floor_y": float(floor_y), "ceiling_y": float(ceiling_y),
        })
    return walls


def ray_wall_hit(
    origin: np.ndarray,
    direction: np.ndarray,
    wall: dict,
    seg_tol: float = 0.15,
    y_tol_frac: float = 0.25,
) -> np.ndarray | None:
    """ray(origin, direction) ∩ 벽 평면. 교점이 벽 세그먼트/높이 범위 안이면 3D 점 반환.

    유효성: 전방(t>0) + XZ 가 세그먼트 [a,b](±seg_tol) 안 + Y 가 [floor,ceiling](±여유) 안.
    """
    o = np.asarray(origin, dtype=np.float64)
    d = np.asarray(direction, dtype=np.float64)
    n = wall["normal"]
    denom = float(d @ n)
    if abs(denom) < 1e-9:
        return None  # 평행
    t = float((wall["point"] - o) @ n) / denom
    if t <= 1e-6:
        return None  # 후방
    p = o + t * d

    # XZ 가 벽 세그먼트 안인가
    rel = np.array([p[0] - wall["a"][0], p[2] - wall["a"][1]], dtype=np.float64)
    s = float(rel @ wall["dir2"]) / wall["len"]
    if s < -seg_tol or s > 1.0 + seg_tol:
        return None

    # Y 가 천장~바닥 범위(여유 포함) 안인가
    h = abs(wall["ceiling_y"] - wall["floor_y"])
    lo = min(wall["floor_y"], wall["ceiling_y"]) - h * y_tol_frac
    hi = max(wall["floor_y"], wall["ceiling_y"]) + h * y_tol_frac
    if p[1] < lo or p[1] > hi:
        return None
    return p


def pick_door_wall(rays: list[tuple[np.ndarray, np.ndarray]], walls: list[dict]) -> int | None:
    """주어진 ray 들이 가장 많이 유효 교차하는 벽 index. 없으면 None."""
    best_idx: int | None = None
    best_count = 0
    for i, w in enumerate(walls):
        cnt = sum(1 for (o, d) in rays if ray_wall_hit(o, d, w) is not None)
        if cnt > best_count:
            best_count = cnt
            best_idx = i
    return best_idx
