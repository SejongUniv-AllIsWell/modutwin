"""
단일 경계 평면을 기준으로 가우시안을 분류하고, 방 바깥 가우시안을 삭제한다.

방식:
    평면이 공간을 두 반공간으로 나눈다.
    가우시안이 적은 쪽 = 방 바깥으로 판정.
    바깥 가우시안 중 평면에서 thickness 초과 거리인 것은 삭제.
    thickness 이내인 것은 유지 (flat_opaque.py에서 벽면에 부착 처리).

사용법:
    from .clip import clip_single_plane
    clip_single_plane("scene.ply", normal, d, "clipped.ply")
"""

import numpy as np
from plyfile import PlyData, PlyElement


def load_ply(ply_path: str) -> PlyData:
    return PlyData.read(ply_path)


def determine_outside(
    xyz: np.ndarray,
    normal: np.ndarray,
    d: float,
) -> tuple[np.ndarray, np.ndarray]:
    """
    평면 기준 가우시안이 적은 쪽을 '바깥'으로 판정.

    Args:
        xyz:    (N, 3) 가우시안 위치
        normal: (3,) 평면 법선 (단위벡터)
        d:      평면 상수 (normal . x = d)

    Returns:
        outside_mask: (N,) bool — True = 바깥 (가우시안이 적은 쪽)
        signed_dist:  (N,) float — normal . x - d (양수 = normal 방향)
    """
    signed_dist = xyz @ normal - d
    n_positive = int((signed_dist > 0).sum())
    n_negative = len(signed_dist) - n_positive
    if n_positive <= n_negative:
        outside_mask = signed_dist > 0
    else:
        outside_mask = signed_dist <= 0
    return outside_mask, signed_dist


def clip_single_plane(
    ply_path: str,
    normal: np.ndarray,
    d: float,
    out_path: str,
    thickness: float = 0.05,
) -> int:
    """
    단일 평면 기준으로 바깥 가우시안 중 thickness 초과인 것을 삭제.

    Args:
        ply_path:  입력 PLY
        normal:    (3,) 평면 법선
        d:         평면 상수 (normal . x = d)
        out_path:  출력 PLY
        thickness: 이 거리 이내 가우시안은 유지 (flat_opaque에서 처리)

    Returns:
        삭제된 가우시안 수
    """
    ply = load_ply(ply_path)
    vertex = ply['vertex']
    xyz = np.column_stack([vertex['x'], vertex['y'], vertex['z']]).astype(np.float64)
    normal = np.asarray(normal, dtype=np.float64)

    outside_mask, signed_dist = determine_outside(xyz, normal, d)
    abs_dist = np.abs(signed_dist)

    delete_mask = outside_mask & (abs_dist > thickness)
    keep_mask = ~delete_mask

    n_removed = int(delete_mask.sum())
    print(f"전체: {len(xyz):,}  삭제: {n_removed:,}  유지: {int(keep_mask.sum()):,}")

    filtered = vertex.data[keep_mask]
    new_element = PlyElement.describe(filtered, 'vertex')
    PlyData([new_element], text=ply.text).write(out_path)

    print(f"저장 완료: {out_path}")
    return n_removed


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 6:
        print("사용법: python -m refine_module.clip <input.ply> <nx> <ny> <nz> <d> [output.ply] [thickness]")
        sys.exit(1)

    ply_path = sys.argv[1]
    normal = np.array([float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])])
    d_val = float(sys.argv[5])
    out_path = sys.argv[6] if len(sys.argv) > 6 else ply_path.replace(".ply", "_clipped.ply")
    thickness = float(sys.argv[7]) if len(sys.argv) > 7 else 0.05

    clip_single_plane(ply_path, normal, d_val, out_path, thickness)
