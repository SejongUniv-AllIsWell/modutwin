"""Shared PLY I/O utilities for loading gsplat-exported Gaussian splat files.

Provides ``load_ply`` which reads a standard gsplat PLY and returns all
Gaussian parameters as a dict of numpy arrays.
"""

import numpy as np


def load_ply(ply_path: str) -> dict:
    """Load a gsplat-exported PLY file and return raw Gaussian parameters.

    Returns dict with keys: means, scales, quats, opacities, sh0, shN.
    """
    from plyfile import PlyData

    plydata = PlyData.read(ply_path)
    v = plydata["vertex"]

    means = np.stack([v["x"], v["y"], v["z"]], axis=-1)  # [N, 3]

    # Scales
    scale_names = sorted(p.name for p in v.properties if p.name.startswith("scale_"))
    scales = np.stack([v[s] for s in scale_names], axis=-1)  # [N, 3]

    # Quaternions (stored as rot_0..rot_3 in standard PLY)
    quat_names = sorted(p.name for p in v.properties if p.name.startswith("rot_"))
    quats = np.stack([v[q] for q in quat_names], axis=-1)  # [N, 4]

    # Opacity
    opacities = v["opacity"]  # [N,]

    # SH coefficients
    # f_dc_0, f_dc_1, f_dc_2 -> sh0 [N, 1, 3]
    sh0 = np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], axis=-1)
    sh0 = sh0[:, np.newaxis, :]  # [N, 1, 3]

    # f_rest_* -> shN [N, K, 3]
    rest_names = sorted(
        [p.name for p in v.properties if p.name.startswith("f_rest_")],
        key=lambda n: int(n.split("_")[-1]),
    )
    if len(rest_names) > 0:
        rest = np.stack([v[n] for n in rest_names], axis=-1)  # [N, K*3]
        K = len(rest_names) // 3
        shN = rest.reshape(-1, 3, K).transpose(0, 2, 1)  # [N, K, 3]
    else:
        shN = np.zeros((means.shape[0], 0, 3), dtype=np.float32)

    return {
        "means": means.astype(np.float32),
        "scales": scales.astype(np.float32),
        "quats": quats.astype(np.float32),
        "opacities": opacities.astype(np.float32),
        "sh0": sh0.astype(np.float32),
        "shN": shN.astype(np.float32),
    }


def load_ply_means(ply_path: str) -> np.ndarray:
    """Load only the xyz positions from a PLY file.

    Returns (N, 3) float32 array.
    """
    from plyfile import PlyData

    ply = PlyData.read(ply_path)
    v = ply["vertex"]
    return np.stack([v["x"], v["y"], v["z"]], axis=-1).astype(np.float32)
