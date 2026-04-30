"""Door 3D Corner detection pipeline — CLI entry.

plan v2 §Phase 0 scaffolding. 각 phase 구현은 후속 작업.

Usage:
    python -m core.door_detection.pipeline \
        --ply path/to/scene.ply \
        --output_json path/to/door_corners.json \
        [--cache_dir path/to/cache] \
        [--n_coarse 32] [--n_fine 24] \
        [--sam3_prob 0.8] [--ransac_ratio 0.005] \
        [--debug]
"""

from __future__ import annotations

import argparse
import os
import sys

# NVIDIA GB10 (Grace Blackwell, compute capability 12.1) 호환성:
# 현재 PyTorch 2.12.0.dev는 sm_80/90/100/120까지만 컴파일됨. JIT(nvrtc)이 12.1 기반
# sm_121을 요청하면 'invalid value for --gpu-architecture' 에러. sm_120은 12.1과
# backward-compatible이므로 12.0을 강제 지정.
# 정직 노트: 이는 GB10/특정 torch dev 빌드의 packaging 문제 회피용 환경 설정이며,
# torch가 sm_121을 정식 지원하면 제거 가능.
os.environ.setdefault("TORCH_CUDA_ARCH_LIST", "12.0")

from .io.result_schema import (
    DoorCornersResult,
    PipelineConfig,
    empty_result,
)
from .io.writer import write_result
from .render.camera_sampler import (
    sample_coarse_cameras,
    sample_walk_cameras,
    save_cameras,
)
from .render.splat_renderer import render_views
from .room.interior import estimate_eye_height_y, estimate_room
from .segmentation.sam3_runner import list_input_pngs, run_sam3
from .view_selection.iterative_approach import run_iterative_approach
from .corner_extraction.ordering import order_all_selected
from .triangulation.ray import (
    Ray,
    pixel_rotate_cw_to_orig,
    pixel_to_world_ray,
    save_rays_npz,
    stack_rays_by_corner,
)
from .triangulation.ransac import TriangulationResult, ransac_triangulate
from .metrics.quality import compute_quality

# load_ply는 utilities (sibling top-level package). 본 module이 root에서 실행되어
# sys.path에 root가 들어있으므로 직접 import 가능.
from utilities.ply_io import load_ply  # noqa: E402


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m core.door_detection.pipeline",
        description=(
            "3DGS PLY -> multi-view render -> SAM3 mask -> 2D quad -> world ray "
            "-> robust triangulation -> 4 raw 3D door corners (plan v2)."
        ),
    )

    p.add_argument("--ply", type=str, required=True, help="입력 3DGS PLY 경로")
    p.add_argument("--output_json", type=str, required=True, help="결과 JSON 출력 경로")
    p.add_argument(
        "--cache_dir",
        type=str,
        default=None,
        help="중간 산출물 캐시 디렉터리. default: <output_json_parent>/cache/",
    )

    # view generation
    p.add_argument("--n_coarse", type=int, default=32, help="coarse pass view 개수")
    p.add_argument("--n_fine", type=int, default=24, help="fine pass view 개수")
    p.add_argument(
        "--camera_mode",
        type=str,
        default="walk",
        choices=["sphere", "walk"],
        help=(
            "coarse 카메라 샘플링 방식. "
            "'walk'(default): 수평 disk 위 N_positions 위치에서 360° yaw sweep (pitch≈0, roll=0). "
            "'sphere': 기존 fibonacci sphere outward."
        ),
    )
    p.add_argument(
        "--n_walk_positions",
        type=int,
        default=4,
        help="walk 모드의 위치 개수. n_yaw_per_position = n_coarse / n_walk_positions",
    )
    p.add_argument(
        "--walk_pitch_deg",
        type=float,
        default=0.0,
        help="walk 모드 pitch (도). 0=수평, 음수=아래, 양수=위. 작게 유지 권장.",
    )
    p.add_argument(
        "--air_radius",
        type=float,
        default=0.15,
        help="walk 모드 air 검사 구 반지름 (m). 이 안의 가우시안 개수로 air 판정.",
    )
    p.add_argument(
        "--air_max_count",
        type=int,
        default=20,
        help="walk 모드 air 임계: 검사 구 안 가우시안 개수가 이 값 이하여야 air 인정.",
    )
    p.add_argument(
        "--eye_height",
        type=float,
        default=1.5,
        help="walk 모드 눈높이 (floor_Y + this). default 1.5m. "
             "--eye_height_abs 지정 시 무시.",
    )
    p.add_argument(
        "--eye_height_abs",
        type=float,
        default=None,
        help="walk 모드 카메라 Y 절대값 지정. 설정 시 자동 추정 무시.",
    )

    # SAM3
    p.add_argument(
        "--sam3_prob",
        type=float,
        default=0.8,
        help="SAM3 confidence threshold (D2 default 0.8)",
    )
    p.add_argument(
        "--prompt",
        type=str,
        default="door",
        help="SAM3 텍스트 프롬프트 (default 'door'). 'white door' 등으로 색/형 hint 가능.",
    )
    p.add_argument(
        "--sam3_checkpoint",
        type=str,
        default=None,
        help="local SAM3 checkpoint 경로 (없으면 HF에서 다운로드)",
    )

    # RANSAC
    p.add_argument(
        "--ransac_ratio",
        type=float,
        default=0.005,
        help="RANSAC inlier threshold = robust_bbox_diagonal * ratio (D6 default 0.005)",
    )

    p.add_argument("--device", type=str, default="cuda", help="compute device")
    p.add_argument("--debug", action="store_true", help="debug 시각화 저장")

    return p


