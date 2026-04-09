"""
경계면 근처 가우시안을 벽면에 스냅하고 납작하게 정렬한다.

처리 내용 (clip.py 이후 실행):
    1. 위치 스냅: 가우시안을 벽 평면으로 이동
    2. 회전 정렬: 가우시안의 짧은 축이 정확히 벽 법선과 일치하도록 쿼터니언 보정
    3. 공분산 flatten: 벽 법선 방향 scale을 epsilon으로 축소
    4. SH 계수 회전: 보정 회전에 맞춰 degree 1 SH 계수도 회전 (degree 2,3은 TODO)
    5. 불투명도 증가: 벽이 투명하게 보이지 않도록 opacity를 높임

예외:
    창문(window) 가우시안은 반투명 성질을 유지해야 하므로 처리하지 않음.
    TODO: select_gaussians/auto.py "window" 프롬프트로 인덱스 생성

3DGS PLY 필드:
    scale_0/1/2: log scale (실제 scale = exp(scale_i))
    rot_0/1/2/3: quaternion (w, x, y, z)
    opacity:     raw value (실제 opacity = sigmoid(opacity))

사용법:
    from .clip import clip_single_plane
    from .flat_opaque import align_single_plane

    clip_single_plane("scene.ply", normal, d, "clipped.ply")
    align_single_plane("clipped.ply", normal, d, "refined.ply")
"""

import numpy as np
from plyfile import PlyData, PlyElement


# ---------- 수학 유틸 ----------

def quat_to_rotation_matrix(
    w: np.ndarray, x: np.ndarray, y: np.ndarray, z: np.ndarray,
) -> np.ndarray:
    """쿼터니언 배열 (N,) x 4 → 회전행렬 배열 (N, 3, 3)."""
    norm = np.sqrt(w**2 + x**2 + y**2 + z**2)
    w, x, y, z = w / norm, x / norm, y / norm, z / norm

    R = np.zeros((len(w), 3, 3), dtype=np.float64)
    R[:, 0, 0] = 1 - 2 * (y**2 + z**2)
    R[:, 0, 1] = 2 * (x * y - w * z)
    R[:, 0, 2] = 2 * (x * z + w * y)
    R[:, 1, 0] = 2 * (x * y + w * z)
    R[:, 1, 1] = 1 - 2 * (x**2 + z**2)
    R[:, 1, 2] = 2 * (y * z - w * x)
    R[:, 2, 0] = 2 * (x * z - w * y)
    R[:, 2, 1] = 2 * (y * z + w * x)
    R[:, 2, 2] = 1 - 2 * (x**2 + y**2)
    return R


def quat_multiply(q1: np.ndarray, q2: np.ndarray) -> np.ndarray:
    """쿼터니언 곱 (N, 4) x (N, 4) → (N, 4). 형식: [w, x, y, z]."""
    w1, x1, y1, z1 = q1[:, 0], q1[:, 1], q1[:, 2], q1[:, 3]
    w2, x2, y2, z2 = q2[:, 0], q2[:, 1], q2[:, 2], q2[:, 3]
    return np.column_stack([
        w1*w2 - x1*x2 - y1*y2 - z1*z2,
        w1*x2 + x1*w2 + y1*z2 - z1*y2,
        w1*y2 - x1*z2 + y1*w2 + z1*x2,
        w1*z2 + x1*y2 - y1*x2 + z1*w2,
    ])


def rotation_between_vectors(
    v_from: np.ndarray, v_to: np.ndarray,
) -> np.ndarray:
    """
    v_from → v_to 회전 쿼터니언 (N, 4) [w, x, y, z].
    입력은 단위벡터여야 함.
    """
    dot = np.sum(v_from * v_to, axis=1)        # (N,)
    cross = np.cross(v_from, v_to)             # (N, 3)
    w = 1.0 + dot                              # (N,)
    q = np.column_stack([w, cross])            # (N, 4)

    # dot ≈ -1 (180도 회전) 예외 처리
    bad = w < 1e-6
    if np.any(bad):
        perp = np.zeros_like(v_from[bad])
        abs_v = np.abs(v_from[bad])
        min_axis = np.argmin(abs_v, axis=1)
        for i, ax in enumerate(min_axis):
            e = np.zeros(3)
            e[ax] = 1.0
            perp[i] = np.cross(v_from[bad][i], e)
        perp /= np.linalg.norm(perp, axis=1, keepdims=True)
        q[bad] = np.column_stack([np.zeros(int(bad.sum())), perp])

    q /= np.linalg.norm(q, axis=1, keepdims=True)
    return q


