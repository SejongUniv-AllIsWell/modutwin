"""Phase 2/5 — gsplat render wrapper.

현재 자동 문 검출은 렌더 품질에 매우 민감하다. 특히 에셋별로
- SH 하이라이트가 강해 문 경계가 무너지거나
- 검은 배경 위에 문이 묻히거나
- 가우시안 가장자리가 aliasing 되어 SAM3 mask가 흔들리는
문제가 있었다.

그래서 각 뷰에 대해 다음 변형을 함께 저장한다.
- canonical: full SH + neutral background + foreground tone balancing
- albedo: SH degree 0 (DC/albedo only)
- dark_bg: DC render on dark background
- bright_bg: DC render on bright background

SAM3 단계는 이 sibling variants 중 가장 좋은 결과를 선택한다.
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


def _compose_on_background(
    rgb_premultiplied: np.ndarray,
    alpha: np.ndarray,
    background_rgb: tuple[float, float, float],
) -> np.ndarray:
    """Black background premultiplied RGB -> composited RGB."""
    bg = np.asarray(background_rgb, dtype=np.float32).reshape(1, 1, 3)
    alpha3 = alpha[..., None].astype(np.float32)
    out = rgb_premultiplied.astype(np.float32) + (1.0 - alpha3) * bg
    return np.clip(out, 0.0, 1.0)


def _tone_balance(image: np.ndarray, alpha: np.ndarray, gamma: float = 0.95) -> np.ndarray:
    """Foreground percentile stretch.

    문이 너무 어둡거나 전체 scene 대비가 납작한 자산에서 문 경계를 살린다.
    배경 픽셀에 과도한 보정이 들어가지 않게 foreground alpha 영역 기준으로만
    percentile을 잡는다.
    """
    out = image.astype(np.float32).copy()
    fg = alpha > 0.03
    if fg.any():
        fg_pixels = out[fg]
        lo = np.percentile(fg_pixels, 1.0, axis=0)
        hi = np.percentile(fg_pixels, 99.0, axis=0)
        scale = np.maximum(hi - lo, 1e-3)
        stretched = np.clip((out - lo.reshape(1, 1, 3)) / scale.reshape(1, 1, 3), 0.0, 1.0)
        out = 0.65 * stretched + 0.35 * out
    out = np.power(np.clip(out, 0.0, 1.0), gamma).astype(np.float32)
    return np.clip(out, 0.0, 1.0)


def _to_u8(image: np.ndarray) -> np.ndarray:
    return (np.clip(image, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def _build_render_variants(
    rgb_full: np.ndarray,
    rgb_dc: np.ndarray,
    alpha: np.ndarray,
) -> dict[str, np.ndarray]:
    neutral_bg = (0.74, 0.74, 0.74)
    dark_bg = (0.14, 0.14, 0.14)
    bright_bg = (0.96, 0.96, 0.96)

    variants = {
        "canonical": _tone_balance(
            _compose_on_background(rgb_full, alpha, neutral_bg),
            alpha,
            gamma=0.95,
        ),
        "albedo": _tone_balance(
            _compose_on_background(rgb_dc, alpha, neutral_bg),
            alpha,
            gamma=0.93,
        ),
        "dark_bg": _tone_balance(
            _compose_on_background(rgb_dc, alpha, dark_bg),
            alpha,
            gamma=0.9,
        ),
        "bright_bg": _tone_balance(
            _compose_on_background(rgb_dc, alpha, bright_bg),
            alpha,
            gamma=1.0,
        ),
    }
    return {name: _to_u8(img) for name, img in variants.items()}


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
        저장된 canonical PNG 경로 리스트 (view_idx 순).
        sibling render variants는 같은 디렉터리에
        `view_0001__albedo.png` 형식으로 함께 저장된다.
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

    def _render_single(
        viewmat: "torch.Tensor",
        K_t: "torch.Tensor",
        sh_degree_value: int,
    ) -> tuple[np.ndarray, np.ndarray]:
        with torch.no_grad():
            rendered, alphas, _ = rasterization(
                means=means,
                quats=quats,
                scales=scales,
                opacities=opacities,
                colors=colors,
                viewmats=viewmat.unsqueeze(0),
                Ks=K_t.unsqueeze(0),
                width=cam.w,
                height=cam.h,
                sh_degree=sh_degree_value,
                packed=False,
                near_plane=near_plane,
                far_plane=far_plane,
                rasterize_mode="antialiased",
            )
        rgb_np = rendered[0].clamp(0.0, 1.0).cpu().numpy()
        alpha_np = alphas[0, ..., 0].clamp(0.0, 1.0).cpu().numpy()
        return rgb_np, alpha_np

    saved: list[str] = []
    for cam in cameras:
        K_t = torch.tensor(cam.K, dtype=torch.float32, device=device)
        c2w_t = torch.tensor(cam.c2w, dtype=torch.float32, device=device)
        viewmat = torch.linalg.inv(c2w_t)

        rgb_full, alpha_np = _render_single(viewmat, K_t, sh_degree)
        if sh_degree > 0:
            rgb_dc, _ = _render_single(viewmat, K_t, 0)
        else:
            rgb_dc = rgb_full

        variants = _build_render_variants(rgb_full, rgb_dc, alpha_np)

        # PLY 좌표계가 사람 시점 기준 90° CCW 돌아있어서 CW 보정 저장.
        # SAM3는 직립 이미지로 학습됐으므로 이 보정이 detection 신뢰도를 높임.
        # 주의: 이후 pixel_to_world_ray 호출 시 역변환(pixel_rotate_cw_to_orig) 필요.
        rotated_variants = {
            name: np.rot90(img_u8, k=-1) for name, img_u8 in variants.items()
        }

        png_path = os.path.join(output_dir, f"view_{cam.view_idx:04d}.png")
        Image.fromarray(rotated_variants["canonical"]).save(png_path)
        for variant_name, img_u8 in rotated_variants.items():
            if variant_name == "canonical":
                continue
            variant_path = os.path.join(
                output_dir, f"view_{cam.view_idx:04d}__{variant_name}.png"
            )
            Image.fromarray(img_u8).save(variant_path)
        saved.append(png_path)

    return saved
