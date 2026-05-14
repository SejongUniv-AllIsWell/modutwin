"""Phase 10 — closed-form skew-ray nearest-point LSQ.

p가 모든 ray에 대한 perpendicular distance 제곱합을 최소화하는 closed-form:

    A = Σ (I − d_i d_iᵀ)
    b = Σ (I − d_i d_iᵀ) o_i
    p = A⁻¹ b

(I − d_i d_iᵀ)는 d_i 방향 성분을 제거하는 projector.
"""

from __future__ import annotations

import numpy as np


def closed_form_lsq(
    origins: np.ndarray,
    directions: np.ndarray,
) -> tuple[np.ndarray, float]:
    """Returns (point (3,), condition_number).

    Args:
        origins: (M, 3).
        directions: (M, 3) unit vectors.
    """
    if origins.shape != directions.shape:
        raise ValueError(f"origins {origins.shape} != directions {directions.shape}")
    if origins.ndim != 2 or origins.shape[1] != 3:
        raise ValueError(f"expected (M, 3), got origins {origins.shape}")
    M = origins.shape[0]
    if M < 2:
        raise ValueError(f"need ≥ 2 rays for LSQ, got {M}")

    norms = np.linalg.norm(directions, axis=1, keepdims=True)
    if (norms < 1e-9).any():
        raise ValueError("directions contains zero vector")
    d = directions / norms

    I3 = np.eye(3, dtype=np.float64)
    P = I3[None, :, :] - np.einsum("mi,mj->mij", d, d)  # (M, 3, 3)
    A = P.sum(axis=0)  # (3, 3)
    b = np.einsum("mij,mj->i", P, origins.astype(np.float64))  # (3,)

    sigvals = np.linalg.svd(A, compute_uv=False)
    if sigvals.min() < 1e-12:
        cond = float("inf")
    else:
        cond = float(sigvals.max() / sigvals.min())

    p = np.linalg.solve(A, b)
    return p, cond


def perpendicular_distances(
    point: np.ndarray,
    origins: np.ndarray,
    directions: np.ndarray,
) -> np.ndarray:
    """각 ray에서 point까지의 수직 거리 (M,)."""
    norms = np.linalg.norm(directions, axis=1, keepdims=True)
    d = directions / np.maximum(norms, 1e-12)
    rel = point[None, :] - origins
    proj_len = np.einsum("mi,mi->m", rel, d)
    proj = proj_len[:, None] * d
    perp = rel - proj
    return np.linalg.norm(perp, axis=1)
