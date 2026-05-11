"""좌표/카메라/이미지/quaternion 컨벤션 단일 정의.

이 파일을 import하지 않고 좌표/축 정의를 직접 쓰는 것 금지.
plan v2 §1 참조.
"""

from __future__ import annotations

import numpy as np

# ---------------------------------------------------------------------------
# World frame
# ---------------------------------------------------------------------------

# World up axis. PLY가 Y-up 정렬되어 있다는 가정 (plan v2 D7).
# 정렬이 어긋나면 corner ordering 라벨이 뒤집혀 사용자가 즉시 인지하도록 둠.
WORLD_UP: np.ndarray = np.array([0.0, 1.0, 0.0], dtype=np.float64)

# ---------------------------------------------------------------------------
# Camera convention
# ---------------------------------------------------------------------------
#
# Extrinsic은 OpenCV convention의 world-to-camera [R | t]를 표준으로 한다.
# gsplat 내부는 cam-to-world 행렬을 받으므로 변환 함수 사용.
#
#   x_cam = R @ x_world + t
#   c2w   = inv([[R, t], [0, 1]])
#

def w2c_to_c2w(w2c: np.ndarray) -> np.ndarray:
    """world-to-camera 4x4 -> cam-to-world 4x4."""
    if w2c.shape != (4, 4):
        raise ValueError(f"w2c must be 4x4, got {w2c.shape}")
    R = w2c[:3, :3]
    t = w2c[:3, 3]
    c2w = np.eye(4, dtype=w2c.dtype)
    c2w[:3, :3] = R.T
    c2w[:3, 3] = -R.T @ t
    return c2w


def c2w_to_w2c(c2w: np.ndarray) -> np.ndarray:
    """cam-to-world 4x4 -> world-to-camera 4x4."""
    if c2w.shape != (4, 4):
        raise ValueError(f"c2w must be 4x4, got {c2w.shape}")
    R = c2w[:3, :3]
    t = c2w[:3, 3]
    w2c = np.eye(4, dtype=c2w.dtype)
    w2c[:3, :3] = R.T
    w2c[:3, 3] = -R.T @ t
    return w2c


# ---------------------------------------------------------------------------
# Image axes (OpenCV)
# ---------------------------------------------------------------------------
#
# x: pixel column, increases to the right
# y: pixel row, increases downward
# Intrinsic K = [[fx, 0, cx], [0, fy, cy], [0, 0, 1]]; principal point in pixels.
#

def make_intrinsic(width: int, height: int, fov_x_deg: float = 60.0) -> np.ndarray:
    """수평 FOV로부터 K 생성. principal point는 이미지 중심."""
    fov_x = np.deg2rad(fov_x_deg)
    fx = width / (2.0 * np.tan(fov_x / 2.0))
    fy = fx  # 정사각 픽셀 가정
    cx = width / 2.0
    cy = height / 2.0
    return np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]], dtype=np.float64)


# ---------------------------------------------------------------------------
# Quaternion convention
# ---------------------------------------------------------------------------
#
# (w, x, y, z) order, Hamilton product. frontend apply.ts의 rot_0=w 컨벤션과 일관.
# 본 모듈에서는 직접 quaternion 연산을 거의 사용하지 않으나, gsplat과 PLY I/O 시
# 외부 모듈과의 컨벤션 일치 확인 목적으로 명시.
#

QUAT_W_INDEX: int = 0
QUAT_X_INDEX: int = 1
QUAT_Y_INDEX: int = 2
QUAT_Z_INDEX: int = 3
