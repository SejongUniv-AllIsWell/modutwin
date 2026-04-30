"""결과 JSON dataclass.

plan v2 §11 + D1 (raw 4 points only). coplanarity_error / rectangle_error /
door_obb 필드는 의도적으로 부재.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Optional

CornerKey = str  # "left_top" | "right_top" | "left_bottom" | "right_bottom"
Vec3 = tuple[float, float, float]


@dataclass
class PerCornerScalar:
    left_top: float = 0.0
    right_top: float = 0.0
    left_bottom: float = 0.0
    right_bottom: float = 0.0


@dataclass
class PerCornerInt:
    left_top: int = 0
    right_top: int = 0
    left_bottom: int = 0
    right_bottom: int = 0


@dataclass
class QualityMetrics:
    num_views_total: int = 0
    num_views_selected: int = 0
    num_inlier_rays: PerCornerInt = field(default_factory=PerCornerInt)
    mean_point_to_ray_distance: PerCornerScalar = field(default_factory=PerCornerScalar)
    max_point_to_ray_distance: PerCornerScalar = field(default_factory=PerCornerScalar)
    mean_reprojection_error_px: float = 0.0
    estimated_width: float = 0.0
    estimated_height: float = 0.0
    height_width_ratio: float = 0.0
    condition_number_max: float = 0.0


@dataclass
class PipelineConfig:
    n_coarse: int = 32
    n_fine: int = 24
    sam3_prob: float = 0.8
    ransac_ratio: float = 0.005
    ransac_threshold_abs: float = 0.0
    robust_bbox_diagonal: float = 0.0
    world_up: tuple[float, float, float] = (0.0, 1.0, 0.0)


@dataclass
class DoorCornersResult:
    """plan v2 §11 final JSON schema. version 2.0 (raw 4-point output)."""

    source_ply: str
    door_corners_3d: dict[CornerKey, Vec3] = field(
        default_factory=lambda: {
            "left_top": (0.0, 0.0, 0.0),
            "right_top": (0.0, 0.0, 0.0),
            "left_bottom": (0.0, 0.0, 0.0),
            "right_bottom": (0.0, 0.0, 0.0),
        }
    )
    quality: QualityMetrics = field(default_factory=QualityMetrics)
    warnings: list[str] = field(default_factory=list)
    config: PipelineConfig = field(default_factory=PipelineConfig)
    version: str = "2.0"

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(asdict(self), indent=indent, ensure_ascii=False)

    def write(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as f:
            f.write(self.to_json())


def empty_result(source_ply: str) -> DoorCornersResult:
    """Phase 0의 stub용 — 빈 결과 dump 가능 여부 확인."""
    return DoorCornersResult(source_ply=source_ply)
