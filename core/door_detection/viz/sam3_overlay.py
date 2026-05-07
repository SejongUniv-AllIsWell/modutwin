"""SAM3 detection 시각화 — 반투명 mask + score label.

각 view에 대해 SAM3가 찾은 candidate들의 mask를 alpha-blend로 overlay하고,
mask 영역 부근에 score 텍스트를 그린다.
"""

from __future__ import annotations

import os
import sys
import types
from typing import Sequence

import numpy as np


def _stub_decord_if_missing() -> None:
    if "decord" in sys.modules:
        return
    try:
        import decord  # noqa: F401
        return
    except ImportError:
        pass
    m = types.ModuleType("decord")

    class _S:
        def __init__(self, *a, **kw):
            raise NotImplementedError("decord stubbed")

    m.VideoReader = _S  # type: ignore[attr-defined]
    m.cpu = lambda *a, **kw: None  # type: ignore[attr-defined]
    m.gpu = lambda *a, **kw: None  # type: ignore[attr-defined]
    sys.modules["decord"] = m


def _color_for_rank(rank: int) -> tuple[int, int, int]:
    """rank=0 (top score) → bright red. lower ranks → cooler colors."""
    palette = [
        (255, 32, 32),    # 0: red (top)
        (255, 160, 32),   # 1: orange
        (255, 255, 32),   # 2: yellow
        (32, 255, 96),    # 3: green
        (32, 192, 255),   # 4: cyan
        (160, 96, 255),   # 5+: purple
    ]
    return palette[min(rank, len(palette) - 1)]


def _draw_mask_overlay(
    img_rgb: np.ndarray,
    mask: np.ndarray,
    color: tuple[int, int, int],
    alpha: float,
) -> np.ndarray:
    """반투명 alpha-blending: out = (1-α) * img + α * color, mask 영역만."""
    out = img_rgb.copy()
    if not mask.any():
        return out
    color_arr = np.array(color, dtype=np.float32)
    blend = (1.0 - alpha) * out[mask].astype(np.float32) + alpha * color_arr
    out[mask] = blend.clip(0, 255).astype(np.uint8)
    return out


