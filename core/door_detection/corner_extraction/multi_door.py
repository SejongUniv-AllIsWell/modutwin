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
    # SAM3 마스크 손잡이(검은 hole) 위치로 추정한 hinge 변 (0=상,1=우,2=하,3=좌). None=손잡이 미검출.
    suggested_hinge_edge: int | None = None
    cluster_view_idxs: list[int] = field(default_factory=list)  # 클러스터에 속한 뷰들


def detect_hinge_edge_from_mask(mask_path: str, min_hole_frac: float = 0.002) -> int | None:
    """SAM3 마스크에서 문 손잡이(흰색 내부 검은 hole) 위치로 hinge 변 추정.

    손잡이가 문 중심보다 왼쪽 → hinge 는 오른쪽 변(1), 오른쪽 → 왼쪽 변(3).
    (hinge 는 손잡이 반대편 = 자유 회전하는 쪽이 손잡이.)
    손잡이 hole 이 없거나 작으면 None (프론트 마법사 fallback).

    변 인덱스: 0=상(LT-RT), 1=우(RT-RB), 2=하(RB-LB), 3=좌(LB-LT).
    """
    try:
        import numpy as _np
        from PIL import Image as _PIL
        from scipy.ndimage import binary_fill_holes, label as _label
    except Exception:
        return None
    try:
        mask = _np.asarray(_PIL.open(mask_path).convert("L")) > 127
    except Exception:
        return None
    door_area = float(mask.sum())
    if door_area <= 0:
        return None
    filled = binary_fill_holes(mask)
    holes = filled & (~mask)
    if float(holes.sum()) < door_area * min_hole_frac:
        return None  # 유의미한 손잡이 hole 없음
    lbl, n = _label(holes)
    if n == 0:
        return None
    sizes = _np.bincount(lbl.ravel())
    sizes[0] = 0  # 배경 제외
    largest = int(sizes.argmax())
    hxs = _np.where(lbl == largest)[1]
    if hxs.size == 0:
        return None
    handle_cx = float(hxs.mean())
    door_cx = float(_np.where(mask)[1].mean())
    # 손잡이가 왼쪽(handle_cx < door_cx) → hinge 오른쪽 변(1), 아니면 왼쪽 변(3).
    return 1 if handle_cx < door_cx else 3


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
    링 wrap-around 포함 (v0 ↔ v_last 인접 처리).
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

    n_total = len(coarse_cam_map)  # 링 크기 (전체 coarse view 수)

    def _ring_dist(a: int, b: int) -> int:
        d = abs(a - b)
        return min(d, n_total - d) if n_total > 0 else d

    # 요구③: 상단 2코너만 보이는 뷰 필터 — ring 거리 ≤ adjacency_window 인 4코너 뷰 있으면 제외
    four_corner_idxs = {c.view_idx for c in raw if c.all_corners_visible}
    filtered: list[DoorCandidate] = []
    for cand in raw:
        if cand.all_corners_visible:
            filtered.append(cand)
            continue
        # 상단 2코너뿐 — ring 이웃에 4코너 뷰가 있는지 확인
        has_near_four = any(_ring_dist(cand.view_idx, fi) <= adjacency_window for fi in four_corner_idxs)
        if has_near_four:
            continue
        filtered.append(cand)

    return sorted(filtered, key=lambda c: c.view_idx)


# ---------------------------------------------------------------------------
# Step B — 인접 클러스터링 (같은 벽 + view_idx gap ≤ GAP)
# ---------------------------------------------------------------------------

def cluster_by_adjacency(
    candidates: list[DoorCandidate],
    gap: int = 2,
    n_total: int = 0,
) -> list[list[DoorCandidate]]:
    """같은 wall_idx + ring view_idx gap ≤ gap → 같은 클러스터.

    계획 D3: 다른 wall_idx 는 항상 다른 문.
    n_total: 전체 coarse view 수 (링 wrap-around 계산용). 0 이면 선형 거리 사용.
    """
    if not candidates:
        return []

    def _ring_dist(a: int, b: int) -> int:
        d = abs(a - b)
        return min(d, n_total - d) if n_total > 0 else d

    clusters: list[list[DoorCandidate]] = []
    current: list[DoorCandidate] = [candidates[0]]

    for prev, cand in zip(candidates, candidates[1:]):
        same_wall = (prev.wall_idx == cand.wall_idx) or (prev.wall_idx == -1 and cand.wall_idx == -1)
        close_idx = _ring_dist(cand.view_idx, prev.view_idx) <= gap
        if same_wall and close_idx:
            current.append(cand)
        else:
            clusters.append(current)
            current = [cand]
    clusters.append(current)

    # 링 wrap-around: 마지막 클러스터와 첫 번째 클러스터가 실제로 인접하면 병합.
    if len(clusters) >= 2:
        first, last = clusters[0], clusters[-1]
        same_wall = (
            (first[0].wall_idx == last[-1].wall_idx)
            or (first[0].wall_idx == -1 and last[-1].wall_idx == -1)
        )
        close_idx = _ring_dist(first[0].view_idx, last[-1].view_idx) <= gap
        if same_wall and close_idx:
            clusters[-1] = last + first  # last 에 first 를 이어붙임
            clusters = clusters[:-1] + [clusters[-1]]  # first 제거, last 확장
            clusters.pop(0)

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

    # hinge 자동 검출 — 대표 뷰 마스크의 손잡이 위치로 추정.
    suggested_hinge = detect_hinge_edge_from_mask(best.mask_path) if best.mask_path else None

    return DoorStructure(
        corners={"left_top": _t(tl), "right_top": _t(tr),
                 "left_bottom": _t(bl), "right_bottom": _t(br)},
        wall_idx=w_idx,
        score=best.score,
        src_view_idx=best.view_idx,
        mode=mode,
        suggested_hinge_edge=suggested_hinge,
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
    adjacency_window: int = 2,
    gap: int = 2,
    merge_dist: float = 0.4,
) -> list[DoorStructure]:
    """Step A-D 통합 실행. 문 개수는 클러스터링으로 자동 결정 (개수 입력 불필요).

    DoorStructure 리스트(score 내림차순) 반환.
    """
    n_total = len(coarse_cam_map)  # 링 크기

    # Step A
    candidates = collect_door_candidates(sam3_summary, coarse_cam_map, adjacency_window)
    if not candidates:
        return []

    # Step B — 인접 클러스터링 (문 개수 자동, 링 wrap-around 포함)
    clusters = cluster_by_adjacency(candidates, gap=gap, n_total=n_total)

    # Step C
    structures = []
    for cluster in clusters:
        ds = extract_door_structure(
            cluster, cam_by_key, walls, real_floor_y,
            pixel_rotate_fn, pixel_to_ray_fn, ray_hit_fn,
        )
        if ds is not None:
            structures.append(ds)

    # Step D — 유사 구조체 병합 (같은 문 dedup)
    structures = merge_similar_structures(structures, merge_dist=merge_dist)

    return sorted(structures, key=lambda d: -d.score)
