"""Phase 4-6 (NEW) — Iterative door approach via trapezoid analysis.

Algorithm:
  1. Coarse SAM3 결과를 score 내림차순 정렬 → top-N candidates (score ≥ min_score)
  2. 각 candidate에 대해 최대 max_iterations회 반복:
     a. mask를 quad로 근사 → 사다리꼴 지표(h_ratio, v_ratio, coverage) 측정
     b. 이전 score보다 개선됐으면 계속, 감소하면 다음 candidate로 fallback
     c. 조기 종료: 네 코너 모두 보이고 + 충분히 직사각형이면 stop
  3. all_corners_visible인 view들만 ViewSelection에 포함
  4. 최소 1개 good view가 없으면 fail-fast (D10)

Notes:
  - 이미지는 90° CW 저장 → centroid / quad는 stored 좌표 → ray 변환 시 역변환 적용
  - 3DGS mask는 edge가 불규칙할 수 있음 → convex hull + Douglas-Peucker quad fitting
  - 직사각형 판정: 저장 이미지 기준 (회전 무관)
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..render.camera_sampler import CameraView, build_lookat_camera
from ..triangulation.ray import pixel_rotate_cw_to_orig, pixel_to_world_ray
from ..view_selection.filter import RejectedView, SelectedView, ViewSelection


# 표준 문 높이 (m). 거리 추정에 사용.
_DOOR_HEIGHT_M = 2.1


# ─────────────────────────────────────────────────────────────
# Data structures
# ─────────────────────────────────────────────────────────────

@dataclass
class TrapezoidMetrics:
    """저장 이미지(90° CW) 기준 mask quad 분석 결과."""

    quad_2d: np.ndarray          # (4, 2) stored image pixel coords
    centroid_u: float            # stored image centroid u (col)
    centroid_v: float            # stored image centroid v (row)
    coverage: float              # fg_pixels / (w * h)
    h_ratio: float               # min(top_w, bot_w) / max → 1.0=직사각
    v_ratio: float               # min(left_h, right_h) / max → 1.0=직사각
    all_corners_visible: bool    # 네 코너 모두 boundary margin 밖에 있음
    img_size: int                # assumed square


@dataclass
class IterativeView:
    """Iterative approach 중 생성된 단일 view 결과."""

    camera: CameraView
    render_path: str
    mask_path: str
    score: float
    coverage: float
    h_ratio: float
    v_ratio: float
    all_corners_visible: bool
    iteration: int               # 0 = coarse pass, 1..N = approach iter
    candidate_rank: int          # 0 = best coarse, 1 = 2nd best, ...


# ─────────────────────────────────────────────────────────────
# Mask / quad analysis
# ─────────────────────────────────────────────────────────────

def _image_space_order_quad(quad: np.ndarray) -> np.ndarray:
    """(4, 2) quad를 image 기준 top-2 / bottom-2 / left / right 순으로 재정렬.

    Returns:
        (4, 2) in order [top-left, top-right, bottom-left, bottom-right]
        여기서 top = 작은 v (row).
    """
    by_v = np.argsort(quad[:, 1])          # v (row) 오름차순
    top_idx = by_v[:2].tolist()
    bot_idx = by_v[2:].tolist()
    top_sorted = sorted(top_idx, key=lambda i: quad[i, 0])   # u 오름차순
    bot_sorted = sorted(bot_idx, key=lambda i: quad[i, 0])
    TL, TR = top_sorted
    BL, BR = bot_sorted
    return np.array([quad[TL], quad[TR], quad[BL], quad[BR]], dtype=np.float64)


def analyze_mask_quad(
    mask_arr: np.ndarray,
    img_size: int = 1024,
    boundary_margin: int = 12,
) -> Optional[TrapezoidMetrics]:
    """binary mask (stored, 90° CW) → TrapezoidMetrics.

    Args:
        mask_arr: 2D bool/uint8, shape (img_size, img_size).
        img_size: 이미지 한 변 크기 (square 가정).
        boundary_margin: 코너가 이 픽셀 이내면 boundary touch로 판정.

    Returns:
        TrapezoidMetrics 또는 None (quad 추출 실패 / fg 없음).
    """
    from ..corner_extraction.quadrilateral import extract_quadrilateral

    fg = mask_arr > 0 if mask_arr.dtype != bool else mask_arr
    n_fg = int(fg.sum())
    if n_fg == 0:
        return None

    ys, xs = np.where(fg)
    centroid_u = float(xs.mean())
    centroid_v = float(ys.mean())
    coverage = n_fg / float(img_size * img_size)

    quad = extract_quadrilateral(fg)
    if quad is None:
        return None

    ordered = _image_space_order_quad(quad)
    TL, TR, BL, BR = ordered[0], ordered[1], ordered[2], ordered[3]

    top_w = float(np.linalg.norm(TR - TL))
    bot_w = float(np.linalg.norm(BR - BL))
    left_h = float(np.linalg.norm(BL - TL))
    right_h = float(np.linalg.norm(BR - TR))

    h_ratio = (min(top_w, bot_w) / max(top_w, bot_w)) if max(top_w, bot_w) > 1e-3 else 0.0
    v_ratio = (min(left_h, right_h) / max(left_h, right_h)) if max(left_h, right_h) > 1e-3 else 0.0

    m = float(boundary_margin)
    hi = float(img_size - 1 - boundary_margin)
    all_visible = all(
        m <= float(pt[0]) <= hi and m <= float(pt[1]) <= hi
        for pt in [TL, TR, BL, BR]
    )

    return TrapezoidMetrics(
        quad_2d=ordered,
        centroid_u=centroid_u,
        centroid_v=centroid_v,
        coverage=coverage,
        h_ratio=h_ratio,
        v_ratio=v_ratio,
        all_corners_visible=all_visible,
        img_size=img_size,
    )


# ─────────────────────────────────────────────────────────────
# Camera approach computation
# ─────────────────────────────────────────────────────────────

def compute_approach_camera(
    current_camera: CameraView,
    metrics: TrapezoidMetrics,
    room_center: np.ndarray,
    horizontal_half_extent: float,
    view_idx: int,
    target_coverage: float = 0.30,
    min_approach_dist: float = 0.30,
    door_height_m: float = _DOOR_HEIGHT_M,
    gaussian_tree=None,
    air_radius: float = 0.15,
    air_max_count: int = 20,
    air_retry_halving: int = 3,
) -> Optional[CameraView]:
    """mask 사다리꼴 분석 결과를 바탕으로 문에 더 가까운/정면 카메라를 계산.

    접근 전략:
      1. mask centroid pixel → stored→orig 역변환 → world ray
      2. mask의 column span (stored u) = 원본 height direction → 거리 추정
      3. adaptive step: coverage가 target에 가까울수록 작은 step
      4. 새 위치: 수평(XZ)으로 step 이동, Y는 현재 카메라 Y 유지
         (Y 조정 제거: door_center Y가 Gaussian 밀집 구역일 수 있음)
      5. air-space 검증: KDTree로 밀도 확인, 실패 시 step 절반씩 재시도
      6. 새 카메라: door center를 lookat

    Returns:
        새 CameraView 또는 None (step ≤ 0 또는 air-space 확보 불가).
    """
    K = np.asarray(current_camera.K, dtype=np.float64)
    c2w = np.asarray(current_camera.c2w, dtype=np.float64)
    img_size = current_camera.w

    # Centroid → original frame pixel
    u_orig, v_orig = pixel_rotate_cw_to_orig(
        metrics.centroid_u, metrics.centroid_v, img_size
    )

    ray = pixel_to_world_ray(u_orig, v_orig, K, c2w)
    cam_pos = c2w[:3, 3].copy()

    # --- 거리 추정 ---
    # stored image에서 quad의 column (u) span = 원본 height direction
    quad_col_span = float(np.max(metrics.quad_2d[:, 0]) - np.min(metrics.quad_2d[:, 0]))
    if quad_col_span > 1.0:
        fy = float(K[1, 1])
        estimated_dist = float(np.clip(fy * door_height_m / quad_col_span, 0.3, 15.0))
    else:
        estimated_dist = 2.0  # fallback

    # Door center in world (lookat 타겟용)
    door_center = cam_pos + estimated_dist * ray.direction

    # --- Adaptive step (보수적: 한 번에 너무 많이 이동하지 않음) ---
    # coverage가 target의 절반을 넘으면 step을 0으로 수렴시킴
    # 0.3 multiplier: 이전 0.6에서 절반으로 줄여 overshoot 방지
    step_frac = max(0.05, 1.0 - np.sqrt(min(metrics.coverage / target_coverage, 1.0)))
    step = estimated_dist * step_frac * 0.3
    step = min(step, max(0.0, estimated_dist - min_approach_dist))

    if step < 0.01:
        return None

    # 수평 방향 (XZ 평면) 단위 벡터
    horiz_dir = np.array([ray.direction[0], 0.0, ray.direction[2]], dtype=np.float64)
    horiz_norm = float(np.linalg.norm(horiz_dir))
    if horiz_norm > 1e-9:
        horiz_dir /= horiz_norm
    else:
        horiz_dir = np.array([ray.direction[0], 0.0, ray.direction[2]])
        horiz_dir /= max(float(np.linalg.norm(horiz_dir)), 1e-9)

    # --- air-space 검증 + step retry ---
    # Y는 현재 카메라 Y 고정 (door_center Y로 이동 시 Gaussian 내부 진입 방지)
    current_step = step
    new_pos = None
    for _ in range(air_retry_halving + 1):
        if current_step < 0.01:
            break
        candidate = cam_pos.copy()
        candidate += current_step * horiz_dir
        # Y 고정: 현재 eye height 유지

        # 방 경계 clamp (수평)
        h_off = np.array([candidate[0] - room_center[0], 0.0, candidate[2] - room_center[2]])
        h_dist = float(np.linalg.norm(h_off))
        max_horiz = float(horizontal_half_extent) * 0.95
        if h_dist > max_horiz and h_dist > 1e-9:
            scale = max_horiz / h_dist
            candidate[0] = float(room_center[0]) + h_off[0] * scale
            candidate[2] = float(room_center[2]) + h_off[2] * scale

        # air-space 검증
        if gaussian_tree is not None:
            count = int(gaussian_tree.query_ball_point(candidate, r=air_radius, return_length=True))
            if count > air_max_count:
                current_step *= 0.5
                continue

        new_pos = candidate
        break

    if new_pos is None:
        return None

    return build_lookat_camera(
        position=new_pos,
        target=door_center,
        view_idx=view_idx,
        source="iterative",
        width=current_camera.w,
        height=current_camera.h,
    )


# ─────────────────────────────────────────────────────────────
# Greedy baseline diversity filter (reused from filter.py logic)
# ─────────────────────────────────────────────────────────────

def _greedy_baseline_filter(
    views: list[IterativeView],
    room_center: np.ndarray,
    min_angle_deg: float = 5.0,
) -> tuple[list[IterativeView], list[IterativeView]]:
    """score 내림차순으로 baseline 다양성 기준 필터."""
    if not views:
        return [], []
    sorted_v = sorted(views, key=lambda v: v.score, reverse=True)
    cos_thresh = float(np.cos(np.deg2rad(min_angle_deg)))
    kept: list[IterativeView] = []
    kept_dirs: list[np.ndarray] = []
    dropped: list[IterativeView] = []
    for v in sorted_v:
        pos = np.asarray(v.camera.position, dtype=np.float64)
        d = pos - room_center
        n = float(np.linalg.norm(d))
        if n < 1e-9:
            dropped.append(v)
            continue
        d /= n
        if any(float(np.dot(d, kd)) > cos_thresh for kd in kept_dirs):
            dropped.append(v)
            continue
        kept.append(v)
        kept_dirs.append(d)
    return kept, dropped


# ─────────────────────────────────────────────────────────────
# Candidate extraction
# ─────────────────────────────────────────────────────────────

def _get_top_candidates(
    coarse_summary: dict,
    coarse_cameras: list[CameraView],
    n_top: int,
    min_score: float,
) -> list[tuple[CameraView, str, float]]:
    """coarse SAM3 결과에서 score 내림차순 top-N 후보 추출.

    Returns:
        [(camera, mask_path, score)] score 내림차순.
    """
    cam_by_idx = {c.view_idx: c for c in coarse_cameras}
    candidates = []
    for v in coarse_summary.get("views", []):
        mask_path = v.get("mask_path")
        score = float(v.get("max_score") or 0.0)
        if not mask_path or score < min_score:
            continue
        idx = int(v["view_idx"])
        if idx not in cam_by_idx:
            continue
        candidates.append((cam_by_idx[idx], mask_path, score))

    candidates.sort(key=lambda x: x[2], reverse=True)
    return candidates[:n_top]


# ─────────────────────────────────────────────────────────────
# Main entry
# ─────────────────────────────────────────────────────────────

def run_iterative_approach(
    coarse_summary: dict,
    coarse_cameras: list[CameraView],
    splats: dict,
    room_center: np.ndarray,
    horizontal_half_extent: float,
    iterative_dir: str,
    prompt: str,
    confidence_threshold: float,
    device: str,
    checkpoint_path: Optional[str] = None,
    n_top_candidates: int = 3,
    max_iterations: int = 5,
    min_score: float = 0.5,
    rect_h_thresh: float = 0.85,
    rect_v_thresh: float = 0.85,
    boundary_margin: int = 12,
    target_coverage: float = 0.20,
    score_tolerance: float = 0.03,
    means_for_air_check: Optional[np.ndarray] = None,
    air_radius: float = 0.15,
    air_max_count: int = 20,
) -> tuple[list[IterativeView], ViewSelection, dict[tuple[str, int], CameraView]]:
    """Iterative door approach: Phase 4+5+6 통합 대체.

    Args:
        coarse_summary: Phase 3 SAM3 결과 dict.
        coarse_cameras: Phase 2 coarse CameraView 리스트.
        splats: load_ply() 결과 (렌더링용).
        room_center: (3,) 방 중심.
        horizontal_half_extent: X-Z 반지름 (walk mode r_walk).
        iterative_dir: 중간 산출물 저장 디렉터리.
        prompt: SAM3 텍스트 프롬프트.
        confidence_threshold: SAM3 최소 신뢰도.
        device: 'cuda' | 'cpu'.
        checkpoint_path: SAM3 로컬 checkpoint.
        n_top_candidates: 시도할 최대 coarse 후보 수.
        max_iterations: 후보당 최대 접근 반복 횟수.
        min_score: 후보 최소 SAM3 score.
        rect_h_thresh: 조기 종료 h_ratio 임계값.
        rect_v_thresh: 조기 종료 v_ratio 임계값.
        boundary_margin: 코너 boundary 판정 margin (px).
        target_coverage: 문이 이미지에서 차지할 목표 비율.

    Returns:
        (all_iterative_views, view_selection, cam_by_key)
        - all_iterative_views: 모든 good view 리스트 (score 개선 경로)
        - view_selection: downstream Phase 7+8 용 ViewSelection
        - cam_by_key: {("iterative", view_idx): CameraView}

    Raises:
        RuntimeError: 네 코너 모두 보이는 view를 단 하나도 찾지 못했을 때.
    """
    from ..render.splat_renderer import render_views
    from ..segmentation.sam3_runner import (
        load_sam3_model_and_processor,
        run_sam3_single_with_model,
    )

    os.makedirs(iterative_dir, exist_ok=True)
    room_center = np.asarray(room_center, dtype=np.float64)

    # ── Gaussian KDTree 구성 (air-space 검증용) ──
    gaussian_tree = None
    if means_for_air_check is not None:
        from scipy.spatial import cKDTree
        gaussian_tree = cKDTree(np.asarray(means_for_air_check, dtype=np.float64))
        print(f"[Iterative] air-space KDTree built ({means_for_air_check.shape[0]} gaussians)", flush=True)

    # ── 모델 한 번만 로드 ──
    print("[Iterative] loading SAM3 model ...", flush=True)
    model, processor = load_sam3_model_and_processor(device, checkpoint_path)

    # ── top candidates 추출 ──
    candidates = _get_top_candidates(
        coarse_summary, coarse_cameras, n_top_candidates, min_score
    )
    if not candidates:
        raise RuntimeError(
            f"Iterative approach: no coarse view has score ≥ {min_score}. "
            "Phase 3 SAM3 결과 점검. (D10 fail-fast)"
        )
    print(
        f"[Iterative] {len(candidates)} candidates "
        f"(score {candidates[0][2]:.3f} … {candidates[-1][2]:.3f})",
        flush=True,
    )

    all_good_views: list[IterativeView] = []

    # ── 각 candidate 반복 ──
    for rank, (coarse_cam, coarse_mask_path, coarse_score) in enumerate(candidates):
        cand_dir = os.path.join(iterative_dir, f"candidate_{rank:02d}")
        os.makedirs(cand_dir, exist_ok=True)

        current_cam = coarse_cam
        current_mask_path = coarse_mask_path
        current_score = coarse_score

        from PIL import Image as _PILImage
        mask_arr = np.asarray(_PILImage.open(current_mask_path).convert("L")) > 127
        metrics = analyze_mask_quad(mask_arr, img_size=current_cam.w, boundary_margin=boundary_margin)

        if metrics is None:
            print(f"[Iterative] candidate {rank}: coarse quad 추출 실패 → skip", flush=True)
            continue

        print(
            f"[Iterative] candidate {rank} (view {coarse_cam.view_idx}): "
            f"score={coarse_score:.3f}, h={metrics.h_ratio:.3f}, v={metrics.v_ratio:.3f}, "
            f"cov={metrics.coverage:.3f}, visible={metrics.all_corners_visible}",
            flush=True,
        )

        # coarse view 자체가 good이면 포함
        if metrics.all_corners_visible:
            all_good_views.append(IterativeView(
                camera=current_cam,
                render_path="",  # coarse render은 외부에 있음
                mask_path=current_mask_path,
                score=current_score,
                coverage=metrics.coverage,
                h_ratio=metrics.h_ratio,
                v_ratio=metrics.v_ratio,
                all_corners_visible=True,
                iteration=0,
                candidate_rank=rank,
            ))

        # 이미 충분히 직사각형이면 접근 불필요
        if (metrics.h_ratio >= rect_h_thresh and metrics.v_ratio >= rect_v_thresh
                and metrics.all_corners_visible):
            print(f"[Iterative] candidate {rank}: early exit at coarse (already rectangular)", flush=True)
            continue

        # ── 접근 반복 ──
        for it in range(1, max_iterations + 1):
            new_view_idx = rank * 100 + it

            new_cam = compute_approach_camera(
                current_camera=current_cam,
                metrics=metrics,
                room_center=room_center,
                horizontal_half_extent=horizontal_half_extent,
                view_idx=new_view_idx,
                target_coverage=target_coverage,
                gaussian_tree=gaussian_tree,
                air_radius=air_radius,
                air_max_count=air_max_count,
            )

            if new_cam is None:
                print(f"[Iterative] candidate {rank} iter {it}: already at min distance → stop", flush=True)
                break

            # 렌더
            iter_renders_dir = os.path.join(cand_dir, f"iter_{it:02d}", "renders")
            render_paths = render_views(splats, [new_cam], iter_renders_dir, device=device)
            render_path = render_paths[0]

            # SAM3
            iter_sam_dir = os.path.join(cand_dir, f"iter_{it:02d}")
            sam_result = run_sam3_single_with_model(
                image_path=render_path,
                model=model,
                processor=processor,
                output_subdir=iter_sam_dir,
                view_idx=new_view_idx,
                prompt=prompt,
                confidence_threshold=confidence_threshold,
                device=device,
            )

            new_score = float(sam_result.get("max_score") or 0.0)
            new_mask_path = sam_result.get("mask_path")

            if new_mask_path is None or new_score < min_score:
                print(
                    f"[Iterative] candidate {rank} iter {it}: "
                    f"no detection (score={new_score:.3f}) → stop candidate",
                    flush=True,
                )
                break

            new_mask_arr = np.asarray(_PILImage.open(new_mask_path).convert("L")) > 127
            new_metrics = analyze_mask_quad(new_mask_arr, img_size=new_cam.w, boundary_margin=boundary_margin)

            if new_metrics is None:
                print(f"[Iterative] candidate {rank} iter {it}: quad 추출 실패 → stop candidate", flush=True)
                break

            print(
                f"[Iterative] candidate {rank} iter {it}: "
                f"score {current_score:.3f}→{new_score:.3f}, "
                f"h={new_metrics.h_ratio:.3f}, v={new_metrics.v_ratio:.3f}, "
                f"cov={new_metrics.coverage:.3f}, visible={new_metrics.all_corners_visible}",
                flush=True,
            )

            # score_tolerance 이내 감소는 허용 (SAM3 수치 변동 + 더 정면 뷰는 약간 낮을 수 있음)
            if new_score >= current_score - score_tolerance:
                # 개선 또는 허용 범위 내 감소 → 업데이트
                current_score = new_score
                current_cam = new_cam
                current_mask_path = new_mask_path
                metrics = new_metrics

                if new_metrics.all_corners_visible:
                    all_good_views.append(IterativeView(
                        camera=new_cam,
                        render_path=render_path,
                        mask_path=new_mask_path,
                        score=new_score,
                        coverage=new_metrics.coverage,
                        h_ratio=new_metrics.h_ratio,
                        v_ratio=new_metrics.v_ratio,
                        all_corners_visible=True,
                        iteration=it,
                        candidate_rank=rank,
                    ))

                # 조기 종료: 충분히 직사각형 + 네 코너 다 보임
                if (new_metrics.h_ratio >= rect_h_thresh
                        and new_metrics.v_ratio >= rect_v_thresh
                        and new_metrics.all_corners_visible):
                    print(
                        f"[Iterative] candidate {rank} iter {it}: "
                        f"early exit (rectangular enough)",
                        flush=True,
                    )
                    break
            else:
                # score 감소 → 이 candidate 포기
                print(
                    f"[Iterative] candidate {rank} iter {it}: "
                    f"score decreased ({current_score:.3f}→{new_score:.3f}) → next candidate",
                    flush=True,
                )
                break

    if not all_good_views:
        raise RuntimeError(
            "Iterative approach: 네 코너가 모두 보이는 view를 찾지 못했습니다. "
            "PLY/SAM3 품질, boundary_margin, min_score 점검. (D10 fail-fast)"
        )

    print(
        f"[Iterative] {len(all_good_views)} good views collected "
        f"(all_corners_visible=True)",
        flush=True,
    )

    # ── Baseline diversity filter ──
    kept_views, _ = _greedy_baseline_filter(all_good_views, room_center, min_angle_deg=2.0)

    if not kept_views:
        kept_views = all_good_views  # diversity filter가 너무 공격적이면 전체 사용

    # ── ViewSelection 생성 ──
    selected = [
        SelectedView(
            source=v.camera.source,
            view_idx=v.camera.view_idx,
            score=v.score,
            mask_path=v.mask_path,
            mask_area_ratio=v.coverage,
        )
        for v in kept_views
    ]
    cam_by_key: dict[tuple[str, int], CameraView] = {
        (v.camera.source, v.camera.view_idx): v.camera for v in kept_views
    }

    # drop된 view 기록
    kept_idx_set = {v.camera.view_idx for v in kept_views}
    rejected = [
        RejectedView(v.camera.source, v.camera.view_idx, "baseline diversity filter")
        for v in all_good_views
        if v.camera.view_idx not in kept_idx_set
    ]

    selection = ViewSelection(
        selected=selected,
        rejected=rejected,
        n_selected=len(selected),
        n_rejected=len(rejected),
    )

    # 캐시 저장
    selection.save(iterative_dir)
    _save_iterative_log(all_good_views, iterative_dir)

    print(
        f"[Iterative] ViewSelection: {selection.n_selected} selected, "
        f"{selection.n_rejected} rejected (baseline diversity)",
        flush=True,
    )
    return all_good_views, selection, cam_by_key


def _save_iterative_log(views: list[IterativeView], out_dir: str) -> None:
    """디버그용 iterative 결과 로그 저장."""
    log = [
        {
            "candidate_rank": v.candidate_rank,
            "iteration": v.iteration,
            "view_idx": v.camera.view_idx,
            "score": round(v.score, 4),
            "coverage": round(v.coverage, 4),
            "h_ratio": round(v.h_ratio, 4),
            "v_ratio": round(v.v_ratio, 4),
            "all_corners_visible": v.all_corners_visible,
            "position": [round(x, 4) for x in v.camera.position],
            "mask_path": v.mask_path,
        }
        for v in views
    ]
    path = os.path.join(out_dir, "iterative_log.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(log, f, indent=2)
