"""Phase 8 — world up + camera right 기반 LT/RT/LB/RB 정렬.

plan v2 §Phase 8 (D7: world up = (0,1,0) 고정 가정. perspective view에 robust):
  1. 4 vertex의 world ray 4개 생성 (Phase 9 ray.py 재사용)
  2. ray direction 평균 = view_dir_world
  3. camera_right_world = normalize(world_up × view_dir_world)
     view_dir이 world_up과 평행이면 view drop (방어적)
  4. camera_up_in_view_world = normalize(camera_right × view_dir_world)
  5. 각 ray dir을 (camera_right, camera_up) basis에 투영 → (rs_i, us_i)
  6. 분류:
     - 4점을 us 내림차순 정렬: 위 2개 = top, 아래 2개 = bottom
     - top 중 rs 작은 = LT, 큰 = RT
     - bottom 중 rs 작은 = LB, 큰 = RB
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from typing import Optional

import numpy as np

from ..conventions import WORLD_UP
from ..render.camera_sampler import CameraView
from ..triangulation.ray import pixel_rotate_cw_to_orig, pixel_to_world_ray


CORNER_KEYS = ("left_top", "right_top", "left_bottom", "right_bottom")


@dataclass
class OrderedCornersView:
    source: str
    view_idx: int
    left_top: tuple[float, float]
    right_top: tuple[float, float]
    left_bottom: tuple[float, float]
    right_bottom: tuple[float, float]


@dataclass
class OrderedCornersCache:
    views: list[OrderedCornersView]

    def save(self, cache_dir: str) -> str:
        os.makedirs(cache_dir, exist_ok=True)
        path = os.path.join(cache_dir, "corners_2d.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"views": [asdict(v) for v in self.views]}, f, indent=2)
        return path

    @classmethod
    def load(cls, cache_dir: str) -> "OrderedCornersCache":
        path = os.path.join(cache_dir, "corners_2d.json")
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        return cls(
            views=[
                OrderedCornersView(
                    source=v["source"],
                    view_idx=v["view_idx"],
                    left_top=tuple(v["left_top"]),
                    right_top=tuple(v["right_top"]),
                    left_bottom=tuple(v["left_bottom"]),
                    right_bottom=tuple(v["right_bottom"]),
                )
                for v in d["views"]
            ]
        )


def order_corners(
    quad_2d: np.ndarray,
    camera: CameraView,
    parallel_threshold: float = 0.95,
) -> Optional[dict[str, tuple[float, float]]]:
    """4-vertex quad (4, 2)를 image-space (90° CW 저장 이미지) 기준 LT/RT/LB/RB 분류.

    Stored 이미지가 90° CW 회전되어 있어 사람이 보는 직립 view와 일치.
    Camera orientation/pitch와 무관하게 image-space에서 직접 정렬:
      - 작은 v (row) = 위쪽 = top
      - 큰 v = 아래쪽 = bottom
      - 작은 u (col) = 왼쪽 = left
      - 큰 u = 오른쪽 = right

    Args:
        quad_2d: (4, 2) 저장 이미지 픽셀 좌표.
        camera: CameraView (호환성 위해 받지만 image-space 정렬에선 미사용).
        parallel_threshold: 호환성 위해 유지 (사용 안 됨).

    Returns:
        {label: (u, v)} 또는 None (동률로 분류 불가).
    """
    if quad_2d.shape != (4, 2):
        raise ValueError(f"quad_2d must be (4, 2), got {quad_2d.shape}")

    # Image-space 정렬: 행(v) 기준 top-2, bot-2 → 각 그룹 내 col(u) 기준 left/right
    by_v = np.argsort(quad_2d[:, 1])  # ascending v
    top_idx = by_v[:2].tolist()
    bot_idx = by_v[2:].tolist()

    # 동률 검사: top과 bot의 v 차이가 너무 작으면 분류 위험 → drop
    v_sorted = np.sort(quad_2d[:, 1])
    if v_sorted[2] - v_sorted[1] < 1.0:  # < 1px 차이
        return None

    top_sorted = sorted(top_idx, key=lambda i: quad_2d[i, 0])
    LT, RT = top_sorted
    bot_sorted = sorted(bot_idx, key=lambda i: quad_2d[i, 0])
    LB, RB = bot_sorted

    # u 동률 검사
    if abs(quad_2d[LT, 0] - quad_2d[RT, 0]) < 1.0 or abs(quad_2d[LB, 0] - quad_2d[RB, 0]) < 1.0:
        return None

    out: dict[str, tuple[float, float]] = {
        "left_top": (float(quad_2d[LT, 0]), float(quad_2d[LT, 1])),
        "right_top": (float(quad_2d[RT, 0]), float(quad_2d[RT, 1])),
        "left_bottom": (float(quad_2d[LB, 0]), float(quad_2d[LB, 1])),
        "right_bottom": (float(quad_2d[RB, 0]), float(quad_2d[RB, 1])),
    }
    return out


def order_all_selected(
    selection,  # ViewSelection (avoid circular import)
    cam_by_key: dict[tuple[str, int], CameraView],
    cache_dir: Optional[str] = None,
    quadrilateral_kwargs: Optional[dict] = None,
    min_views: int = 2,
) -> OrderedCornersCache:
    """selected_views의 각 view에 대해 mask → quad → ordering 일괄 처리.

    Phase 7 (extract_quadrilateral) + Phase 8 (order_corners) 체이닝.
    실패하는 view는 skip (D11 drop).

    Args:
        selection: ViewSelection 객체.
        cam_by_key: {(source, view_idx): CameraView}.
        cache_dir: corners_2d.json 저장 경로.
        quadrilateral_kwargs: extract_quadrilateral 파라미터 override.

    Returns:
        OrderedCornersCache.

    Raises:
        RuntimeError: 모든 view가 quad/ordering 실패 (D10).
    """
    from PIL import Image

    from .quadrilateral import extract_quadrilateral

    qkw = quadrilateral_kwargs or {}
    out_views: list[OrderedCornersView] = []

    for s in selection.selected:
        cam = cam_by_key[(s.source, s.view_idx)]
        mask_arr = np.asarray(Image.open(s.mask_path).convert("L")) > 127
        quad = extract_quadrilateral(mask_arr, **qkw)
        if quad is None:
            continue
        ordered = order_corners(quad, cam)
        if ordered is None:
            continue
        out_views.append(
            OrderedCornersView(
                source=s.source,
                view_idx=s.view_idx,
                left_top=ordered["left_top"],
                right_top=ordered["right_top"],
                left_bottom=ordered["left_bottom"],
                right_bottom=ordered["right_bottom"],
            )
        )

    cache = OrderedCornersCache(views=out_views)
    if cache_dir:
        cache.save(cache_dir)

    if len(out_views) < min_views:
        raise RuntimeError(
            f"Phase 8: only {len(out_views)}/{min_views} views passed quad+ordering. "
            f"PLY/render/SAM3/quad 품질 점검. (D10 fail-fast)"
        )
    return cache
