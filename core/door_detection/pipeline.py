"""Door 3D Corner detection pipeline — CLI entry.

plan v2 §Phase 0 scaffolding. 각 phase 구현은 후속 작업.

Usage:
    python -m core.door_detection.pipeline \
        --ply path/to/scene.ply \
        --output_json path/to/door_corners.json \
        [--cache_dir path/to/cache] \
        [--n_coarse 32] [--n_fine 24] \
        [--sam3_prob 0.8] \
        [--debug]
"""

from __future__ import annotations

import argparse
import os
import sys
import time

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
    CameraView,
    sample_coarse_cameras,
    sample_walk_cameras,
    sample_wall_facing_cameras,
    save_cameras,
)
from .render.splat_renderer import render_views
from .room.interior import (
    build_room_info_known,
    estimate_eye_height_y,
    estimate_room,
)
from .room.frame import bake_rotation_matrix
from .room.wall_planes import build_wall_planes, ray_wall_hit, pick_door_wall


from .segmentation.sam3_runner import list_input_pngs, run_sam3
from .view_selection.iterative_approach import run_iterative_approach, analyze_mask_quad, IterativeView
from .view_selection.filter import SelectedView, ViewSelection
from .corner_extraction.ordering import order_all_selected
from .corner_extraction.multi_door import extract_n_doors
from .triangulation.ray import (
    Ray,
    pixel_rotate_cw_to_orig,
    pixel_to_world_ray,
    save_rays_npz,
    stack_rays_by_corner,
)
from .triangulation.ransac import TriangulationResult
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
    p.add_argument(
        "--eye_height_ratio",
        type=float,
        default=None,
        help="walk 모드 카메라 Y 를 floor~ceiling 거리 비율로 지정 "
             "(예: 0.7 → 바닥에서 70%%, 천장에서 30%% 지점). "
             "--eye_height (절대 m) 대신 사용. --eye_height_abs 지정 시 무시.",
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

    # Room interior gate (Phase 1)
    p.add_argument(
        "--interior_min_hits",
        type=int,
        default=22,
        help="Phase 1 interior gate: 26-ray 중 최소 hit 수 (default 22). "
             "길거나 비볼록한 방은 낮추면 통과 가능 (대신 부정확 room 추정 위험).",
    )
    p.add_argument(
        "--interior_perp_ratio",
        type=float,
        default=0.01,
        help="interior ray perp threshold = robust_bbox_diagonal * ratio (default 0.01). "
             "키우면 레이가 더 먼 점도 hit 으로 인정.",
    )
    p.add_argument(
        "--no_interior_strict",
        dest="interior_strict",
        action="store_false",
        default=True,
        help="interior gate 미달이어도 fail-fast 하지 않고 경고만 하고 계속 진행.",
    )

    # 방법 B — 다듬기에서 확정된 A' 프레임 천장/바닥 활용 (known-room mode)
    p.add_argument(
        "--rot_x", type=float, default=None,
        help="raw→A' 정렬 회전 X (rad). --rot_z/--floor_y/--ceiling_y 와 함께 주면 "
             "추론을 A' 프레임에서 수행 (천장/바닥 추정 대신 확정값 사용).",
    )
    p.add_argument("--rot_z", type=float, default=None, help="raw→A' 정렬 회전 Z (rad).")
    p.add_argument("--floor_y", type=float, default=None, help="A' 프레임 바닥 Y (확정값).")
    p.add_argument("--ceiling_y", type=float, default=None, help="A' 프레임 천장 Y (확정값).")
    p.add_argument(
        "--wall_polygon", type=str, default=None,
        help="A' 프레임 방 footprint 폴리곤 JSON: '[[x,z],...]' 또는 '[{\"x\":..,\"z\":..},..]'. "
             "known-room + 이 값이 있으면 중앙 disk 대신 벽-정면 카메라로 coarse 샘플링.",
    )

    p.add_argument(
        "--render_size",
        type=int,
        default=256,
        help="렌더 이미지 해상도 (width=height, default 256). 낮출수록 렌더 속도 상승.",
    )
    p.add_argument(
        "--standoff_scale",
        type=float,
        default=1.2,
        help="wall-facing 카메라 standoff 배율 (default 1.2 = 20%% 더 멀리). "
             "1.0 = 기존 계산값 그대로.",
    )
    p.add_argument("--device", type=str, default="cuda", help="compute device")
    p.add_argument("--debug", action="store_true", help="debug 시각화 저장")

    return p


def _parse_wall_polygon(raw: str | None):
    """'[[x,z],...]' 또는 '[{"x":..,"z":..},...]' → (N,2) np.array (A' X-Z). 실패 시 None."""
    if not raw:
        return None
    import json as _json

    import numpy as _np
    try:
        data = _json.loads(raw)
        pts = []
        for it in data:
            if isinstance(it, dict):
                pts.append([float(it["x"]), float(it["z"])])
            else:
                pts.append([float(it[0]), float(it[1])])
        arr = _np.asarray(pts, dtype=_np.float64)
        if arr.ndim != 2 or arr.shape[0] < 3 or arr.shape[1] != 2:
            return None
        return arr
    except Exception:
        return None


def _resolve_cache_dir(args: argparse.Namespace) -> str:
    if args.cache_dir is not None:
        return args.cache_dir
    return os.path.join(os.path.dirname(os.path.abspath(args.output_json)), "cache")


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    cache_dir = _resolve_cache_dir(args)

    # Phase 타이머
    _t_pipeline_start = time.perf_counter()
    _t_phase: dict[str, float] = {}

    def _tick(phase: str) -> None:
        """Phase 시작 시 호출 — 직전 Phase 경과 시간 출력 후 새 Phase 시작."""
        now = time.perf_counter()
        if _t_phase:
            prev_phase, prev_t = next(reversed(_t_phase.items())), list(_t_phase.values())[-1]
            prev_name = list(_t_phase.keys())[-1]
            elapsed = now - prev_t
            print(f"[Timer] {prev_name} → {elapsed:.1f}s", file=sys.stderr)
        _t_phase[phase] = now

    def _tock() -> None:
        """파이프라인 종료 시 마지막 Phase + 전체 시간 출력."""
        now = time.perf_counter()
        if _t_phase:
            elapsed = now - list(_t_phase.values())[-1]
            print(f"[Timer] {list(_t_phase.keys())[-1]} → {elapsed:.1f}s", file=sys.stderr)
        total = now - _t_pipeline_start
        summary = "  ".join(f"{k} {v:.1f}s" for k, v in
                            zip(list(_t_phase.keys()), [list(_t_phase.values())[i+1] - t
                                if i+1 < len(_t_phase) else now - t
                                for i, t in enumerate(_t_phase.values())]))
        print(f"[Timer] total {total:.1f}s | {summary}", file=sys.stderr)
    os.makedirs(cache_dir, exist_ok=True)

    config = PipelineConfig(
        n_coarse=args.n_coarse,
        n_fine=args.n_fine,
        sam3_prob=args.sam3_prob,
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
    print("=" * 60, file=sys.stderr)

    result = empty_result(source_ply=args.ply)
    result.config = config

    import numpy as np

    # 방법 B — 다듬기에서 확정된 A' 프레임 천장/바닥 활용 여부.
    # 추론(방 추정·카메라 배치·ray)을 A' 에서 하고, 렌더만 cam_rot 으로 raw 가우시안에.
    known_room = (
        args.rot_x is not None and args.rot_z is not None
        and args.floor_y is not None and args.ceiling_y is not None
    )
    cam_rot = None        # 렌더 시 A'→raw (Rᵀ). known-room 에서만 설정.
    means_ap = None       # A' 프레임 means (opacity 필터). known-room 에서만.
    # 방 footprint 폴리곤 (A'). 있으면 벽-정면 카메라 + ray∩벽평면 코너 추출.
    wall_poly = _parse_wall_polygon(args.wall_polygon) if known_room else None
    # A' 프레임은 Z-180 컨벤션상 +Y 가 시각적 '아래'(중력 down) — CLAUDE.md "ceiling(PLY+Y)=화면 바닥".
    # 따라서 시각 바닥(문 하단이 닿는 면) = floor/ceiling 중 큰 Y, 시각 천장 = 작은 Y.
    real_floor_y = max(float(args.floor_y), float(args.ceiling_y)) if known_room else None
    real_ceiling_y = min(float(args.floor_y), float(args.ceiling_y)) if known_room else None

    # ------------------------------------------------------------------
    _tick("Phase1")
    # Phase 1 — Room interior estimation (or known-room from refine)
    # ------------------------------------------------------------------
    if known_room:
        print(
            f"[Phase 1] known-room mode: rotX={args.rot_x:.4f} rotZ={args.rot_z:.4f} "
            f"floorY={args.floor_y:.3f} ceilingY={args.ceiling_y:.3f}",
            file=sys.stderr,
        )
        rot_raw_to_ap = bake_rotation_matrix(args.rot_x, args.rot_z)  # raw→A'
        cam_rot = rot_raw_to_ap.T                                     # A'→raw (렌더용)
        _splats0 = load_ply(args.ply)
        _means_raw = np.asarray(_splats0["means"], dtype=np.float64)
        _opac0 = np.asarray(_splats0["opacities"], dtype=np.float64)
        del _splats0
        _keep0 = (1.0 / (1.0 + np.exp(-_opac0))) >= 0.1
        means_ap = _means_raw[_keep0] @ rot_raw_to_ap.T              # raw→A', opacity 필터
        del _means_raw, _opac0, _keep0
        room_info = build_room_info_known(
            means_ap=means_ap,
            floor_y=float(args.floor_y),
            ceiling_y=float(args.ceiling_y),
        )
        room_info.save(cache_dir)
    else:
        print("[Phase 1] estimating room interior ...", file=sys.stderr)
        room_info = estimate_room(
            ply_path=args.ply,
            cache_dir=cache_dir,
            interior_perp_ratio=args.interior_perp_ratio,
            interior_min_hits=args.interior_min_hits,
            strict=args.interior_strict,
        )
    print(
        f"[Phase 1] center={tuple(round(v, 4) for v in room_info.room_center)} "
        f"diag={room_info.robust_bbox_diagonal:.4f} "
        f"min_half={room_info.min_half_extent:.4f} "
        f"interior_hits={room_info.interior_hits_26}/26",
        file=sys.stderr,
    )
    config.robust_bbox_diagonal = room_info.robust_bbox_diagonal
    result.config = config

    # ------------------------------------------------------------------
    # Phase 2 — Coarse view generation (sphere inside room) + RGB render
    # ------------------------------------------------------------------
    _tick("Phase2-render")
    print("[Phase 2] sampling coarse cameras + rendering ...", file=sys.stderr)
    coarse_dir = os.path.join(cache_dir, "coarse")
    coarse_renders_dir = os.path.join(coarse_dir, "renders")

    if args.camera_mode == "walk":
        n_yaw = max(1, args.n_coarse // args.n_walk_positions)

        # walk: 수평 half-extent (X-Z) 사용. 천장 높이 제약 무관.
        bx = room_info.robust_bbox_max[0] - room_info.robust_bbox_min[0]
        bz = room_info.robust_bbox_max[2] - room_info.robust_bbox_min[2]
        horizontal_half = float(min(bx, bz) / 2.0)

        # air-space 검사를 위해 means (opacity 필터). known-room 은 A' means 재사용.
        if means_ap is not None:
            means_air = means_ap
        else:
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
        elif known_room:
            # ratio: 시각 바닥에서 시각 천장 쪽으로의 비율. 0.9 = 천장에 가깝게.
            # (시각 천장 = real_ceiling_y. A' Y 부호 함정 보정됨.)
            ratio = args.eye_height_ratio if args.eye_height_ratio is not None else 0.7
            eye_y = float(real_floor_y + ratio * (real_ceiling_y - real_floor_y))
            print(
                f"[Phase 2] eye_height_Y={eye_y:.3f} (known-room ratio={ratio}, "
                f"visual floor={real_floor_y:.3f}→ceiling={real_ceiling_y:.3f})",
                file=sys.stderr,
            )
        else:
            eye_y = estimate_eye_height_y(
                means=means_air,
                bbox_min_y=float(room_info.robust_bbox_min[1]),
                bbox_max_y=float(room_info.robust_bbox_max[1]),
                eye_height_m=args.eye_height,
                eye_height_ratio=args.eye_height_ratio,
            )
            _mode = (
                f"ratio={args.eye_height_ratio}"
                if args.eye_height_ratio is not None
                else f"floor+{args.eye_height}m"
            )
            print(
                f"[Phase 2] eye_height_Y={eye_y:.3f} ({_mode}) "
                f"(bbox_Y [{room_info.robust_bbox_min[1]:.2f}, "
                f"{room_info.robust_bbox_max[1]:.2f}])",
                file=sys.stderr,
            )

        if wall_poly is not None:
            # 벽-정면 커버리지: 방 모든 벽을 정면으로 (중앙 disk 갇힘 해소).
            coarse_cameras, horizontal_half = sample_wall_facing_cameras(
                polygon_xz=wall_poly,
                floor_y=float(args.floor_y),
                ceiling_y=float(args.ceiling_y),
                eye_y=eye_y,
                means_for_air=means_air,
                n_total=args.n_coarse,
                fov_x_deg=60.0,
                air_radius=args.air_radius,
                air_max_count=args.air_max_count,
                width=args.render_size,
                height=args.render_size,
                standoff_scale=args.standoff_scale,
            )
            r_coarse = horizontal_half
            meta = {
                "mode": "wall_facing",
                "n_walls": int(wall_poly.shape[0]),
                "horizontal_half_extent": horizontal_half,
                "eye_height_y": eye_y,
                "fov_x_deg": 60.0,
                "n_views": len(coarse_cameras),
            }
            print(
                f"[Phase 2] wall-facing mode: {len(coarse_cameras)} cameras over "
                f"{wall_poly.shape[0]} walls, eye_y={eye_y:.3f}, half_extent={horizontal_half:.3f}",
                file=sys.stderr,
            )
        else:
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
                width=args.render_size,
                height=args.render_size,
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
            width=args.render_size,
            height=args.render_size,
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
    saved_pngs = render_views(
        splats, coarse_cameras, coarse_renders_dir, device=args.device, cam_rot=cam_rot
    )
    print(f"[Phase 2] rendered {len(saved_pngs)} PNGs to {coarse_renders_dir}", file=sys.stderr)

    # 메모리 회수
    del splats

    # ------------------------------------------------------------------
    # Phase 3 — SAM3 first pass (confidence ≥ 0.8, D2)
    # ------------------------------------------------------------------
    _tick("Phase3-SAM3")
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
    # N-door 경로 (기본): coarse 인접 클러스터링으로 문 개수 자동 검출.
    #   클러스터가 0개면(드묾) 아래 legacy iterative 단일-문 경로로 fallback.
    # ------------------------------------------------------------------
    if wall_poly is not None:
        _tick("Phase4-11-ndoor")
        print("[N-door] cluster extraction (auto door count) ...", file=sys.stderr)

        _coarse_cam_map_nd = {c.view_idx: c for c in coarse_cameras}
        _cam_by_key_nd: dict = {("coarse", c.view_idx): c for c in coarse_cameras}
        _nd_walls = build_wall_planes(wall_poly, float(args.floor_y), float(args.ceiling_y))

        door_structures = extract_n_doors(
            sam3_summary=sam3_summary,
            coarse_cam_map=_coarse_cam_map_nd,
            cam_by_key=_cam_by_key_nd,
            walls=_nd_walls,
            real_floor_y=float(real_floor_y),
            pixel_rotate_fn=pixel_rotate_cw_to_orig,
            pixel_to_ray_fn=pixel_to_world_ray,
            ray_hit_fn=ray_wall_hit,
        )

        if door_structures:
            print(
                f"[N-door] {len(door_structures)} door(s) auto-detected: "
                + ", ".join(f"v{d.src_view_idx}({d.mode})" for d in door_structures),
                file=sys.stderr,
            )
            primary = door_structures[0]
            result.door_corners_3d = primary.corners  # type: ignore[assignment]
            # suggested_hinge_edge 포함 — 프론트에서 hinge 자동 적용에 사용.
            result.all_doors = [
                {**d.corners, "suggested_hinge_edge": d.suggested_hinge_edge}
                for d in door_structures
            ]
            result.warnings = []

            _tock()
            write_result(result, args.output_json)
            print(f"[done] result written to {args.output_json}", file=sys.stderr)
            return 0

        # 클러스터 0개 → legacy iterative 단일-문 경로로 fallback
        print("[N-door] 0 structures — falling back to iterative single-door path", file=sys.stderr)

    # ------------------------------------------------------------------
    # Phase 4-6 — Iterative door approach (legacy 단일 문 fallback 경로)
    #   - coarse 뷰에서 이미 4코너 보이면 iterative 전체 skip (SAM3 재로딩 불필요)
    #   - 없으면 top-3 후보 접근 반복
    # ------------------------------------------------------------------
    _tick("Phase4-6-iterative")
    print("[Phase 4-6] iterative door approach ...", file=sys.stderr)

    # ── coarse fast-path: 4코너 다 보이는 뷰가 이미 있으면 iterative skip ──
    from PIL import Image as _PILImage
    _coarse_cam_map = {c.view_idx: c for c in coarse_cameras}
    _fast_views: list[IterativeView] = []
    for _v in sorted(sam3_summary["views"], key=lambda x: -(x.get("max_score") or 0)):
        if not _v.get("mask_path"):
            continue
        _cam = _coarse_cam_map.get(_v["view_idx"])
        if _cam is None:
            continue
        _mask = np.asarray(_PILImage.open(_v["mask_path"]).convert("L")) > 127
        _m = analyze_mask_quad(_mask, img_size=_cam.w)
        if _m is None or not _m.all_corners_visible:
            continue
        _fast_views.append(IterativeView(
            camera=_cam,
            render_path="",
            mask_path=_v["mask_path"],
            score=float(_v["max_score"]),
            coverage=float(_m.coverage),
            h_ratio=float(_m.h_ratio),
            v_ratio=float(_m.v_ratio),
            all_corners_visible=True,
            iteration=0,
            candidate_rank=0,
        ))

    if _fast_views:
        # 4코너 보이는 coarse 뷰로 바로 확정 — iterative 전체 skip
        all_iterative_views = _fast_views
        _sel_views = [
            SelectedView(source="coarse", view_idx=iv.camera.view_idx,
                         score=iv.score, mask_path=iv.mask_path,
                         mask_area_ratio=iv.coverage)
            for iv in _fast_views
        ]
        selection = ViewSelection(selected=_sel_views, rejected=[],
                                  n_selected=len(_sel_views), n_rejected=0)
        iterative_cam_by_key: dict = {}
        print(
            f"[Phase 4-6] SKIP iterative — {len(_fast_views)} coarse view(s) already "
            f"show all 4 corners (best score={_fast_views[0].score:.3f})",
            file=sys.stderr,
        )
    else:
        iterative_dir = os.path.join(cache_dir, "iterative")
        splats = load_ply(args.ply)
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
            cam_rot=cam_rot,
            require_all_corners=wall_poly is None,
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
    _tick("Phase7+8-quad")
    print("[Phase 7+8] extracting quadrilaterals + ordering corners ...", file=sys.stderr)
    cam_by_key: dict = {("coarse", c.view_idx): c for c in coarse_cameras}
    cam_by_key.update(iterative_cam_by_key)
    ordered_cache = order_all_selected(
        selection=selection,
        cam_by_key=cam_by_key,
        cache_dir=cache_dir,
        min_views=1 if wall_poly is not None else 2,
    )
    print(
        f"[Phase 7+8] {len(ordered_cache.views)}/{selection.n_selected} views "
        f"survived quad+ordering",
        file=sys.stderr,
    )

    # ------------------------------------------------------------------
    # Phase 9 — World-space ray generation (4 corners × N views)
    # ------------------------------------------------------------------
    _tick("Phase9-11-rays+corners")
    print("[Phase 9] generating world-space rays ...", file=sys.stderr)
    all_rays: list[Ray] = []
    CORNER_KEYS_TUPLE = ("left_top", "right_top", "left_bottom", "right_bottom")
    for ov in ordered_cache.views:
        cam = cam_by_key[(ov.source, ov.view_idx)]
        K_arr = np.asarray(cam.K, dtype=np.float64)
        c2w_arr = np.asarray(cam.c2w, dtype=np.float64)
        img_size = cam.w
        for ck in CORNER_KEYS_TUPLE:
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
    # Phase 10 — corner 3D 산출
    # ------------------------------------------------------------------
    tri_results: dict[str, object] = {}
    if wall_poly is not None:
        print("[Phase 10] ray ∩ wall-plane corner extraction ...", file=sys.stderr)
        walls = build_wall_planes(wall_poly, float(args.floor_y), float(args.ceiling_y))

        def _rays_of(ck: str):
            d = by_corner.get(ck)
            if d is None:
                return []
            return list(zip(d["origins"], d["directions"]))

        top_rays = _rays_of("left_top") + _rays_of("right_top")
        wall_idx = pick_door_wall(top_rays, walls)
        if wall_idx is None:
            raise RuntimeError(
                "Phase 10: 문이 놓인 벽 평면을 찾지 못함 (상단 ray 가 어느 벽도 유효 교차 안 함). (D10)"
            )
        door_wall = walls[wall_idx]

        # 4코너 보이는 best view 탐색:
        # ordered_cache.views 는 all_corners_visible DESC 로 정렬된 good view 들 중
        # quad+ordering 통과한 것. 같은 정렬 순서를 유지하므로 앞 쪽이 best.
        # all_iterative_views 에서 (source, view_idx) → all_corners_visible 매핑 구성.
        _all_vis_map: dict[tuple, bool] = {
            ("coarse" if v.iteration == 0 else "iterative", v.camera.view_idx): v.all_corners_visible
            for v in all_iterative_views
        }
        best_4corner_ov = next(
            (ov for ov in ordered_cache.views if _all_vis_map.get((ov.source, ov.view_idx), False)),
            None,
        )
        has_4corner_view = best_4corner_ov is not None

        def _single_view_hit(ov, ck: str):
            """단일 뷰 픽셀 → ray → 벽 교점. 교점 없으면 None."""
            cam = cam_by_key[(ov.source, ov.view_idx)]
            u_s, v_s = getattr(ov, ck)
            u_o, v_o = pixel_rotate_cw_to_orig(u_s, v_s, cam.w)
            r = pixel_to_world_ray(u_o, v_o, np.asarray(cam.K, dtype=np.float64),
                                   np.asarray(cam.c2w, dtype=np.float64))
            return ray_wall_hit(r.origin, r.direction, door_wall)

        def _corner_on_wall_avg(ck: str):
            """다중 뷰 ray → 벽 교점 평균 (상단 2코너 전용)."""
            pts = [p for (o, dr) in _rays_of(ck)
                   if (p := ray_wall_hit(o, dr, door_wall)) is not None]
            return np.mean(np.stack(pts, axis=0), axis=0) if pts else None

        floor_y = float(real_floor_y)

        if has_4corner_view:
            # ── 4코너 보이는 best single view: 각 코너 ray 1개로 즉시 확정 ──
            tl = _single_view_hit(best_4corner_ov, "left_top")
            tr = _single_view_hit(best_4corner_ov, "right_top")
            bl = _single_view_hit(best_4corner_ov, "left_bottom")
            br = _single_view_hit(best_4corner_ov, "right_bottom")
            if tl is None or tr is None:
                raise RuntimeError("Phase 10: 4코너 best view 상단 교점 실패. (D10)")
            # 하단도 교점 실패 시에만 floorY fallback (정상이면 실제 교점 사용)
            bottom_source = f"single-view (v{best_4corner_ov.view_idx})"
            if bl is None or br is None:
                bl = np.array([tl[0], floor_y, tl[2]], dtype=np.float64)
                br = np.array([tr[0], floor_y, tr[2]], dtype=np.float64)
                bottom_source += f" + floorY={floor_y:.3f} fallback"
        else:
            # ── 상단 2코너만 보임: 다중 뷰 평균으로 상단 확정,
            #    하단은 ray 없이 바로 상단 XZ → floorY 수직 하강 ──
            tl = _corner_on_wall_avg("left_top")
            tr = _corner_on_wall_avg("right_top")
            if tl is None or tr is None:
                raise RuntimeError("Phase 10: 상단 코너 ray∩벽평면 교점 실패. (D10)")
            bl = np.array([tl[0], floor_y, tl[2]], dtype=np.float64)
            br = np.array([tr[0], floor_y, tr[2]], dtype=np.float64)
            bottom_source = f"top-2-only → floorY={floor_y:.3f}"

        corners_3d_dict = {
            "left_top": tuple(float(x) for x in tl),
            "right_top": tuple(float(x) for x in tr),
            "left_bottom": tuple(float(x) for x in bl),
            "right_bottom": tuple(float(x) for x in br),
        }
        for ck in CORNER_KEYS_TUPLE:
            tri_results[ck] = TriangulationResult(
                point=corners_3d_dict[ck], inlier_view_idx=[], n_inliers=1,
                mean_perp_dist=0.0, max_perp_dist=0.0, condition_number=1.0,
            )
        print(
            f"[Phase 10] wall #{wall_idx} | {'4-corner' if has_4corner_view else 'top-2'} mode | "
            f"TL={tuple(round(x,3) for x in tl)} TR={tuple(round(x,3) for x in tr)} | "
            f"BL={tuple(round(x,3) for x in bl)} ({bottom_source})",
            file=sys.stderr,
        )
    else:
        # RANSAC 삼각측량 경로 제거됨. 코너 확정은 known-room (wall_polygon) 기반
        # ray∩벽평면 모드(4코너 single-view / top-2 다중뷰 평균)만 지원한다.
        # wall_polygon 없이는 문 추출 실패로 처리한다.
        raise RuntimeError(
            "Phase 10: wall_polygon(known-room) 없이는 문 코너를 확정할 수 없습니다. "
            "rot_x/rot_z/floor_y/ceiling_y/wall_polygon 을 제공하세요. (D10 fail-fast)"
        )

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
    _tock()
    print(f"[done] result written to {args.output_json}", file=sys.stderr)
    return 0


def _normalize_wall_polygon_ap(raw) -> np.ndarray:
    """A' 폴리곤 입력(list[[x,z]] 또는 list[{x,z}])을 (N,2) ndarray 로."""
    import numpy as np
    if raw is None:
        raise ValueError("wall_polygon (A') 가 필요합니다 (known-room).")
    pts = []
    for p in raw:
        if isinstance(p, dict):
            pts.append([float(p["x"]), float(p["z"])])
        else:
            pts.append([float(p[0]), float(p[1])])
    arr = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    if arr.shape[0] < 3:
        raise ValueError(f"wall_polygon 점 수 부족: {arr.shape[0]}")
    return arr


def _identity_pixel(u: float, v: float, img_size: int = 0) -> tuple[float, float]:
    """prerendered(클라 upright 캡처) 픽셀 매핑 — vflip 없이 항등.

    서버 렌더 경로는 np.flipud 저장이라 pixel_rotate_cw_to_orig 가 필요하지만,
    브라우저 canvas 캡처는 이미 OpenCV 픽셀 규약(top-left 원점, +v 아래)이므로 변환 없음.
    """
    return float(u), float(v)


def run_from_prerendered(
    renders_dir: str,
    views_meta: list[dict],
    rot_x: float,
    rot_z: float,
    floor_y: float,
    ceiling_y: float,
    wall_polygon,
    output_json: str,
    prompt: str = "white door",
    sam3_prob: float = 0.55,
    device: str = "cuda",
    sam3_checkpoint: str | None = None,
) -> int:
    """클라이언트 렌더 PNG + 카메라 포즈(raw OpenCV c2w) + A' 방기하 → 문 코너.

    서버 렌더(Phase 0~2)를 건너뛰고, known-room N-door 경로(Phase 3 SAM3 + extract_n_doors)
    만 수행한다. 카메라/ray 는 raw→A' 로 변환해 A' 벽 평면과 교차한다.

    views_meta: [{ "idx": int, "K": 3x3, "c2w": 4x4(raw OpenCV cam→world), "w": int, "h": int }]
    wall_polygon: A' 프레임 footprint (list[[x,z]] 또는 list[{x,z}]).
    """
    import numpy as np
    wall_poly_ap = _normalize_wall_polygon_ap(wall_polygon)

    # raw→A' 회전 (translation 없음, 원점 기준 순수 회전).
    rot_raw_to_ap = bake_rotation_matrix(float(rot_x), float(rot_z))  # 3x3
    T_raw_to_ap = np.eye(4, dtype=np.float64)
    T_raw_to_ap[:3, :3] = rot_raw_to_ap

    # 클라 카메라(raw OpenCV c2w) → A' 프레임 CameraView.
    cams: list[CameraView] = []
    for vm in views_meta:
        K = np.asarray(vm["K"], dtype=np.float64).reshape(3, 3)
        c2w_raw = np.asarray(vm["c2w"], dtype=np.float64).reshape(4, 4)
        c2w_ap = T_raw_to_ap @ c2w_raw
        pos = c2w_ap[:3, 3]
        fwd = c2w_ap[:3, 2]  # OpenCV forward = +z 열
        look = pos + fwd
        w = int(vm.get("w") or vm.get("width") or 256)
        h = int(vm.get("h") or vm.get("height") or 256)
        cams.append(CameraView(
            view_idx=int(vm["idx"]),
            K=K.tolist(),
            c2w=c2w_ap.tolist(),
            w=w,
            h=h,
            position=(float(pos[0]), float(pos[1]), float(pos[2])),
            look_at=(float(look[0]), float(look[1]), float(look[2])),
            source="coarse",
            wall_idx=-1,
        ))
    if not cams:
        raise RuntimeError("prerendered: 카메라/뷰가 없습니다.")
    cams.sort(key=lambda c: c.view_idx)

    # 시각 바닥/천장 (A' Z-180 Y 부호 보정: 큰 Y = 시각 바닥).
    real_floor_y = max(float(floor_y), float(ceiling_y))

    result = empty_result(source_ply=renders_dir)
    result.config = PipelineConfig(
        n_coarse=len(cams), n_fine=0, sam3_prob=float(sam3_prob),
        robust_bbox_diagonal=0.0,
    )

    # Phase 3 — SAM3 (검증된 경로). renders_dir 의 PNG 들 입력.
    image_paths = list_input_pngs(renders_dir)
    if not image_paths:
        raise RuntimeError(f"prerendered: 렌더 PNG 없음 ({renders_dir})")
    sam3_out_dir = os.path.dirname(os.path.abspath(renders_dir.rstrip("/")))
    sam3_summary = run_sam3(
        image_paths=image_paths,
        output_subdir=sam3_out_dir,
        prompt=prompt,
        confidence_threshold=float(sam3_prob),
        device=device,
        checkpoint_path=sam3_checkpoint,
    )
    print(
        f"[prerendered] SAM3 {sam3_summary['n_views_with_detection']}/"
        f"{sam3_summary['n_total_views']} views detected (prob ≥ {sam3_prob})",
        file=sys.stderr,
    )
    if sam3_summary["n_views_with_detection"] == 0:
        raise RuntimeError("prerendered: SAM3 검출 0건 (렌더 품질/프롬프트 확인). (D10)")

    # known-room N-door 코너 추출 (Phase 4~11 대체). 픽셀 매핑은 항등(upright).
    coarse_cam_map = {c.view_idx: c for c in cams}
    cam_by_key = {("coarse", c.view_idx): c for c in cams}
    walls = build_wall_planes(wall_poly_ap, float(floor_y), float(ceiling_y))

    door_structures = extract_n_doors(
        sam3_summary=sam3_summary,
        coarse_cam_map=coarse_cam_map,
        cam_by_key=cam_by_key,
        walls=walls,
        real_floor_y=float(real_floor_y),
        pixel_rotate_fn=_identity_pixel,
        pixel_to_ray_fn=pixel_to_world_ray,
        ray_hit_fn=ray_wall_hit,
    )
    if not door_structures:
        raise RuntimeError("prerendered: 문 클러스터 0개. (D10)")

    primary = door_structures[0]
    result.door_corners_3d = primary.corners  # type: ignore[assignment]
    result.all_doors = [
        {**d.corners, "suggested_hinge_edge": d.suggested_hinge_edge}
        for d in door_structures
    ]
    result.warnings = []
    print(
        f"[prerendered] {len(door_structures)} door(s): "
        + ", ".join(f"v{d.src_view_idx}({d.mode})" for d in door_structures),
        file=sys.stderr,
    )
    write_result(result, output_json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
