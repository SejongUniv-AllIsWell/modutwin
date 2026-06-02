"""Phase 3/5 — SAM3 text-prompted segmentation.

기존 구현은 한 렌더에서 threshold 이상인 detection들을 그대로 OR 했다.
이 방식은 자산에 따라 문이 아닌 밝은 벽/프레임/가구가 함께 합쳐지는 문제가 있었다.

개선점:
- 렌더 단계가 저장한 sibling variants (`view_0001__albedo.png` 등)를 함께 평가
- detection별로 기하 품질을 점수화해서 단일 문 가정에 맞는 후보만 선택
- 선택된 후보와 강하게 겹치는 detection만 merge
- morphology + largest-component 정리 후 최종 mask 저장
"""

from __future__ import annotations

import json
import os
import re
import sys
import types
from contextlib import nullcontext
from typing import Optional

import numpy as np


def _stub_decord_if_missing() -> None:
    """sam3의 import chain이 sam3.train.data → decord(video reader)를 끌어옴.
    aarch64 wheel이 PyPI에 없으므로 import만 통과시키는 stub을 주입한다.
    image-only 경로에서는 VideoReader/cpu가 호출되지 않음.
    """
    if "decord" in sys.modules:
        return
    try:
        import decord  # noqa: F401
        return
    except ImportError:
        pass

    m = types.ModuleType("decord")

    class _VideoReaderStub:
        def __init__(self, *a, **kw):
            raise NotImplementedError(
                "decord is stubbed (no aarch64 wheel). Video features unused in "
                "door_detection pipeline."
            )

    m.VideoReader = _VideoReaderStub  # type: ignore[attr-defined]
    m.cpu = lambda *a, **kw: None  # type: ignore[attr-defined]
    m.gpu = lambda *a, **kw: None  # type: ignore[attr-defined]
    sys.modules["decord"] = m


def _ensure_dir(p: str) -> None:
    os.makedirs(p, exist_ok=True)


def _save_binary_mask(mask: np.ndarray, path: str) -> None:
    from PIL import Image

    Image.fromarray((mask.astype(bool) * 255).astype(np.uint8)).save(path)


def _resize_mask(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    import cv2

    if mask.shape == (height, width):
        return mask.astype(bool)
    return cv2.resize(
        mask.astype(np.uint8), (width, height), interpolation=cv2.INTER_NEAREST
    ).astype(bool)


def _odd_kernel(size: int) -> int:
    size = max(3, int(size))
    return size if size % 2 == 1 else size + 1


def _largest_component(mask: np.ndarray) -> np.ndarray:
    import cv2

    mask_u8 = mask.astype(np.uint8)
    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    if n_labels <= 1:
        return mask_u8.astype(bool)
    largest_idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return labels == largest_idx


def _cleanup_mask(mask: np.ndarray, strengthen: bool = False) -> np.ndarray:
    import cv2

    mask_u8 = mask.astype(np.uint8)
    if mask_u8.sum() == 0:
        return mask_u8.astype(bool)

    base = min(mask_u8.shape)
    k_close = _odd_kernel(min(11, max(3, round(base * 0.012))))
    k_open = _odd_kernel(min(7, max(3, round(base * 0.006))))
    if strengthen:
        k_close = _odd_kernel(k_close + 2)

    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_close, k_close))
    open_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_open, k_open))

    cleaned = cv2.morphologyEx(mask_u8, cv2.MORPH_CLOSE, close_kernel)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, open_kernel)
    cleaned = _largest_component(cleaned > 0).astype(np.uint8)
    if strengthen:
        cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, close_kernel)
        cleaned = _largest_component(cleaned > 0).astype(np.uint8)
    return cleaned.astype(bool)


def _mask_boundary_touch(mask: np.ndarray, margin: int) -> bool:
    if margin <= 0:
        return False
    return bool(
        mask[:margin, :].any()
        or mask[-margin:, :].any()
        or mask[:, :margin].any()
        or mask[:, -margin:].any()
    )


