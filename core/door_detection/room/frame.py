"""raw ↔ A' 프레임 변환 (방법 B — 다듬기에서 확정된 천장/바닥 평면 활용).

문 설정 단계의 PLY 는 원본(raw) 프레임이지만, 사용자는 다듬기에서
rotX/rotZ 정렬 + 천장(ceilingY)/바닥(floorY) 평면을 A' 프레임에서 확정했다.

door-ml 은 추론(방 추정·카메라 배치)을 A' 에서 수행해 floorY/ceilingY 를
정확한 스칼라 Y 로 쓰고, 렌더만 raw 가우시안으로 한다(카메라를 raw 로 역변환).
이로써 SH 회전 없이 색이 정확하고, A' 코너를 직접 출력한다.

좌표 컨벤션은 backend `_apply_bake_rotation_to_corner` (= 프론트
useRefineTool rotateScene) 와 동일: A' = Rz(rotZ) · Rx(rotX) · raw.
"""

from __future__ import annotations

import numpy as np


def bake_rotation_matrix(rot_x: float, rot_z: float) -> np.ndarray:
    """raw → A' 회전 행렬 R = Rz(rot_z) · Rx(rot_x). (3, 3)."""
    cx, sx = float(np.cos(rot_x)), float(np.sin(rot_x))
    cz, sz = float(np.cos(rot_z)), float(np.sin(rot_z))
    rx = np.array([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]], dtype=np.float64)
    rz = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
    return rz @ rx


def rotate_points(points: np.ndarray, rot: np.ndarray) -> np.ndarray:
    """(N, 3) 점들에 회전 적용: p' = rot · p (행벡터 배치는 P @ rotᵀ)."""
    return np.asarray(points, dtype=np.float64) @ np.asarray(rot, dtype=np.float64).T


def transform_c2w(c2w: np.ndarray, rot: np.ndarray) -> np.ndarray:
    """A' 카메라 c2w (4, 4) 를 다른 프레임으로 선회전.

    rot = Rᵀ (A'→raw) 를 주면 raw 가우시안 렌더용 c2w 를 돌려준다.
    상단 3행(회전+평행이동)에만 rot 을 선곱.
    """
    c2w = np.asarray(c2w, dtype=np.float64)
    rot = np.asarray(rot, dtype=np.float64)
    out = c2w.copy()
    out[:3, :3] = rot @ c2w[:3, :3]
    out[:3, 3] = rot @ c2w[:3, 3]
    return out
