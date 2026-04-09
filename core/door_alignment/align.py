"""
Door-based alignment between two 3DGS modules.

Given point clouds of door Gaussian splats from two spaces (Module and Base Map),
compute the 4x4 similarity transformation T (R, t, scale) that maps Module space
into Base Map space using SVD-based frame alignment.

The returned 4x4 matrix T satisfies:
    p_basemap = T @ p_module   (homogeneous coordinates)

Assumptions (see CLAUDE.md):
- Door GS particles are already segmented.
- Room boundaries are cleanly cut (room interior has more particles than exterior near the door).
- Room ceiling direction has a positive dot product with world_up = (0, 1, 0).
"""

import numpy as np


def _extract_principal_axes(
    points: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    점군에 SVD를 적용해 중심점과 세 주축을 반환한다.

    Args:
        points: (N, 3) # 문의 GS 입자의 위치벡터를 행벡터로 쭉 나열한 배열

    Returns:
        centroid: (3,)
        ax0:      (3,) 분산 최대 주축
        ax1:      (3,) 분산 중간 주축
        ax2:      (3,) 분산 최소 주축 (평면 법선 후보)
    """
    centroid = points.mean(axis=0)
    X = points - centroid # 무게중심을 원점으로 설정
    _, _, Vt = np.linalg.svd(X, full_matrices=False)
        # Vt[0]: 분산 최대 주축 (세로)
        # Vt[1]: 분산 중간 주축 (가로)
        # Vt[2]: 분산 최소 주축 (법선)
    return centroid, Vt[0], Vt[1], Vt[2]


def _align_naxis_outward(
    points: np.ndarray,
    centroid: np.ndarray,
    n: np.ndarray,
) -> np.ndarray:
    """
    법선 벡터가 방 바깥쪽을 향하도록 부호를 결정한다.

    ply파일은 잘 정제되어 있다고 가정한다. (벽 부분이 깨끗하게 잘려있음)
    문 평면 양쪽의 입자 밀도를 비교한다.
    정제된 ply 기준, 방 안쪽(n 반대 방향)에 입자가 더 많아야 한다.

    Args:
        points:   (N, 3) 문 GS 입자 위치
        centroid: (3,)   문 중심점
        n:        (3,)   법선 벡터 (부호 미결정)

    Returns:
        n: (3,) 방 바깥쪽을 향하는 법선 벡터
    """
    projections = (points - centroid) @ n
    n_inside  = np.sum(projections < 0)  # n 반대 방향 (현재 법선 기준 뒤쪽)
    n_outside = np.sum(projections > 0)  # n 방향 (현재 법선 기준 앞쪽)

    # 입자가 더 많은 쪽 = 방 안쪽 → 법선은 그 반대(바깥)를 향해야 함
    if n_inside < n_outside:
        n = -n
    return n


def _align_vaxis_upright(
    ax0: np.ndarray,
    ax1: np.ndarray,
    n: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """
    v축이 위쪽, u축이 right-hand rule을 따르도록 방향을 확정한다.

    
    world_up = (0, 1, 0)을 문 평면에 투영해 위쪽 방향을 결정한다.
    ax0, ax1 중 world_up에 더 정렬된 것을 v로 선택하고,
    u = cross(v, n) 으로 결정한다.

    Args:
        ax0: (3,) SVD 1번 주축 (분산 최대)
        ax1: (3,) SVD 2번 주축 (분산 중간)
        n:   (3,) 법선 벡터 (부호 확정 상태)

    Returns:
        u: (3,) 가로 방향
        v: (3,) 세로 방향 (위쪽)
    """
    world_up = np.array([0.0, 1.0, 0.0])

    # world_up을 문 평면에 투영
    up_in_plane = world_up - np.dot(world_up, n) * n
    if np.linalg.norm(up_in_plane) < 1e-6:
        # 문이 수평으로 누워있는 예외 상황 (바닥문 등)
        up_in_plane = np.array([0.0, 0.0, 1.0])
        up_in_plane = up_in_plane - np.dot(up_in_plane, n) * n
    up_in_plane = up_in_plane / np.linalg.norm(up_in_plane)

    # ax0, ax1 중 up_in_plane에 더 가까운 것을 v로 선택
    if abs(np.dot(ax0, up_in_plane)) >= abs(np.dot(ax1, up_in_plane)):
        v = ax0.copy()
    else:
        v = ax1.copy()

    # v 부호 결정: world_up과 같은 방향이어야 함
    if np.dot(v, up_in_plane) < 0:
        v = -v

    # u = cross(v, n): right-hand rule로 유일하게 결정
    u = np.cross(v, n)
    u = u / np.linalg.norm(u)

    return u, v


def _ransac_plane(
    points: np.ndarray,
    n_iter: int = 200,
    inlier_thresh: float = 0.05,
    seed: int | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """
    RANSAC으로 점군에서 주요 평면의 법선과 inlier 마스크를 반환한다.

    매 반복마다 3점을 랜덤 샘플링해 평면 후보를 만들고,
    그 평면으로부터 inlier_thresh 이내의 점들을 inlier로 간주한다.
    손잡이처럼 평면에서 튀어나온 점들은 outlier로 자동 제거된다.

    Args:
        points:        (N, 3) 문 GS 입자 위치
        n_iter:        RANSAC 반복 횟수
        inlier_thresh: inlier 판정 거리 (미터 단위)
        seed:          재현성을 위한 난수 seed (None이면 랜덤)

    Returns:
        n:       (3,) 추정된 평면 법선 (단위벡터)
        inliers: (N,) bool 마스크
    """
    rng        = np.random.default_rng(seed)
    best_n     = None
    best_mask  = None
    best_count = 0

    for _ in range(n_iter):
        idx      = rng.choice(len(points), 3, replace=False)
        p0, p1, p2 = points[idx]
        n_cand   = np.cross(p1 - p0, p2 - p0)
        norm     = np.linalg.norm(n_cand)
        if norm < 1e-10:
            continue
        n_cand  /= norm

        dists    = np.abs((points - p0) @ n_cand)
        mask     = dists < inlier_thresh
        count    = mask.sum()
        if count > best_count:
            best_count = count
            best_n     = n_cand
            best_mask  = mask

    assert best_n is not None and best_mask is not None, \
        "RANSAC 실패: 유효한 평면을 찾지 못했습니다. 점 개수나 n_iter를 늘려보세요."
    return best_n, best_mask


def build_door_frame(
    points: np.ndarray,
    ransac_n_iter: int = 200,
    ransac_thresh: float | None = None,
    ransac_thresh_k: float = 2.0,
    ransac_seed: int | None = None,
    scale_percentile: float = 1.0,
) -> tuple[np.ndarray, float]:
    """
    점군으로부터 4×4 로컬 프레임 행렬을 반환한다.

    RANSAC으로 outlier(손잡이 등)를 제거한 뒤,
    inlier 점군에 PCA를 적용해 프레임을 구성한다.

    Args:
        points:           (N, 3) 문 GS 입자 위치
        ransac_n_iter:    RANSAC 반복 횟수
        ransac_thresh:    RANSAC inlier 판정 거리 (미터).
                          None이면 점군의 분포에서 자동 계산한다.
        ransac_thresh_k:  자동 계산 시 MAD에 곱하는 배수 (기본 2.0)
        ransac_seed:      재현성을 위한 난수 seed
        scale_percentile: 높이 추정 시 양쪽에서 잘라낼 퍼센타일 (기본 1.0).
                          1.0이면 하위 1% ~ 상위 1% 범위를 문 높이로 사용한다.

    Returns:
        F:        (4, 4) 로컬 프레임 행렬 [u | v | n | centroid]
        v_range:  float  v축(높이) 방향의 퍼센타일 범위 (스케일 계산용)
    """
    points = np.asarray(points, dtype=np.float64)
    assert len(points) >= 3, "최소 3개의 점이 필요합니다."

    # ransac_thresh 자동 계산:
    # PCA로 대략적인 법선을 먼저 구하고, 그 방향의 분포로 threshold를 결정한다.
    # std 대신 MAD(중앙절대편차)를 사용해 손잡이 같은 outlier에 강건하게 만든다.
    if ransac_thresh is None:
        _, _, _, rough_n = _extract_principal_axes(points)
        projs            = (points - points.mean(axis=0)) @ rough_n
        mad              = np.median(np.abs(projs - np.median(projs)))
        ransac_thresh    = float(ransac_thresh_k * mad / 0.6745)  # MAD → std 스케일 환산

    # RANSAC으로 outlier 제거 후 inlier 점군에 PCA 적용
    _, inlier_mask        = _ransac_plane(points, ransac_n_iter, ransac_thresh, ransac_seed)
    inlier_pts            = points[inlier_mask]
    centroid, ax0, ax1, n = _extract_principal_axes(inlier_pts)

    # 법선 부호 및 축 방향 결정 (전체 점군 기준으로 밀도 비교)
    n    = _align_naxis_outward(points, centroid, n)
    u, v = _align_vaxis_upright(ax0, ax1, n)

    # v축(높이) 방향의 퍼센타일 범위를 스케일 기준으로 사용한다.
    # std 대신 퍼센타일 범위를 쓰는 이유:
    #   GS 학습 결과 입자 밀도는 텍스처 복잡도에 따라 불균일하게 분포하므로
    #   std는 실제 문 크기가 아닌 입자 분포에 따라 달라진다.
    #   퍼센타일 범위는 양 끝 극단값(outlier)만 제거하고 경계 근방의 점을
    #   기준으로 삼으므로, 입자 밀도 분포의 영향을 덜 받는다.
    # v축(세로/높이)을 기준으로 쓰는 이유:
    #   문은 세로가 가로보다 길어 같은 수의 입자라도 v축이 통계적으로 안정적이고,
    #   u축(가로)은 손잡이나 문틀 위치에 따라 분포가 쏠릴 수 있다.
    proj_v  = (inlier_pts - centroid) @ v
    v_range = float(
        np.percentile(proj_v, 100 - scale_percentile)
        - np.percentile(proj_v, scale_percentile)
    )

    F = np.eye(4)
    F[:3, 0] = u
    F[:3, 1] = v
    F[:3, 2] = n
    F[:3, 3] = centroid

    return F, v_range


def matrix_module2basemap(
    points_module: np.ndarray,
    points_basemap: np.ndarray,
    ransac_n_iter: int = 200,
    ransac_thresh: float | None = None,
    ransac_thresh_k: float = 2.0,
    ransac_seed: int | None = None,
    scale_percentile: float = 1.0,
) -> np.ndarray:
    """
    두 문 점군으로부터 module→basemap 변환 행렬 T를 계산한다.

    T = F_basemap @ S @ F_module_inv

    Args:
        points_module:    (N, 3) module 문 GS 입자 위치
        points_basemap:   (M, 3) basemap 문 GS 입자 위치  (N ≠ M 가능)
        ransac_n_iter:    RANSAC 반복 횟수
        ransac_thresh:    RANSAC inlier 판정 거리 (미터). None이면 자동 계산.
        ransac_thresh_k:  자동 계산 시 MAD에 곱하는 배수 (기본 2.0)
        ransac_seed:      재현성을 위한 난수 seed (None이면 랜덤)
        scale_percentile: 높이 추정 시 양쪽에서 잘라낼 퍼센타일 (기본 1.0)

    Returns:
        T: (4, 4) 변환 행렬
    """
    points_module  = np.asarray(points_module,  dtype=np.float64)
    points_basemap = np.asarray(points_basemap, dtype=np.float64)

    F_module,  v_range_m = build_door_frame(points_module,  ransac_n_iter, ransac_thresh, ransac_thresh_k, ransac_seed, scale_percentile)
    F_basemap, v_range_b = build_door_frame(points_basemap, ransac_n_iter, ransac_thresh, ransac_thresh_k, ransac_seed, scale_percentile)

    # v축(높이) 퍼센타일 범위의 비율로 등방성 스케일을 결정한다.
    # 두 공간이 같은 문을 서로 다른 스케일로 학습했다면,
    # 문 높이의 비율이 곧 전체 공간의 스케일 비율과 같다.
    # u·v·n 모두 동일한 비율(등방성)로 스케일링한다.
    s = v_range_b / v_range_m
    S = np.diag(np.array([s, s, s, 1.0]))

    # F_module의 역행렬 (회전행렬이므로 R^-1 = R^T)
    R_m = F_module[:3, :3]
    t_m = F_module[:3, 3]
    F_module_inv = np.eye(4)
    F_module_inv[:3, :3] = R_m.T
    F_module_inv[:3,  3] = -R_m.T @ t_m

    return F_basemap @ S @ F_module_inv


def apply_transform(T: np.ndarray, points: np.ndarray) -> np.ndarray:
    """
    4×4 변환 행렬을 점군에 적용한다.

    Args:
        T:      (4, 4) 변환 행렬
        points: (N, 3) 3D 점군

    Returns:
        (N, 3) 변환된 점군
    """
    points   = np.asarray(points, dtype=np.float64)
    ones     = np.ones((len(points), 1))
    points_h = np.hstack([points, ones])
    return (T @ points_h.T).T[:, :3]


def visualize_alignment(
    module_pts: np.ndarray,
    basemap_pts: np.ndarray,
    transformed_pts: np.ndarray,
    n_frames: int = 60,
) -> None:
    """
    3D 플롯으로 문 정렬 결과를 시각화한다.
    "Align" 버튼을 누르면 module 점군이 변환된 위치로 이동하는 애니메이션이 재생된다.

    Args:
        module_pts:      (N, 3) 변환 전 module 점군
        basemap_pts:     (M, 3) basemap 점군 (GT)
        transformed_pts: (N, 3) 변환 후 module 점군
        n_frames:        애니메이션 프레임 수
    """
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    from matplotlib.patches import Patch
    from matplotlib.widgets import Button
    from matplotlib.animation import FuncAnimation

    module_pts      = np.asarray(module_pts,      dtype=np.float64)
    basemap_pts     = np.asarray(basemap_pts,      dtype=np.float64)
    transformed_pts = np.asarray(transformed_pts,  dtype=np.float64)

    all_pts = np.vstack([module_pts, basemap_pts, transformed_pts])
    margin  = 0.5
    lims    = [(all_pts[:, d].min() - margin, all_pts[:, d].max() + margin) for d in range(3)]

    fig = plt.figure(figsize=(11, 8))
    ax  = fig.add_subplot(111, projection="3d")
    ax.mouse_init(rotate_btn=3)  # 3D 회전은 오른쪽 마우스
    fig.subplots_adjust(bottom=0.15)

    def _draw_pts(pts, color, label):
        ax.scatter(*pts.T, color=color, s=10, alpha=0.5)
        center = pts.mean(axis=0)
        ax.text(center[0], center[1], center[2], label, color=color,
                fontsize=9, fontweight="bold")

    def _setup_axes():
        ax.set_xlim(*lims[0]); ax.set_ylim(*lims[1]); ax.set_zlim(*lims[2])
        ax.set_xlabel("X"); ax.set_ylabel("Y"); ax.set_zlabel("Z")

    def _full_redraw(pts, color, title_suffix=""):
        elev, azim = ax.elev, ax.azim   # 현재 시점 저장
        ax.cla()
        _draw_pts(basemap_pts,  "tomato",    "Basemap (GT)")
        _draw_pts(pts,          color,       "Module")
        _setup_axes()
        ax.view_init(elev=elev, azim=azim)  # 시점 복원
        err = np.linalg.norm(pts.mean(axis=0) - basemap_pts.mean(axis=0))
        ax.set_title(f"Door Alignment  |  centroid error = {err:.4f}{title_suffix}")
        legend_elements = [
            Patch(facecolor="royalblue", label="Module (before)"),
            Patch(facecolor="tomato",    label="Basemap (GT)"),
            Patch(facecolor="limegreen", label="Module (transformed)"),
        ]
        ax.legend(handles=legend_elements, loc="upper left")
        fig.canvas.draw_idle()

    _full_redraw(module_pts, "royalblue", " [press Align]")

    state = {"anim": None, "running": False}

    def _on_align(_):
        if state["running"]:
            return
        state["running"] = True
        btn_align.label.set_text("...")

        ts = np.linspace(0.0, 1.0, n_frames)

        def _update(i):
            t       = ts[i]
            current = (1 - t) * module_pts + t * transformed_pts
            hex_color = "#{:02x}{:02x}{:02x}".format(
                int((1 - t) * 70),
                int(t * 205 + (1 - t) * 144),
                int((1 - t) * 238),
            )
            elev, azim = ax.elev, ax.azim   # 현재 시점 저장
            ax.cla()
            _draw_pts(basemap_pts, "tomato",    "Basemap (GT)")
            _draw_pts(current,     hex_color,   "Module")
            _setup_axes()
            ax.view_init(elev=elev, azim=azim)  # 시점 복원
            err = np.linalg.norm(current.mean(axis=0) - basemap_pts.mean(axis=0))
            ax.set_title(f"Door Alignment  |  centroid error = {err:.4f}")
            legend_elements = [
                Patch(facecolor="royalblue", label="Module (before)"),
                Patch(facecolor="tomato",    label="Basemap (GT)"),
                Patch(facecolor="limegreen", label="Module (transformed)"),
            ]
            ax.legend(handles=legend_elements, loc="upper left")

            if i == n_frames - 1:
                state["running"] = False
                btn_align.label.set_text("Align")
            return []

        state["anim"] = FuncAnimation(  # type: ignore[assignment]
            fig, _update, frames=n_frames, interval=16, repeat=False
        )
        fig.canvas.draw_idle()

    ax_btn    = fig.add_axes((0.42, 0.04, 0.16, 0.06))
    btn_align = Button(ax_btn, "Align", color="#ddeeff", hovercolor="#aaccff")
    btn_align.on_clicked(_on_align)

    plt.show()


if __name__ == "__main__":
    rng = np.random.default_rng(42)

    # Ground truth transform: x축 반전 + z축 반전 + x방향 평행이동
    R_gt = np.array([[-1, 0,  0],
                     [ 0, 1,  0],
                     [ 0, 0, -1]], dtype=float)
    t_gt = np.array([5.0, 0.0, 0.0])

    # --- Module door ---
    # 가로 1m (x), 세로 2m (y), z=0 평면
    #
    # [1] 문 표면: 왼쪽(x<0.5)에 입자가 집중된 비균일 분포
    N_left   = 280   # 왼쪽 절반에 더 많이 몰림
    N_right  = 70    # 오른쪽 절반은 희박
    xy_left  = rng.uniform([0.0, 0.0], [0.5, 2.0], (N_left,  2))
    xy_right = rng.uniform([0.5, 0.0], [1.0, 2.0], (N_right, 2))
    xy_surf  = np.vstack([xy_left, xy_right])
    z_surf   = rng.normal(0.0, 0.02, (len(xy_surf), 1))

    # [2] 방 안쪽 입자 (문틀/벽, z > 0): _align_naxis_outward 판별용
    N_interior = 150
    xy_int     = rng.uniform([0.0, 0.0], [1.0, 2.0], (N_interior, 2))
    z_int      = rng.normal(0.15, 0.03, (N_interior, 1))

    # [3] 문 손잡이: 오른쪽 중간 (x≈0.85, y≈1.0) 에서 z 방향으로 튀어나온 뭉텅이
    N_handle  = 60
    xy_handle = rng.normal([0.85, 1.0], [0.03, 0.05], (N_handle, 2))
    z_handle  = rng.normal(0.10, 0.02, (N_handle, 1))   # 문 표면에서 10cm 돌출

    module_door = np.vstack([
        np.hstack([xy_surf   + rng.normal(0, 0.01, (len(xy_surf),   2)), z_surf  ]),
        np.hstack([xy_int    + rng.normal(0, 0.01, (N_interior,     2)), z_int   ]),
        np.hstack([xy_handle,                                             z_handle]),
    ])

    # --- Basemap door ---
    # 같은 구조로 독립 샘플링 후 R_gt + t_gt 적용
    N_left_b   = 300
    N_right_b  = 80
    xy_left_b  = rng.uniform([0.0, 0.0], [0.5, 2.0], (N_left_b,  2))
    xy_right_b = rng.uniform([0.5, 0.0], [1.0, 2.0], (N_right_b, 2))
    xy_surf_b  = np.vstack([xy_left_b, xy_right_b])
    z_surf_b   = rng.normal(0.0, 0.02, (len(xy_surf_b), 1))

    N_interior_b = 180
    xy_int_b     = rng.uniform([0.0, 0.0], [1.0, 2.0], (N_interior_b, 2))
    z_int_b      = rng.normal(0.15, 0.03, (N_interior_b, 1))

    N_handle_b  = 50
    xy_handle_b = rng.normal([0.85, 1.0], [0.03, 0.05], (N_handle_b, 2))
    z_handle_b  = rng.normal(0.10, 0.02, (N_handle_b, 1))

    door_b_local = np.vstack([
        np.hstack([xy_surf_b   + rng.normal(0, 0.015, (len(xy_surf_b), 2)), z_surf_b  ]),
        np.hstack([xy_int_b    + rng.normal(0, 0.015, (N_interior_b,   2)), z_int_b   ]),
        np.hstack([xy_handle_b,                                              z_handle_b]),
    ])
    basemap_door = (R_gt @ door_b_local.T).T + t_gt

    T = matrix_module2basemap(module_door, basemap_door, ransac_seed=42)
    print("module2basemap transform:\n", np.round(T, 4))

    # 4개 코너로 정렬 오차 확인
    module_corners = np.array([
        [0.0, 2.0, 0.0],   # top-left
        [1.0, 2.0, 0.0],   # top-right
        [1.0, 0.0, 0.0],   # bottom-right
        [0.0, 0.0, 0.0],   # bottom-left
    ])
    basemap_corners_gt  = (R_gt @ module_corners.T).T + t_gt
    transformed_corners = apply_transform(T, module_corners)

    print(f"\nCorner error: {np.linalg.norm(transformed_corners - basemap_corners_gt):.6f}")
    print("Basemap corners (GT):\n",    np.round(basemap_corners_gt,  4))
    print("Transformed corners:\n",     np.round(transformed_corners, 4))

    visualize_alignment(module_door, basemap_door, apply_transform(T, module_door))
