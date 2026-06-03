"""N-door 자동 추출 — 인접 클러스터 + 3D 검증·병합.

docs/n_door_detection_plan.md §4 Step A-E 구현.

흐름:
  Step A  coarse SAM3 검출 뷰 후보 수집 (mask quad 분석 + wall_idx 기록)
  Step B  인접 클러스터링 (같은 벽 + view_idx gap ≤ GAP → 같은 문 그룹)
  Step C  클러스터별 코너 추출 → DoorStructure (마스크당 독립 ray, 섞임 없음)
  Step D  3D 검증·병합 (유사 구조체 dedup, 최고 품질 유지)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional
import numpy as np


# ---------------------------------------------------------------------------
# 데이터 구조
# ---------------------------------------------------------------------------

@dataclass
class DoorCandidate:
    """Step A 출력 — coarse SAM3 검출 뷰 1개의 정보."""
    view_idx: int
    wall_idx: int            # 이 카메라가 바라보는 벽 index (-1 = 미설정)
    score: float             # SAM3 max_score
    mask_path: str
    all_corners_visible: bool
    h_ratio: float
    v_ratio: float
    coverage: float
    # quad 픽셀 좌표 (ordered: LT, RT, LB, RB)
    left_top: tuple[float, float] = (0.0, 0.0)
    right_top: tuple[float, float] = (0.0, 0.0)
    left_bottom: tuple[float, float] = (0.0, 0.0)
    right_bottom: tuple[float, float] = (0.0, 0.0)


@dataclass
class DoorStructure:
    """Step C 출력 — 한 문의 4코너 3D 구조체 (마스크·뷰 독립 보장)."""
    corners: dict[str, tuple[float, float, float]]  # LT/RT/LB/RB
    wall_idx: int
    score: float
    src_view_idx: int          # 대표 뷰 (single-view mode)
    mode: str                  # "4-corner-single" | "top-2-floorY"
    cluster_view_idxs: list[int] = field(default_factory=list)  # 클러스터에 속한 뷰들


# ---------------------------------------------------------------------------
# Step A — 후보 뷰 수집
# ---------------------------------------------------------------------------

def collect_door_candidates(
    sam3_summary: dict,
    coarse_cam_map: dict,          # view_idx → CameraView
    adjacency_window: int = 2,     # ±N 이웃에서 4코너 뷰 탐색 (요구③)
) -> list[DoorCandidate]:
    """SAM3 검출 coarse 뷰 → DoorCandidate 리스트.

    요구③: 상단 2코너만 보이는 뷰는 ±adjacency_window 이웃에 4코너 뷰가 있으면 skip.
    """
    from ..view_selection.iterative_approach import analyze_mask_quad

    raw: list[DoorCandidate] = []
    for v in sam3_summary.get("views", []):
        if not v.get("mask_path"):
            continue
        cam = coarse_cam_map.get(v["view_idx"])
        if cam is None:
            continue
        import numpy as _np
        from PIL import Image as _PIL
        try:
            mask = _np.asarray(_PIL.open(v["mask_path"]).convert("L")) > 127
        except Exception:
            continue
        m = analyze_mask_quad(mask, img_size=cam.w)
        if m is None:
            continue
        cand = DoorCandidate(
            view_idx=v["view_idx"],
            wall_idx=cam.wall_idx,
            score=float(v.get("max_score") or 0.0),
            mask_path=v["mask_path"],
            all_corners_visible=m.all_corners_visible,
            h_ratio=float(m.h_ratio),
            v_ratio=float(m.v_ratio),
            coverage=float(m.coverage),
            left_top=(float(m.quad_2d[0, 0]), float(m.quad_2d[0, 1])),
            right_top=(float(m.quad_2d[1, 0]), float(m.quad_2d[1, 1])),
            left_bottom=(float(m.quad_2d[2, 0]), float(m.quad_2d[2, 1])),
            right_bottom=(float(m.quad_2d[3, 0]), float(m.quad_2d[3, 1])),
        )
        raw.append(cand)

    # 요구③: 상단 2코너만 보이는 뷰 필터 — ±adjacency_window 이웃에 4코너 뷰 있으면 제외
    all_view_idxs = {c.view_idx for c in raw}
    four_corner_idxs = {c.view_idx for c in raw if c.all_corners_visible}
    filtered: list[DoorCandidate] = []
    for cand in raw:
        if cand.all_corners_visible:
            filtered.append(cand)
            continue
        # 상단 2코너뿐 — 이웃에 4코너 뷰가 있는지 확인
        neighbors = set(range(cand.view_idx - adjacency_window, cand.view_idx + adjacency_window + 1))
        if neighbors & four_corner_idxs:
            continue  # 이웃에 4코너 뷰 있음 → skip
        filtered.append(cand)

    return sorted(filtered, key=lambda c: c.view_idx)


# ---------------------------------------------------------------------------
# Step B — 인접 클러스터링 (같은 벽 + view_idx gap ≤ GAP)
# ---------------------------------------------------------------------------

def cluster_by_adjacency(
    candidates: list[DoorCandidate],
    gap: int = 2,
) -> list[list[DoorCandidate]]:
    """같은 wall_idx + view_idx gap ≤ gap → 같은 클러스터.

    계획 D3: 다른 wall_idx 는 항상 다른 문.
    """
    if not candidates:
        return []

    clusters: list[list[DoorCandidate]] = []
    current: list[DoorCandidate] = [candidates[0]]

    for prev, cand in zip(candidates, candidates[1:]):
        same_wall = (prev.wall_idx == cand.wall_idx) or (prev.wall_idx == -1 and cand.wall_idx == -1)
        close_idx = abs(cand.view_idx - prev.view_idx) <= gap
        if same_wall and close_idx:
            current.append(cand)
        else:
            clusters.append(current)
            current = [cand]
    clusters.append(current)
    return clusters


# ---------------------------------------------------------------------------
# Step C — 클러스터별 DoorStructure 추출
# ---------------------------------------------------------------------------

def extract_door_structure(
    cluster: list[DoorCandidate],
    cam_by_key: dict,            # (source, view_idx) → CameraView
    walls: list[dict],           # build_wall_planes 결과
    real_floor_y: float,
    pixel_rotate_fn,             # pixel_rotate_cw_to_orig
    pixel_to_ray_fn,             # pixel_to_world_ray
    ray_hit_fn,                  # ray_wall_hit
) -> Optional[DoorStructure]:
    """클러스터 → DoorStructure (요구①: 마스크당 독립, 섞임 없음).

    대표 뷰 선택 (계획 D2): 4코너 보이는 최고 score → 없으면 상단2점 최고 score.
    """
    import numpy as _np

    # 대표 뷰 선택
    four_corner = [c for c in cluster if c.all_corners_visible]
    top_two = [c for c in cluster if not c.all_corners_visible]
    if four_corner:
        best = max(four_corner, key=lambda c: c.score)
        mode = "4-corner-single"
    elif top_two:
        best = max(top_two, key=lambda c: c.score)
        mode = "top-2-floorY"
    else:
        return None

    # cam_by_key 에서 카메라 조회 (coarse 카메라)
    cam = cam_by_key.get(("coarse", best.view_idx))
    if cam is None:
        return None

    # 문이 있는 벽 선택 — 클러스터의 wall_idx 로 고정 (D3)
    w_idx = best.wall_idx
    if w_idx < 0 or w_idx >= len(walls):
        # wall_idx 없으면 ray 방향으로 자동 탐색
        from ..room.wall_planes import pick_door_wall as _pick
        K = _np.asarray(cam.K, dtype=_np.float64)
        c2w = _np.asarray(cam.c2w, dtype=_np.float64)
        def _ray(u_s, v_s):
            u_o, v_o = pixel_rotate_fn(u_s, v_s, cam.w)
            return pixel_to_ray_fn(u_o, v_o, K, c2w)
        lt_r = _ray(*best.left_top); rt_r = _ray(*best.right_top)
        rays_top = [(lt_r.origin, lt_r.direction), (rt_r.origin, rt_r.direction)]
        w_idx_found = _pick(rays_top, walls)
        if w_idx_found is None:
            return None
        w_idx = w_idx_found
    door_wall = walls[w_idx]

    # 단일 뷰 ray → 벽 교점 헬퍼
    K_arr = _np.asarray(cam.K, dtype=_np.float64)
    c2w_arr = _np.asarray(cam.c2w, dtype=_np.float64)

    def _hit(u_s: float, v_s: float):
        u_o, v_o = pixel_rotate_fn(u_s, v_s, cam.w)
        r = pixel_to_ray_fn(u_o, v_o, K_arr, c2w_arr)
        return ray_hit_fn(r.origin, r.direction, door_wall)

    tl = _hit(*best.left_top)
    tr = _hit(*best.right_top)
    if tl is None or tr is None:
        return None

    if mode == "4-corner-single":
        bl = _hit(*best.left_bottom)
        br = _hit(*best.right_bottom)
        if bl is None:
            bl = _np.array([tl[0], real_floor_y, tl[2]])
        if br is None:
            br = _np.array([tr[0], real_floor_y, tr[2]])
    else:  # top-2-floorY
        bl = _np.array([tl[0], real_floor_y, tl[2]])
        br = _np.array([tr[0], real_floor_y, tr[2]])

    def _t(p) -> tuple[float, float, float]:
        return (float(p[0]), float(p[1]), float(p[2]))

    return DoorStructure(
        corners={"left_top": _t(tl), "right_top": _t(tr),
                 "left_bottom": _t(bl), "right_bottom": _t(br)},
        wall_idx=w_idx,
        score=best.score,
        src_view_idx=best.view_idx,
        mode=mode,
        cluster_view_idxs=[c.view_idx for c in cluster],
    )


# ---------------------------------------------------------------------------
# Step D — 3D 검증·병합 (요구②)
# ---------------------------------------------------------------------------

def _door_centroid(ds: DoorStructure) -> np.ndarray:
    pts = np.array(list(ds.corners.values()), dtype=np.float64)
    return pts.mean(axis=0)


def _door_width(ds: DoorStructure) -> float:
    lt = np.array(ds.corners["left_top"])
    rt = np.array(ds.corners["right_top"])
    return float(np.linalg.norm(lt[[0, 2]] - rt[[0, 2]]))


def merge_similar_structures(
    structures: list[DoorStructure],
    merge_dist: float = 0.4,       # 기본 0.4m; 실제 = max(merge_dist, 0.5×min_width)
) -> list[DoorStructure]:
    """유사(=같은 문) 구조체 병합 — 계획 D1·D2.

    같은 wall_idx + 3D centroid 거리 < threshold → 병합.
    병합 시 4-corner-single 우선, 같은 mode 면 score 높은 쪽 유지.
    """
    if not structures:
        return []

    merged: list[DoorStructure] = []
    used = [False] * len(structures)

    for i, a in enumerate(structures):
        if used[i]:
            continue
        group = [a]
        for j, b in enumerate(structures):
            if j <= i or used[j]:
                continue
            if a.wall_idx != b.wall_idx:
                continue
            # 동적 threshold
            min_w = min(_door_width(a), _door_width(b))
            thresh = max(merge_dist, 0.5 * min_w)
            dist = float(np.linalg.norm(_door_centroid(a) - _door_centroid(b)))
            if dist < thresh:
                group.append(b)
                used[j] = True

        # 그룹 대표: 4-corner-single 우선, 그다음 score 높은 것
        def _priority(ds: DoorStructure) -> tuple:
            return (0 if ds.mode == "4-corner-single" else 1, -ds.score)
        rep = min(group, key=_priority)
        merged.append(rep)
        used[i] = True

    return merged


# ---------------------------------------------------------------------------
# 전체 N-door 파이프라인 (Step A-D 통합)
# ---------------------------------------------------------------------------

def extract_n_doors(
    sam3_summary: dict,
    coarse_cam_map: dict,
    cam_by_key: dict,
    walls: list[dict],
    real_floor_y: float,
    pixel_rotate_fn,
    pixel_to_ray_fn,
    ray_hit_fn,
    max_doors: int = 8,
    adjacency_window: int = 2,
    gap: int = 2,
    merge_dist: float = 0.4,
) -> list[DoorStructure]:
    """Step A-D 통합 실행. DoorStructure 리스트 반환 (최대 max_doors)."""
    # Step A
    candidates = collect_door_candidates(sam3_summary, coarse_cam_map, adjacency_window)
    if not candidates:
        return []

    # Step B
    clusters = cluster_by_adjacency(candidates, gap=gap)

    # Step C
    structures = []
    for cluster in clusters:
        ds = extract_door_structure(
            cluster, cam_by_key, walls, real_floor_y,
            pixel_rotate_fn, pixel_to_ray_fn, ray_hit_fn,
        )
        if ds is not None:
            structures.append(ds)

    # Step D
    structures = merge_similar_structures(structures, merge_dist=merge_dist)

    # max_doors 제한: score 내림차순
    structures = sorted(structures, key=lambda d: -d.score)[:max_doors]
    return structures
