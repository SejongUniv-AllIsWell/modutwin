"""Phase 2/5 — gsplat RGB-only 렌더링 wrapper.

D3: depth/Gaussian-ID map은 저장하지 않는다. RGB PNG만 출력.
core/select_gaussians/auto.py의 rasterization 호출 패턴 참고.
"""

from __future__ import annotations

import os
from typing import Sequence

import numpy as np

from .camera_sampler import CameraView


def _determine_sh_degree(num_sh_coeffs_per_color: int) -> int:
    """num_coeffs = (degree+1)^2.  degree = round(sqrt(num)) - 1."""
    if num_sh_coeffs_per_color <= 0:
        return 0
    degree = int(round(np.sqrt(num_sh_coeffs_per_color))) - 1
    return max(0, degree)


def render_views(
    splats: dict,
    cameras: Sequence[CameraView],
    output_dir: str,
    device: str = "cuda",
    near_plane: float = 0.01,
    far_plane: float = 1e10,
) -> list[str]:
    """gsplat.rasterization으로 각 카메라의 RGB PNG 렌더.

    Args:
        splats: utilities.ply_io.load_ply 결과 (means/quats/scales/opacities/sh0/shN).
        cameras: CameraView 리스트.
        output_dir: PNG 저장 디렉터리.
        device: 'cuda' | 'cpu'.

    Returns:
        저장된 PNG 경로 리스트 (view_idx 순).
    """
    import torch
    from gsplat import rasterization
    from PIL import Image

    os.makedirs(output_dir, exist_ok=True)

    means_np = np.ascontiguousarray(splats["means"], dtype=np.float32)
    quats_np = np.ascontiguousarray(splats["quats"], dtype=np.float32)
    scales_log_np = np.ascontiguousarray(splats["scales"], dtype=np.float32)
    opac_logit_np = np.ascontiguousarray(splats["opacities"], dtype=np.float32)
    sh0_np = np.ascontiguousarray(splats["sh0"], dtype=np.float32)  # (N, 1, 3)
    shN_np = np.ascontiguousarray(splats["shN"], dtype=np.float32)  # (N, K, 3)

    means = torch.from_numpy(means_np).to(device)
    quats = torch.from_numpy(quats_np).to(device)
    scales = torch.exp(torch.from_numpy(scales_log_np).to(device))
    opacities = torch.sigmoid(torch.from_numpy(opac_logit_np).to(device))

    sh0 = torch.from_numpy(sh0_np).to(device)
    if shN_np.shape[1] > 0:
        shN = torch.from_numpy(shN_np).to(device)
        colors = torch.cat([sh0, shN], dim=1)  # (N, 1+K, 3)
    else:
        colors = sh0
    sh_degree = _determine_sh_degree(colors.shape[1])

    saved: list[str] = []
    for cam in cameras:
        K_t = torch.tensor(cam.K, dtype=torch.float32, device=device)
        c2w_t = torch.tensor(cam.c2w, dtype=torch.float32, device=device)
        viewmat = torch.linalg.inv(c2w_t)

        with torch.no_grad():
            rendered, _, _ = rasterization(
                means=means,
                quats=quats,
                scales=scales,
                opacities=opacities,
                colors=colors,
                viewmats=viewmat.unsqueeze(0),
                Ks=K_t.unsqueeze(0),
                width=cam.w,
                height=cam.h,
                sh_degree=sh_degree,
                packed=False,
                near_plane=near_plane,
                far_plane=far_plane,
            )
        img_np = rendered[0].clamp(0.0, 1.0).cpu().numpy()
        img_u8 = (img_np * 255.0 + 0.5).astype(np.uint8)
        # PLY 좌표계가 사람 시점 기준 90° CCW 돌아있어서 CW 보정 저장.
        # SAM3는 직립 이미지로 학습됐으므로 이 보정이 detection 신뢰도를 높임.
        # 주의: 이후 pixel_to_world_ray 호출 시 역변환(pixel_rotate_cw_to_orig) 필요.
        img_u8 = np.rot90(img_u8, k=-1)  # 90° CW = rot90 with k=-1
        png_path = os.path.join(output_dir, f"view_{cam.view_idx:04d}.png")
        Image.fromarray(img_u8).save(png_path)
        saved.append(png_path)

    return saved