def rotate_sh_degree1(
    sh_coeffs: np.ndarray, R_corr: np.ndarray,
) -> np.ndarray:
    """
    3DGS convention degree 1 SH 계수 회전.

    3DGS SH degree 1 평가식: C1 * (-y*sh1 + z*sh2 - x*sh3)
    방향 벡터 표현: v = (-sh3, -sh1, sh2)
    회전: v_new = R @ v_old
    역변환으로 새 SH 계수 복원.

    Args:
        sh_coeffs: (N, 3) [sh1, sh2, sh3] for one color channel
        R_corr:    (N, 3, 3) correction rotation matrices

    Returns:
        (N, 3) rotated [sh1_new, sh2_new, sh3_new]
    """
    T = np.array([[0., 0., -1.],
                  [-1., 0., 0.],
                  [0., 1., 0.]])
    T_inv = T.T
    v = np.einsum('ij,nj->ni', T, sh_coeffs)
    v_rotated = np.einsum('nij,nj->ni', R_corr, v)
    return np.einsum('ij,nj->ni', T_inv, v_rotated)


def logit(p: float) -> float:
    """sigmoid 역함수."""
    return float(np.log(p / (1.0 - p)))


# ---------- 핵심 로직 ----------

def align_single_plane(
    ply_path: str,
    normal: np.ndarray,
    d: float,
    out_path: str,
    thickness: float = 0.05,
    target_opacity: float = 0.99,
    flat_scale_log: float = -6.908,   # log(0.001) ≈ -6.908 → 1mm
    window_indices: np.ndarray | None = None,
) -> int:
    """
    단일 평면 기준으로 바깥 근처 가우시안을 벽면에 정렬.

    Args:
        ply_path:        입력 PLY (clip.py 결과물)
        normal:          (3,) 평면 법선
        d:               평면 상수 (normal . x = d)
        out_path:        출력 PLY
        thickness:       처리 두께 (기본 5cm)
        target_opacity:  목표 불투명도 (기본 0.99)
        flat_scale_log:  납작하게 만들 축의 log scale (기본 log(0.001))
        window_indices:  창문 가우시안 인덱스 (처리 제외)

    Returns:
        처리된 가우시안 수
    """
    from .clip import determine_outside

    ply = PlyData.read(ply_path)
    vertex = ply['vertex']
    data = vertex.data.copy()
    N = len(data)
    normal = np.asarray(normal, dtype=np.float64)

    xyz = np.column_stack([data['x'], data['y'], data['z']]).astype(np.float64)

    outside_mask, signed_dist = determine_outside(xyz, normal, d)

    if window_indices is not None and len(window_indices) > 0:
        outside_mask[window_indices] = False

    target_indices = np.where(outside_mask)[0]
    print(f"전체: {N:,}  정렬 대상: {len(target_indices):,}")

    if len(target_indices) == 0:
        print("처리할 가우시안 없음.")
        PlyData([PlyElement.describe(data, 'vertex')], text=ply.text).write(out_path)
        return 0

    sub = data[target_indices]
    sub_signed_dist = signed_dist[target_indices]

    # ── 1. 위치 스냅: x_new = x - signed_dist * normal ──
    data['x'][target_indices] -= (sub_signed_dist * normal[0]).astype(data['x'].dtype)
    data['y'][target_indices] -= (sub_signed_dist * normal[1]).astype(data['y'].dtype)
    data['z'][target_indices] -= (sub_signed_dist * normal[2]).astype(data['z'].dtype)

    # ── 2. 회전 정렬 ──
    R = quat_to_rotation_matrix(
        sub['rot_0'].astype(np.float64),
        sub['rot_1'].astype(np.float64),
        sub['rot_2'].astype(np.float64),
        sub['rot_3'].astype(np.float64),
    )  # (M, 3, 3)

    # 벽 법선과 가장 정렬된 로컬 축 찾기: R^T @ normal → 로컬 좌표계에서의 법선
    local_normal = np.einsum('mji,j->mi', R, normal)   # (M, 3)
    alignments = np.abs(local_normal)
    flat_axis = np.argmax(alignments, axis=1)           # (M,) 납작하게 할 축

    # flat axis의 월드 방향 (R의 해당 column)
    M = len(R)
    v_current = R[np.arange(M), :, flat_axis]           # (M, 3)

    # 타겟: wall normal (같은 반구 유지)
    signs = np.sign(np.sum(v_current * normal, axis=1))
    signs[signs == 0] = 1.0
    v_target = normal[np.newaxis, :] * signs[:, np.newaxis]

    # 보정 쿼터니언
    v_current_n = v_current / np.linalg.norm(v_current, axis=1, keepdims=True)
    v_target_n = v_target / np.linalg.norm(v_target, axis=1, keepdims=True)
    q_corr = rotation_between_vectors(v_current_n, v_target_n)

    # 기존 쿼터니언에 보정 적용: q_new = q_corr * q_old
    q_old = np.column_stack([
        sub['rot_0'].astype(np.float64),
        sub['rot_1'].astype(np.float64),
        sub['rot_2'].astype(np.float64),
        sub['rot_3'].astype(np.float64),
    ])
    q_new = quat_multiply(q_corr, q_old)
    q_new /= np.linalg.norm(q_new, axis=1, keepdims=True)

    data['rot_0'][target_indices] = q_new[:, 0].astype(data['rot_0'].dtype)
    data['rot_1'][target_indices] = q_new[:, 1].astype(data['rot_1'].dtype)
    data['rot_2'][target_indices] = q_new[:, 2].astype(data['rot_2'].dtype)
    data['rot_3'][target_indices] = q_new[:, 3].astype(data['rot_3'].dtype)

    # ── 3. Scale flatten: 보정 후 flat_axis가 법선 방향이므로 해당 축 축소 ──
    scale_fields = ['scale_0', 'scale_1', 'scale_2']
    for j in range(3):
        target_j = target_indices[flat_axis == j]
        if len(target_j) > 0:
            data[scale_fields[j]][target_j] = flat_scale_log

    # ── 4. SH degree 1 회전 ──
    R_corr = quat_to_rotation_matrix(
        q_corr[:, 0], q_corr[:, 1], q_corr[:, 2], q_corr[:, 3],
    )

    field_names = [p.name for p in vertex.properties]
    n_rest = sum(1 for f in field_names if f.startswith('f_rest_'))

    if n_rest >= 9:  # 최소 degree 1 (3 coeffs x 3 channels)
        coeffs_per_channel = n_rest // 3
        for ch in range(3):
            offset = ch * coeffs_per_channel
            sh1 = np.column_stack([
                sub[f'f_rest_{offset}'].astype(np.float64),
                sub[f'f_rest_{offset + 1}'].astype(np.float64),
                sub[f'f_rest_{offset + 2}'].astype(np.float64),
            ])
            sh1_new = rotate_sh_degree1(sh1, R_corr)
            for k in range(3):
                field = f'f_rest_{offset + k}'
                data[field][target_indices] = sh1_new[:, k].astype(data[field].dtype)
        # TODO: degree 2, 3 SH rotation (Wigner D-matrix)

    # ── 5. Opacity 증가 ──
    data['opacity'][target_indices] = logit(target_opacity)

    PlyData([PlyElement.describe(data, 'vertex')], text=ply.text).write(out_path)
    print(f"저장 완료: {out_path}")
    return len(target_indices)


# ---------- 메인 ----------

if __name__ == "__main__":
    import sys
    import tempfile
    import os

    if len(sys.argv) < 6:
        print("사용법: python -m refine_module.flat_opaque <input.ply> <nx> <ny> <nz> <d> [output.ply] [thickness]")
        sys.exit(1)

    ply_path = sys.argv[1]
    normal = np.array([float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])])
    d_val = float(sys.argv[5])
    out_path = sys.argv[6] if len(sys.argv) > 6 else ply_path.replace(".ply", "_refined.ply")
    thickness = float(sys.argv[7]) if len(sys.argv) > 7 else 0.05

    from .clip import clip_single_plane

    with tempfile.NamedTemporaryFile(suffix=".ply", delete=False) as f:
        tmp_path = f.name
    try:
        clip_single_plane(ply_path, normal, d_val, tmp_path, thickness)
        align_single_plane(tmp_path, normal, d_val, out_path, thickness)
    finally:
        os.unlink(tmp_path)

    print(f"\n완료: {out_path}")