def _resolve_cache_dir(args: argparse.Namespace) -> str:
    if args.cache_dir is not None:
        return args.cache_dir
    return os.path.join(os.path.dirname(os.path.abspath(args.output_json)), "cache")


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    cache_dir = _resolve_cache_dir(args)
    os.makedirs(cache_dir, exist_ok=True)

    config = PipelineConfig(
        n_coarse=args.n_coarse,
        n_fine=args.n_fine,
        sam3_prob=args.sam3_prob,
        ransac_ratio=args.ransac_ratio,
        ransac_threshold_abs=0.0,  # Phase 1 완료 후 채워짐
        robust_bbox_diagonal=0.0,  # Phase 1 완료 후 채워짐
    )

    print("=" * 60, file=sys.stderr)
    print("Door 3D Corner Detection Pipeline (plan v2)", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    print(f"  PLY:        {args.ply}", file=sys.stderr)
    print(f"  Output:     {args.output_json}", file=sys.stderr)
    print(f"  Cache dir:  {cache_dir}", file=sys.stderr)
    print(f"  N coarse:   {args.n_coarse}", file=sys.stderr)
    print(f"  N fine:     {args.n_fine}", file=sys.stderr)
    print(f"  SAM3 prob:  {args.sam3_prob}", file=sys.stderr)
    print(f"  RANSAC %:   {args.ransac_ratio}", file=sys.stderr)
    print("=" * 60, file=sys.stderr)

    result = empty_result(source_ply=args.ply)
    result.config = config

    # ------------------------------------------------------------------
    # Phase 1 — Room interior estimation
    # ------------------------------------------------------------------
    print("[Phase 1] estimating room interior ...", file=sys.stderr)
    room_info = estimate_room(ply_path=args.ply, cache_dir=cache_dir)
    print(
        f"[Phase 1] center={tuple(round(v, 4) for v in room_info.room_center)} "
        f"diag={room_info.robust_bbox_diagonal:.4f} "
        f"min_half={room_info.min_half_extent:.4f} "
        f"interior_hits={room_info.interior_hits_26}/26",
        file=sys.stderr,
    )
    config.robust_bbox_diagonal = room_info.robust_bbox_diagonal
    config.ransac_threshold_abs = room_info.robust_bbox_diagonal * config.ransac_ratio
    result.config = config

    import numpy as np

    # ------------------------------------------------------------------
    # Phase 2 — Coarse view generation (sphere inside room) + RGB render
    # ------------------------------------------------------------------
    print("[Phase 2] sampling coarse cameras + rendering ...", file=sys.stderr)
    coarse_dir = os.path.join(cache_dir, "coarse")
    coarse_renders_dir = os.path.join(coarse_dir, "renders")

    if args.camera_mode == "walk":
        n_yaw = max(1, args.n_coarse // args.n_walk_positions)

        # walk: 수평 half-extent (X-Z) 사용. 천장 높이 제약 무관.
        bx = room_info.robust_bbox_max[0] - room_info.robust_bbox_min[0]
        bz = room_info.robust_bbox_max[2] - room_info.robust_bbox_min[2]
        horizontal_half = float(min(bx, bz) / 2.0)

        # air-space 검사를 위해 PLY means 미리 로드 (opacity 필터)
        splats_for_air = load_ply(args.ply)
        means_air = np.asarray(splats_for_air["means"], dtype=np.float64)
        opac_logit = np.asarray(splats_for_air["opacities"], dtype=np.float64)
        opac_sigmoid = 1.0 / (1.0 + np.exp(-opac_logit))
        means_air = means_air[opac_sigmoid >= 0.1]
        del splats_for_air

        # 눈높이 Y 계산
        if args.eye_height_abs is not None:
            eye_y = float(args.eye_height_abs)
            print(f"[Phase 2] eye_height_abs={eye_y:.3f} (user specified)", file=sys.stderr)
        else:
            eye_y = estimate_eye_height_y(
                means=means_air,
                bbox_min_y=float(room_info.robust_bbox_min[1]),
                bbox_max_y=float(room_info.robust_bbox_max[1]),
                eye_height_m=args.eye_height,
            )
            print(
                f"[Phase 2] floor_Y → eye_height_Y={eye_y:.3f} "
                f"(bbox_Y [{room_info.robust_bbox_min[1]:.2f}, "
                f"{room_info.robust_bbox_max[1]:.2f}])",
                file=sys.stderr,
            )

        coarse_cameras, r_coarse = sample_walk_cameras(
            room_center=np.asarray(room_info.room_center, dtype=np.float64),
            min_half_extent=room_info.min_half_extent,
            horizontal_half_extent=horizontal_half,
            n_positions=args.n_walk_positions,
            n_yaw_per_position=n_yaw,
            pitch_deg=args.walk_pitch_deg,
            means_for_air_check=means_air,
            air_radius=args.air_radius,
            air_max_count=args.air_max_count,
            eye_height_y=eye_y,
        )
        meta = {
            "mode": "walk",
            "r_walk": r_coarse,
            "horizontal_half_extent": horizontal_half,
            "eye_height_y": eye_y,
            "fov_x_deg": 60.0,
            "n_positions": args.n_walk_positions,
            "n_yaw_per_position": n_yaw,
            "pitch_deg": args.walk_pitch_deg,
            "air_radius": args.air_radius,
            "air_max_count": args.air_max_count,
            "n_views": len(coarse_cameras),
        }
        print(
            f"[Phase 2] walk mode: eye_y={eye_y:.3f}, r_walk={r_coarse:.3f}, "
            f"{args.n_walk_positions} air positions × {n_yaw} yaw = "
            f"{len(coarse_cameras)} cameras",
            file=sys.stderr,
        )
    else:
        coarse_cameras, r_coarse = sample_coarse_cameras(
            room_center=np.asarray(room_info.room_center, dtype=np.float64),
            min_half_extent=room_info.min_half_extent,
            n_views=args.n_coarse,
        )
        meta = {
            "mode": "sphere",
            "r_coarse": r_coarse,
            "fov_x_deg": 60.0,
            "n_views": args.n_coarse,
        }
        print(
            f"[Phase 2] sphere mode: r_coarse={r_coarse:.4f} (= min_half × 0.3), "
            f"{len(coarse_cameras)} cameras",
            file=sys.stderr,
        )
    save_cameras(coarse_cameras, coarse_dir, metadata=meta)

    # PLY 한 번 더 로드해서 렌더 (Phase 1과 분리: Phase 1은 means만 필요).
    splats = load_ply(args.ply)
    saved_pngs = render_views(splats, coarse_cameras, coarse_renders_dir, device=args.device)
    print(f"[Phase 2] rendered {len(saved_pngs)} PNGs to {coarse_renders_dir}", file=sys.stderr)

    # 메모리 회수
    del splats

    # ------------------------------------------------------------------
    # Phase 3 — SAM3 first pass (confidence ≥ 0.8, D2)
    # ------------------------------------------------------------------
    print(f"[Phase 3] running SAM3 on {len(saved_pngs)} coarse views ...", file=sys.stderr)
    coarse_image_paths = list_input_pngs(coarse_renders_dir)
    sam3_summary = run_sam3(
        image_paths=coarse_image_paths,
        output_subdir=coarse_dir,
        prompt=args.prompt,
        confidence_threshold=args.sam3_prob,
        device=args.device,
        checkpoint_path=args.sam3_checkpoint,
    )
    print(
        f"[Phase 3] {sam3_summary['n_views_with_detection']}/"
        f"{sam3_summary['n_total_views']} views passed prob ≥ {args.sam3_prob}",
        file=sys.stderr,
    )
    if sam3_summary["n_views_with_detection"] == 0:
        raise RuntimeError(
            f"SAM3 first pass: no view has door detection ≥ {args.sam3_prob}. "
            f"Provide --door_hint or check PLY/render quality. (D10 fail-fast)"
        )

    # ------------------------------------------------------------------
    # Phase 4-6 — Iterative door approach
    #   - top-3 coarse candidates → 최대 5회 접근 반복
    #   - 사다리꼴 분석으로 카메라 position + rotation 보정
    #   - score 개선 시 계속, 감소 시 다음 후보
    #   - 조기 종료: h_ratio/v_ratio ≥ 0.85 && all_corners_visible
    # ------------------------------------------------------------------
    print("[Phase 4-6] iterative door approach ...", file=sys.stderr)
    iterative_dir = os.path.join(cache_dir, "iterative")

    splats = load_ply(args.ply)  # 다시 로드 (Phase 2 렌더 후 del 했음)
    _means_air_for_iter = means_air if args.camera_mode == "walk" else None
    all_iterative_views, selection, iterative_cam_by_key = run_iterative_approach(
        coarse_summary=sam3_summary,
        coarse_cameras=coarse_cameras,
        splats=splats,
        room_center=np.asarray(room_info.room_center, dtype=np.float64),
        horizontal_half_extent=horizontal_half if args.camera_mode == "walk" else r_coarse,
        iterative_dir=iterative_dir,
        prompt=args.prompt,
        confidence_threshold=args.sam3_prob,
        device=args.device,
        checkpoint_path=args.sam3_checkpoint,
        means_for_air_check=_means_air_for_iter,
        air_radius=args.air_radius,
        air_max_count=args.air_max_count,
    )
    del splats
    print(
        f"[Phase 4-6] iterative: {len(all_iterative_views)} good views, "
        f"selected {selection.n_selected} after diversity filter",
        file=sys.stderr,
    )

    # ------------------------------------------------------------------
    # Phase 7+8 — Quadrilateral extraction + LT/RT/LB/RB ordering (chained)
    # ------------------------------------------------------------------
    print("[Phase 7+8] extracting quadrilaterals + ordering corners ...", file=sys.stderr)
    # cam_by_key: coarse + iterative (fine cameras 없음)
    cam_by_key: dict = {("coarse", c.view_idx): c for c in coarse_cameras}
    cam_by_key.update(iterative_cam_by_key)
    ordered_cache = order_all_selected(
        selection=selection,
        cam_by_key=cam_by_key,
        cache_dir=cache_dir,
    )
    print(
        f"[Phase 7+8] {len(ordered_cache.views)}/{selection.n_selected} views "
        f"survived quad+ordering",
        file=sys.stderr,
    )

    # ------------------------------------------------------------------
    # Phase 9 — World-space ray generation (4 corners × N views)
    # ------------------------------------------------------------------
    print("[Phase 9] generating world-space rays ...", file=sys.stderr)
    all_rays: list[Ray] = []
    CORNER_KEYS_TUPLE = ("left_top", "right_top", "left_bottom", "right_bottom")
    for ov in ordered_cache.views:
        cam = cam_by_key[(ov.source, ov.view_idx)]
        K_arr = np.asarray(cam.K, dtype=np.float64)
        c2w_arr = np.asarray(cam.c2w, dtype=np.float64)
        img_size = cam.w
        for ck in CORNER_KEYS_TUPLE:
            # OrderedCornersView 좌표는 stored(90° CW) 이미지 기준 → 역변환 필요
            u_stored, v_stored = getattr(ov, ck)
            u_orig, v_orig = pixel_rotate_cw_to_orig(u_stored, v_stored, img_size)
            r = pixel_to_world_ray(u_orig, v_orig, K_arr, c2w_arr)
            r.view_idx = ov.view_idx
            r.corner_type = ck
            all_rays.append(r)

    by_corner = stack_rays_by_corner(all_rays)
    save_rays_npz(by_corner, cache_dir)
    counts = {k: int(d["origins"].shape[0]) for k, d in by_corner.items()}
    print(f"[Phase 9] rays per corner: {counts}", file=sys.stderr)

    # ------------------------------------------------------------------
    # Phase 10 — Robust multi-view triangulation per corner
    # ------------------------------------------------------------------
    print("[Phase 10] RANSAC + LSQ triangulation per corner ...", file=sys.stderr)
    threshold_abs = config.ransac_threshold_abs
    tri_results: dict[str, object] = {}
    for ck in CORNER_KEYS_TUPLE:
        if ck not in by_corner:
            raise RuntimeError(
                f"Phase 10: corner '{ck}' has no rays after Phase 8 ordering. (D10)"
            )
        d = by_corner[ck]
        tri = ransac_triangulate(
            origins=d["origins"],
            directions=d["directions"],
            view_idx=d["view_idx"],
            threshold_abs=threshold_abs,
            min_inliers=2,
        )
        tri_results[ck] = tri
        print(
            f"[Phase 10] {ck}: point={tuple(round(x,4) for x in tri.point)}, "
            f"inliers={tri.n_inliers}, mean_perp={tri.mean_perp_dist:.4f}, "
            f"cond={tri.condition_number:.2e}",
            file=sys.stderr,
        )

    corners_3d_dict = {ck: tri_results[ck].point for ck in CORNER_KEYS_TUPLE}  # type: ignore[union-attr]

    # ------------------------------------------------------------------
    # Phase 11 — Quality metrics + JSON output
    # ------------------------------------------------------------------
    print("[Phase 11] computing quality metrics ...", file=sys.stderr)
    n_views_total = len(coarse_cameras) + len(all_iterative_views)
    quality, warnings = compute_quality(
        corners_3d=corners_3d_dict,
        tri_results=tri_results,  # type: ignore[arg-type]
        ordered_cache=ordered_cache,
        cam_by_key=cam_by_key,
        n_views_total=n_views_total,
        n_views_selected=selection.n_selected,
        robust_bbox_diagonal=room_info.robust_bbox_diagonal,
    )
    result.quality = quality
    result.door_corners_3d = corners_3d_dict  # type: ignore[assignment]
    result.warnings = warnings
    print(
        f"[Phase 11] width={quality.estimated_width:.3f}, height={quality.estimated_height:.3f}, "
        f"ratio={quality.height_width_ratio:.3f}, "
        f"reproj={quality.mean_reprojection_error_px:.2f}px, "
        f"warnings={len(warnings)}",
        file=sys.stderr,
    )

    write_result(result, args.output_json)
    print(f"[done] result written to {args.output_json}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