def _mask_compactness(mask: np.ndarray) -> float:
    import cv2

    area = float(mask.sum())
    if area <= 0:
        return 0.0
    contours, _ = cv2.findContours(
        mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    if not contours:
        return 0.0
    hull = cv2.convexHull(max(contours, key=cv2.contourArea))
    hull_area = float(cv2.contourArea(hull))
    if hull_area <= 1e-6:
        return 0.0
    return float(np.clip(area / hull_area, 0.0, 1.0))


def _largest_two_components(mask: np.ndarray) -> tuple[int, int]:
    import cv2

    n_labels, _labels, stats, _ = cv2.connectedComponentsWithStats(
        mask.astype(np.uint8), connectivity=8
    )
    if n_labels <= 1:
        return 0, 0
    areas = np.sort(stats[1:, cv2.CC_STAT_AREA])[::-1]
    a1 = int(areas[0]) if len(areas) > 0 else 0
    a2 = int(areas[1]) if len(areas) > 1 else 0
    return a1, a2


def _mask_quality(mask: np.ndarray) -> dict[str, float | bool]:
    area = float(mask.sum())
    if area <= 0:
        return {
            "score": 0.0,
            "area_ratio": 0.0,
            "compactness": 0.0,
            "aspect": 0.0,
            "touches_boundary": False,
            "second_ratio": 0.0,
        }

    ys, xs = np.where(mask)
    h, w = mask.shape
    area_ratio = area / float(h * w)

    bbox_w = float(xs.max() - xs.min() + 1)
    bbox_h = float(ys.max() - ys.min() + 1)
    aspect = max(bbox_h, bbox_w) / max(1.0, min(bbox_h, bbox_w))

    compactness = _mask_compactness(mask)
    touches_boundary = _mask_boundary_touch(mask, margin=max(8, min(h, w) // 64))
    a1, a2 = _largest_two_components(mask)
    second_ratio = float(a2 / a1) if a1 > 0 else 0.0

    target_area = 0.16
    area_score = float(
        np.clip(
            1.0 - abs(np.log(max(area_ratio, 1e-6) / target_area)) / np.log(8.0),
            0.0,
            1.0,
        )
    )
    aspect_score = float(np.clip(1.0 - abs(aspect - 1.9) / 1.6, 0.0, 1.0))
    component_score = float(np.clip(1.0 - second_ratio / 0.45, 0.0, 1.0))

    score = (
        0.35 * area_score
        + 0.30 * compactness
        + 0.20 * aspect_score
        + 0.15 * component_score
    )
    if touches_boundary:
        score *= 0.75

    return {
        "score": float(np.clip(score, 0.0, 1.0)),
        "area_ratio": float(area_ratio),
        "compactness": float(compactness),
        "aspect": float(aspect),
        "touches_boundary": bool(touches_boundary),
        "second_ratio": float(second_ratio),
    }


def _mask_iou(mask_a: np.ndarray, mask_b: np.ndarray) -> float:
    inter = float(np.logical_and(mask_a, mask_b).sum())
    union = float(np.logical_or(mask_a, mask_b).sum())
    if union <= 0.0:
        return 0.0
    return inter / union


def _mask_containment(mask_a: np.ndarray, mask_b: np.ndarray) -> float:
    inter = float(np.logical_and(mask_a, mask_b).sum())
    denom = float(min(mask_a.sum(), mask_b.sum()))
    if denom <= 0.0:
        return 0.0
    return inter / denom


def _extract_detection_candidates(
    scores_np: np.ndarray,
    sam_masks,
    width: int,
    height: int,
    confidence_threshold: float,
) -> list[dict]:
    import torch

    candidates: list[dict] = []
    for idx, sam_score in enumerate(scores_np):
        if float(sam_score) < confidence_threshold:
            continue
        mask_i = sam_masks[idx]
        if torch.is_tensor(mask_i):
            mask_np = mask_i.squeeze(0).float().cpu().numpy() > 0.5
        else:
            mask_np = np.asarray(mask_i).astype(bool)
        mask_np = _resize_mask(mask_np, width=width, height=height)
        mask_np = _cleanup_mask(mask_np)
        if not mask_np.any():
            continue
        quality = _mask_quality(mask_np)
        rank = float(sam_score) + 0.18 * float(quality["score"])
        candidates.append(
            {
                "idx": int(idx),
                "sam_score": float(sam_score),
                "mask": mask_np,
                "quality": quality,
                "rank": rank,
            }
        )
    return candidates


def _merge_best_overlapping_candidates(candidates: list[dict]) -> dict:
    best = max(candidates, key=lambda c: (c["rank"], c["sam_score"]))
    merged = best["mask"].copy()
    merged_scores = [float(best["sam_score"])]
    merged_count = 1

    for cand in candidates:
        if cand is best:
            continue
        if float(cand["sam_score"]) < float(best["sam_score"]) - 0.08:
            continue
        iou = _mask_iou(best["mask"], cand["mask"])
        containment = _mask_containment(best["mask"], cand["mask"])
        if iou >= 0.35 or containment >= 0.65:
            merged |= cand["mask"]
            merged_scores.append(float(cand["sam_score"]))
            merged_count += 1

    merged = _cleanup_mask(merged, strengthen=merged_count > 1)
    quality = _mask_quality(merged)
    variant_score = max(merged_scores) + 0.22 * float(quality["score"])

    return {
        "mask": merged,
        "max_score": float(max(merged_scores)),
        "n_detections": len(candidates),
        "merged_detections": merged_count,
        "quality": quality,
        "variant_score": float(variant_score),
    }


def _variant_name_from_path(path: str) -> str:
    base = os.path.splitext(os.path.basename(path))[0]
    if "__" in base:
        return base.split("__", 1)[1]
    return "canonical"


def _expand_variant_paths(canonical_path: str) -> list[str]:
    directory = os.path.dirname(canonical_path) or "."
    stem = os.path.splitext(os.path.basename(canonical_path))[0]
    prefix = f"{stem}__"

    variants = [canonical_path]
    if not os.path.isdir(directory):
        return variants

    sibling_files = [
        f for f in os.listdir(directory)
        if f.startswith(prefix) and f.endswith(".png")
    ]
    sibling_files.sort()
    variants.extend(os.path.join(directory, f) for f in sibling_files)
    return variants


def _run_sam3_for_image_variants(
    canonical_path: str,
    processor,
    prompt: str,
    confidence_threshold: float,
    fallback_view_idx: int,
) -> dict:
    import torch
    from PIL import Image

    variant_paths = _expand_variant_paths(canonical_path)
    view_idx = _view_idx_from_path(canonical_path, fallback=fallback_view_idx)
    variant_results: list[dict] = []
    max_score_seen: Optional[float] = None

    for variant_path in variant_paths:
        image = Image.open(variant_path).convert("RGB")
        state = processor.set_image(image)
        state = processor.set_text_prompt(state=state, prompt=prompt)

        scores = state.get("scores", [])
        sam_masks = state.get("masks", [])
        if scores is None or len(scores) == 0:
            continue

        scores_np = (
            scores.float().cpu().numpy()
            if torch.is_tensor(scores)
            else np.asarray(scores, dtype=np.float32)
        )
        if scores_np.size > 0:
            current_max = float(scores_np.max())
            max_score_seen = current_max if max_score_seen is None else max(max_score_seen, current_max)

        candidates = _extract_detection_candidates(
            scores_np=scores_np,
            sam_masks=sam_masks,
            width=image.size[0],
            height=image.size[1],
            confidence_threshold=confidence_threshold,
        )
        if not candidates:
            continue

        merged = _merge_best_overlapping_candidates(candidates)
        variant_results.append(
            {
                "variant": _variant_name_from_path(variant_path),
                "source_image_path": variant_path,
                **merged,
            }
        )

    if not variant_results:
        return _no_detection(view_idx=view_idx, max_score=max_score_seen)

    best = max(
        variant_results,
        key=lambda r: (
            float(r["variant_score"]),
            float(r["max_score"]),
            float(r["quality"]["score"]),
        ),
    )
    return {
        "view_idx": int(view_idx),
        "max_score": float(best["max_score"]),
        "mask": best["mask"],
        "mask_path": None,
        "n_detections": int(best["n_detections"]),
        "merged_detections": int(best["merged_detections"]),
        "variant": str(best["variant"]),
        "variant_score": float(best["variant_score"]),
        "quality": best["quality"],
        "candidate_variants": [
            {
                "variant": str(v["variant"]),
                "max_score": float(v["max_score"]),
                "variant_score": float(v["variant_score"]),
                "quality_score": float(v["quality"]["score"]),
            }
            for v in sorted(
                variant_results,
                key=lambda item: float(item["variant_score"]),
                reverse=True,
            )
        ],
    }


def run_sam3(
    image_paths: list[str],
    output_subdir: str,
    prompt: str = "door",
    confidence_threshold: float = 0.8,
    device: str = "cuda",
    checkpoint_path: Optional[str] = None,
) -> dict:
    """SAM3 text-prompted segmentation.

    각 logical view에 대해 canonical render + sibling variants를 함께 평가하고,
    가장 신뢰도 높은 단일 문 mask만 저장한다.
    """
    _stub_decord_if_missing()

    import torch
    from tqdm import tqdm

    masks_dir = os.path.join(output_subdir, "masks")
    _ensure_dir(masks_dir)

    model, processor = load_sam3_model_and_processor(
        device=device,
        checkpoint_path=checkpoint_path,
    )
    del model

    views_meta: list[dict] = []
    n_kept = 0

    autocast_ctx = (
        torch.autocast("cuda", dtype=torch.bfloat16)
        if device.startswith("cuda")
        else nullcontext()
    )

    with torch.inference_mode(), autocast_ctx:
        for i, img_path in enumerate(tqdm(image_paths, desc=f"SAM3[{prompt}]")):
            view_result = _run_sam3_for_image_variants(
                canonical_path=img_path,
                processor=processor,
                prompt=prompt,
                confidence_threshold=confidence_threshold,
                fallback_view_idx=i,
            )

            if view_result["mask_path"] is None and "mask" in view_result:
                mask_filename = f"view_{view_result['view_idx']:04d}.png"
                mask_path = os.path.join(masks_dir, mask_filename)
                _save_binary_mask(view_result["mask"], mask_path)
                view_result["mask_path"] = mask_path
                del view_result["mask"]

            if view_result["mask_path"] is not None:
                n_kept += 1
            views_meta.append(view_result)

    summary = {
        "threshold": float(confidence_threshold),
        "prompt": prompt,
        "n_total_views": len(image_paths),
        "n_views_with_detection": n_kept,
        "views": views_meta,
    }
    scores_path = os.path.join(output_subdir, "scores.json")
    with open(scores_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    summary["scores_path"] = scores_path
    return summary


def _view_idx_from_path(path: str, fallback: int) -> int:
    """`view_0007.png`, `view_0007__albedo.png` -> 7."""
    base = os.path.splitext(os.path.basename(path))[0]
    m = re.match(r"^view_(\d+)", base)
    if m is not None:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    return fallback


def _no_detection(view_idx: int, max_score: Optional[float] = None) -> dict:
    return {
        "view_idx": int(view_idx),
        "max_score": None if max_score is None else float(max_score),
        "mask_path": None,
        "n_detections": 0,
    }


def load_sam3_model_and_processor(
    device: str = "cuda",
    checkpoint_path: Optional[str] = None,
):
    """SAM3 model + processor를 한 번 로드해 반복 추론에 재사용."""
    _stub_decord_if_missing()

    from sam3 import build_sam3_image_model  # type: ignore[import]
    from sam3.model.sam3_image_processor import Sam3Processor  # type: ignore[import]

    _bpe_bundled = os.path.join(
        os.path.dirname(__file__), "..", "assets", "bpe_simple_vocab_16e6.txt.gz"
    )
    _bpe_path = _bpe_bundled if os.path.exists(_bpe_bundled) else None

    build_kwargs: dict = {"bpe_path": _bpe_path}
    if checkpoint_path is not None:
        build_kwargs["checkpoint_path"] = checkpoint_path
    model = build_sam3_image_model(**build_kwargs)
    if hasattr(model, "to"):
        model = model.to(device)
    processor = Sam3Processor(model, confidence_threshold=0.1)
    return model, processor


def run_sam3_single_with_model(
    image_path: str,
    model,
    processor,
    output_subdir: str,
    view_idx: int,
    prompt: str,
    confidence_threshold: float,
    device: str,
) -> dict:
    """이미 로드된 SAM3 model/processor로 단일 logical view 추론."""
    import torch

    del model

    masks_dir = os.path.join(output_subdir, "masks")
    _ensure_dir(masks_dir)

    autocast_ctx = (
        torch.autocast("cuda", dtype=torch.bfloat16)
        if device.startswith("cuda")
        else nullcontext()
    )

    with torch.inference_mode(), autocast_ctx:
        result = _run_sam3_for_image_variants(
            canonical_path=image_path,
            processor=processor,
            prompt=prompt,
            confidence_threshold=confidence_threshold,
            fallback_view_idx=view_idx,
        )

    if result["mask_path"] is None and "mask" in result:
        mask_filename = f"view_{result['view_idx']:04d}.png"
        mask_path = os.path.join(masks_dir, mask_filename)
        _save_binary_mask(result["mask"], mask_path)
        result["mask_path"] = mask_path
        del result["mask"]

    return result


def list_input_pngs(renders_dir: str) -> list[str]:
    """canonical `view_*.png`만 view_idx 오름차순으로 리턴.

    sibling variants (`view_0001__albedo.png`)는 개별 logical view 처리 시 내부에서
    자동 확장한다.
    """
    if not os.path.isdir(renders_dir):
        raise FileNotFoundError(renders_dir)
    files = [
        f
        for f in os.listdir(renders_dir)
        if re.match(r"^view_\d+\.png$", f) is not None
    ]
    files.sort(key=lambda f: _view_idx_from_path(f, fallback=10**9))
    return [os.path.join(renders_dir, f) for f in files]
