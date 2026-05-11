"""Phase 3/5 — SAM3 text-prompted segmentation.

D2: confidence threshold 0.8 (sub-threshold 결과는 mask 자체를 버림).
core/select_gaussians/auto.py:segment_images_sam3 의 inference 패턴 채용.

Output layout (plan v2 §2):
    <subdir>/masks/view_{i:04d}.png   # uint8 binary mask (0|255)
    <subdir>/scores.json              # per-view metadata
"""

from __future__ import annotations

import json
import os
import sys
import types
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


def run_sam3(
    image_paths: list[str],
    output_subdir: str,
    prompt: str = "door",
    confidence_threshold: float = 0.8,
    device: str = "cuda",
    checkpoint_path: Optional[str] = None,
) -> dict:
    """SAM3 text-prompted segmentation.

    각 이미지에 대해 SAM3로 prompt 마스크 추정. confidence ≥ threshold인
    detection들을 OR로 합쳐 단일 binary mask로 저장. threshold 미달 view는
    저장하지 않음 (D2).

    Args:
        image_paths: 입력 이미지 경로들 (Phase 2 / Phase 5의 PNG).
        output_subdir: 출력 베이스 디렉터리. masks/ 와 scores.json 생성.
        prompt: 텍스트 프롬프트 (default "door").
        confidence_threshold: D2 default 0.8.
        device: 'cuda' | 'cpu'.
        checkpoint_path: 로컬 SAM3 checkpoint 경로. None이면 HF에서 다운로드
            (HF_TOKEN 환경변수 필요).

    Returns:
        {
            "threshold": float, "prompt": str,
            "n_total_views": int, "n_views_with_detection": int,
            "scores_path": str,
            "views": [
                {"view_idx": int, "max_score": float|None,
                 "mask_path": str|None, "n_detections": int}
            ]
        }
    """
    _stub_decord_if_missing()

    import torch
    from PIL import Image
    from tqdm import tqdm

    from sam3 import build_sam3_image_model  # type: ignore[import]
    from sam3.model.sam3_image_processor import Sam3Processor  # type: ignore[import]

    masks_dir = os.path.join(output_subdir, "masks")
    _ensure_dir(masks_dir)

    # BPE vocab 파일: repo 내 assets/ 에 번들된 파일을 우선 사용.
    # sam3 wheel에 assets/ 폴더가 누락된 경우를 방어.
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
    # sub-threshold detections도 처리할 수 있게 processor는 낮춰둔다.
    # 최종 threshold(D2 0.8) 비교는 아래에서 직접.
    processor = Sam3Processor(model, confidence_threshold=0.1)

    views_meta: list[dict] = []
    n_kept = 0

    autocast_ctx = (
        torch.autocast("cuda", dtype=torch.bfloat16)
        if device.startswith("cuda")
        else torch.autocast("cpu", dtype=torch.float32)
    )

    with torch.inference_mode(), autocast_ctx:
        for i, img_path in enumerate(
            tqdm(image_paths, desc=f"SAM3[{prompt}]")
        ):
            view_idx = _view_idx_from_path(img_path, fallback=i)
            image = Image.open(img_path).convert("RGB")
            state = processor.set_image(image)
            state = processor.set_text_prompt(state=state, prompt=prompt)

            scores = state.get("scores", [])
            sam_masks = state.get("masks", [])

            if scores is None or len(scores) == 0:
                views_meta.append(_no_detection(view_idx))
                continue

            scores_np = (
                scores.float().cpu().numpy()
                if torch.is_tensor(scores)
                else np.asarray(scores, dtype=np.float32)
            )
            valid = scores_np >= confidence_threshold
            n_detections = int(valid.sum())

            if n_detections == 0:
                views_meta.append(_no_detection(view_idx, max_score=float(scores_np.max())))
                continue

            H, W = image.size[1], image.size[0]
            combined = np.zeros((H, W), dtype=bool)
            for j in range(len(scores_np)):
                if not valid[j]:
                    continue
                mj = sam_masks[j]
                if torch.is_tensor(mj):
                    mj_np = mj.squeeze(0).float().cpu().numpy() > 0.5
                else:
                    mj_np = np.asarray(mj).astype(bool)
                if mj_np.shape != (H, W):
                    # SAM3 mask는 입력 해상도와 일치한다고 가정. 어긋나면 NN 리사이즈.
                    import cv2

                    mj_np = (
                        cv2.resize(
                            mj_np.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST
                        ).astype(bool)
                    )
                combined |= mj_np

            mask_filename = f"view_{view_idx:04d}.png"
            mask_path = os.path.join(masks_dir, mask_filename)
            _save_binary_mask(combined, mask_path)
            n_kept += 1

            views_meta.append(
                {
                    "view_idx": int(view_idx),
                    "max_score": float(scores_np[valid].max()),
                    "mask_path": mask_path,
                    "n_detections": n_detections,
                }
            )

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
    """view_0007.png → 7."""
    base = os.path.splitext(os.path.basename(path))[0]
    if base.startswith("view_"):
        try:
            return int(base[len("view_") :])
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
    """SAM3 model + processor를 한 번 로드해 반복 추론에 재사용.

    Returns:
        (model, processor) tuple.
    """
    _stub_decord_if_missing()

    from sam3 import build_sam3_image_model  # type: ignore[import]
    from sam3.model.sam3_image_processor import Sam3Processor  # type: ignore[import]

    # BPE vocab 파일: repo 내 assets/ 에 번들된 파일을 우선 사용.
    # sam3 wheel에 assets/ 폴더가 누락된 경우를 방어.
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
    """이미 로드된 SAM3 model/processor로 단일 이미지 추론.

    Returns:
        {view_idx, max_score, mask_path, n_detections} dict.
    """
    import torch
    from PIL import Image

    masks_dir = os.path.join(output_subdir, "masks")
    _ensure_dir(masks_dir)

    autocast_ctx = (
        torch.autocast("cuda", dtype=torch.bfloat16)
        if device.startswith("cuda")
        else torch.autocast("cpu", dtype=torch.float32)
    )

    with torch.inference_mode(), autocast_ctx:
        image = Image.open(image_path).convert("RGB")
        state = processor.set_image(image)
        state = processor.set_text_prompt(state=state, prompt=prompt)

        scores = state.get("scores", [])
        sam_masks = state.get("masks", [])

        if scores is None or len(scores) == 0:
            return _no_detection(view_idx)

        scores_np = (
            scores.float().cpu().numpy()
            if torch.is_tensor(scores)
            else np.asarray(scores, dtype=np.float32)
        )
        valid = scores_np >= confidence_threshold
        n_detections = int(valid.sum())

        if n_detections == 0:
            return _no_detection(view_idx, max_score=float(scores_np.max()))

        H, W = image.size[1], image.size[0]
        combined = np.zeros((H, W), dtype=bool)
        for j in range(len(scores_np)):
            if not valid[j]:
                continue
            mj = sam_masks[j]
            if torch.is_tensor(mj):
                mj_np = mj.squeeze(0).float().cpu().numpy() > 0.5
            else:
                mj_np = np.asarray(mj).astype(bool)
            if mj_np.shape != (H, W):
                import cv2
                mj_np = cv2.resize(
                    mj_np.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST
                ).astype(bool)
            combined |= mj_np

        mask_filename = f"view_{view_idx:04d}.png"
        mask_path = os.path.join(masks_dir, mask_filename)
        _save_binary_mask(combined, mask_path)

        return {
            "view_idx": int(view_idx),
            "max_score": float(scores_np[valid].max()),
            "mask_path": mask_path,
            "n_detections": n_detections,
        }


def list_input_pngs(renders_dir: str) -> list[str]:
    """view_*.png를 view_idx 오름차순 리턴."""
    if not os.path.isdir(renders_dir):
        raise FileNotFoundError(renders_dir)
    files = [f for f in os.listdir(renders_dir) if f.startswith("view_") and f.endswith(".png")]
    files.sort(key=lambda f: _view_idx_from_path(f, fallback=10**9))
    return [os.path.join(renders_dir, f) for f in files]
