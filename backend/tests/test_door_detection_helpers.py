from pathlib import Path
import sys

import numpy as np
import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.door_detection.corner_extraction.quadrilateral import extract_quadrilateral
from core.door_detection.segmentation.sam3_runner import (
    _expand_variant_paths,
    _view_idx_from_path,
    list_input_pngs,
)


def test_view_idx_parses_variant_suffix() -> None:
    assert _view_idx_from_path("view_0007.png", fallback=-1) == 7
    assert _view_idx_from_path("view_0007__albedo.png", fallback=-1) == 7
    assert _view_idx_from_path("unexpected.png", fallback=99) == 99


def test_list_input_pngs_excludes_variant_siblings(tmp_path: Path) -> None:
    (tmp_path / "view_0002.png").write_bytes(b"")
    (tmp_path / "view_0001.png").write_bytes(b"")
    (tmp_path / "view_0001__albedo.png").write_bytes(b"")
    (tmp_path / "view_0001__dark_bg.png").write_bytes(b"")

    listed = list_input_pngs(str(tmp_path))

    assert listed == [
        str(tmp_path / "view_0001.png"),
        str(tmp_path / "view_0002.png"),
    ]
    assert _expand_variant_paths(str(tmp_path / "view_0001.png")) == [
        str(tmp_path / "view_0001.png"),
        str(tmp_path / "view_0001__albedo.png"),
        str(tmp_path / "view_0001__dark_bg.png"),
    ]


def test_extract_quadrilateral_recovers_noisy_rect_mask() -> None:
    cv2 = pytest.importorskip("cv2")

    mask = np.zeros((256, 256), dtype=np.uint8)
    pts = np.array([[58, 36], [184, 48], [170, 222], [44, 208]], dtype=np.int32)
    cv2.fillConvexPoly(mask, pts, 1)

    mask[112:136, 102:126] = 0
    mask[20:28, 20:28] = 1
    mask[228:232, 198:202] = 1

    quad = extract_quadrilateral(mask.astype(bool))

    assert quad is not None
    assert quad.shape == (4, 2)

    xs = quad[:, 0]
    ys = quad[:, 1]
    assert float(xs.min()) < 75.0
    assert float(xs.max()) > 155.0
    assert float(ys.min()) < 70.0
    assert float(ys.max()) > 190.0