def _draw_outline(
    img_rgb: np.ndarray,
    mask: np.ndarray,
    color: tuple[int, int, int],
    thickness: int = 2,
) -> np.ndarray:
    import cv2

    out = img_rgb.copy()
    contours, _ = cv2.findContours(
        mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    cv2.drawContours(out, contours, -1, color, thickness=thickness)
    return out


def _label_at_centroid(
    img_rgb: np.ndarray,
    mask: np.ndarray,
    text: str,
    bg_color: tuple[int, int, int],
) -> np.ndarray:
    import cv2

    if not mask.any():
        return img_rgb
    out = img_rgb.copy()
    ys, xs = np.where(mask)
    cx, cy = int(xs.mean()), int(ys.mean())
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = 0.6
    th = 2
    (w, h), _ = cv2.getTextSize(text, font, scale, th)
    pad = 4
    x0 = max(0, cx - w // 2 - pad)
    y0 = max(0, cy - h - pad - 4)
    x1 = min(out.shape[1] - 1, x0 + w + 2 * pad)
    y1 = min(out.shape[0] - 1, y0 + h + 2 * pad)
    cv2.rectangle(out, (x0, y0), (x1, y1), bg_color, -1)
    text_color = (0, 0, 0) if sum(bg_color) > 380 else (255, 255, 255)
    cv2.putText(out, text, (x0 + pad, y1 - pad - 2), font, scale, text_color, th, cv2.LINE_AA)
    return out


def visualize_sam3_candidates(
    image_path: str,
    output_path: str,
    prompt: str,
    top_k: int = 4,
    confidence_min_for_processor: float = 0.01,
    mask_alpha: float = 0.4,
    show_outline: bool = True,
) -> dict:
    """주어진 이미지에 SAM3 prompt를 적용하고, 상위 candidate들을 overlay 저장.

    Returns:
        {"scores": [...], "n_candidates": int, "saved": output_path}
    """
    _stub_decord_if_missing()
    import cv2
    from PIL import Image
    import torch
    from sam3 import build_sam3_image_model
    from sam3.model.sam3_image_processor import Sam3Processor

    img = Image.open(image_path).convert("RGB")
    img_rgb = np.array(img)
    H, W = img_rgb.shape[:2]

    model = build_sam3_image_model(bpe_path=None)
    proc = Sam3Processor(model, confidence_threshold=confidence_min_for_processor)
    state = proc.set_image(img)
    state = proc.set_text_prompt(state=state, prompt=prompt)

    scores = state.get("scores", [])
    masks = state.get("masks", [])

    if scores is None or len(scores) == 0:
        # nothing detected
        cv2.putText(
            img_rgb,
            f"prompt={prompt!r}  no candidates",
            (10, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (255, 64, 64),
            2,
        )
        Image.fromarray(img_rgb).save(output_path)
        return {"scores": [], "n_candidates": 0, "saved": output_path}

    sc_np = scores.float().cpu().numpy() if torch.is_tensor(scores) else np.asarray(scores)
    order = np.argsort(-sc_np)[:top_k]

    out = img_rgb.copy()
    for rank, idx in enumerate(order):
        mi = masks[idx]
        if torch.is_tensor(mi):
            mb = mi.squeeze(0).float().cpu().numpy() > 0.5
        else:
            mb = np.asarray(mi).astype(bool)
        if mb.shape != (H, W):
            mb = cv2.resize(mb.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST).astype(bool)

        color = _color_for_rank(rank)
        out = _draw_mask_overlay(out, mb, color, alpha=mask_alpha)
        if show_outline:
            out = _draw_outline(out, mb, color, thickness=2)
        score_val = float(sc_np[idx])
        out = _label_at_centroid(out, mb, f"{score_val:.3f}", bg_color=color)

    # 상단 헤더
    header_h = 32
    header = np.zeros((header_h, W, 3), dtype=np.uint8)
    n = len(sc_np)
    cv2.putText(
        header,
        f"prompt={prompt!r}  top{min(top_k, n)}/{n}  scores={list(np.round(sc_np[order], 3))}",
        (8, 22),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (255, 255, 0),
        1,
        cv2.LINE_AA,
    )
    out = np.vstack([header, out])
    from PIL import Image as PILImage

    PILImage.fromarray(out).save(output_path)
    return {
        "scores": [float(s) for s in sc_np[order]],
        "n_candidates": int(len(sc_np)),
        "saved": output_path,
    }


def visualize_renders_dir(
    renders_dir: str,
    output_dir: str,
    prompt: str,
    view_indices: Sequence[int] | None = None,
    top_k: int = 4,
    mask_alpha: float = 0.4,
) -> list[dict]:
    """디렉터리 안의 view_*.png들에 visualize_sam3_candidates 일괄 적용.

    view_indices가 None이면 모든 view 처리.
    """
    os.makedirs(output_dir, exist_ok=True)
    files = sorted(
        f for f in os.listdir(renders_dir) if f.startswith("view_") and f.endswith(".png")
    )
    if view_indices is not None:
        idx_set = set(int(i) for i in view_indices)
        files = [
            f for f in files
            if int(os.path.splitext(f)[0].split("_")[1]) in idx_set
        ]
    results: list[dict] = []
    for f in files:
        in_path = os.path.join(renders_dir, f)
        out_path = os.path.join(output_dir, f"viz_{f}")
        r = visualize_sam3_candidates(
            in_path, out_path, prompt=prompt, top_k=top_k, mask_alpha=mask_alpha
        )
        r["view_file"] = f
        results.append(r)
        print(
            f"  {f}: n_cand={r['n_candidates']}, "
            f"top scores={[round(s, 3) for s in r['scores']]}",
            flush=True,
        )
    return results


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="SAM3 candidate overlay visualizer")
    p.add_argument("--renders_dir", required=True)
    p.add_argument("--output_dir", required=True)
    p.add_argument("--prompt", default="white door")
    p.add_argument("--top_k", type=int, default=4)
    p.add_argument("--alpha", type=float, default=0.4)
    p.add_argument(
        "--views",
        type=str,
        default=None,
        help="콤마로 구분된 view_idx 리스트 (없으면 전체)",
    )
    args = p.parse_args()
    view_indices = (
        [int(s) for s in args.views.split(",")] if args.views else None
    )
    visualize_renders_dir(
        renders_dir=args.renders_dir,
        output_dir=args.output_dir,
        prompt=args.prompt,
        view_indices=view_indices,
        top_k=args.top_k,
        mask_alpha=args.alpha,
    )
