"""JSON 결과 + (옵션) 디버그 시각화 writer."""

from __future__ import annotations

import os

from .result_schema import DoorCornersResult


def write_result(result: DoorCornersResult, output_path: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    result.write(output_path)
