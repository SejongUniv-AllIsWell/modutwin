"""Preprocess SAM masks for Gaussian Grouping training.

Runs SAM's automatic mask generator on each image, assigns globally consistent
IDs across frames via IoU matching, and saves per-image label maps as .npy files.

Usage:
    python -m core.grouping.preprocess_masks \
        --data_dir data/my_scene --factor 4 \
        --sam_checkpoint checkpoints/sam_vit_h.pth \
        --model_type vit_h
"""

import argparse
import json
import os
from pathlib import Path

import cv2
import numpy as np
from tqdm import tqdm


def load_image_paths(data_dir: str, factor: int) -> list:
    """Load sorted image paths from the dataset directory."""
    if factor > 1:
        image_dir = os.path.join(data_dir, f"images_{factor}")
    else:
        image_dir = os.path.join(data_dir, "images")

    if not os.path.exists(image_dir):
        image_dir = os.path.join(data_dir, "images")

    paths = []
    for f in sorted(os.listdir(image_dir)):
        if f.lower().endswith((".png", ".jpg", ".jpeg")):
            paths.append(os.path.join(image_dir, f))
    return paths


def masks_to_label_map(masks: list, H: int, W: int) -> tuple:
    """Convert a list of SAM mask dicts to a single label map.

    Masks are sorted by area (largest first) so smaller masks override
    larger ones, matching SAM's typical output ordering.

    Args:
        masks: List of dicts with 'segmentation' key (bool array [H, W]).
        H, W: Image dimensions.

    Returns:
        label_map: [H, W] int64 label map. Background pixels get label 0.
        num_masks: Number of masks processed.
    """
    label_map = np.zeros((H, W), dtype=np.int64)
    sorted_masks = sorted(masks, key=lambda m: m["area"], reverse=True)
    for i, mask_dict in enumerate(sorted_masks):
        seg = mask_dict["segmentation"]
        label_map[seg] = i + 1  # 1-indexed; 0 = background
    return label_map, len(sorted_masks)


def match_masks_iou(
    prev_label_map: np.ndarray,
    curr_masks: list,
    prev_num_local: int,
    global_id_map: dict,
    next_global_id: int,
    iou_threshold: float = 0.3,
) -> tuple:
    """Match current frame masks to previous frame via IoU, assigning global IDs.

    Args:
        prev_label_map: [H, W] label map from previous frame.
        curr_masks: SAM mask dicts for current frame.
        prev_num_local: Number of local masks in previous frame.
        global_id_map: Dict mapping (frame_idx, local_id) -> global_id.
        next_global_id: Next available global ID.
        iou_threshold: Minimum IoU to consider a match.

    Returns:
        (label_map, num_local, updated global_id_map, next_global_id)
    """
    H, W = prev_label_map.shape
    curr_label_map = np.zeros((H, W), dtype=np.int64)

    sorted_masks = sorted(curr_masks, key=lambda m: m["area"], reverse=True)

    local_to_global = {}
    for i, mask_dict in enumerate(sorted_masks):
        seg = mask_dict["segmentation"]
        local_id = i + 1
        curr_label_map[seg] = local_id

        # Find best IoU match with previous frame
        best_iou = 0.0
        best_prev_label = 0
        prev_labels_in_region = np.unique(prev_label_map[seg])
        for prev_label in prev_labels_in_region:
            if prev_label == 0:
                continue
            prev_mask = prev_label_map == prev_label
            intersection = np.logical_and(seg, prev_mask).sum()
            union = np.logical_and(np.logical_or(seg, prev_mask), True).sum()
            if union == 0:
                continue
            iou = intersection / union
            if iou > best_iou:
                best_iou = iou
                best_prev_label = prev_label

        if best_iou >= iou_threshold:
            matched_global = None
            for (_, lid), gid in global_id_map.items():
                if lid == best_prev_label:
                    matched_global = gid
                    break
            if matched_global is not None:
                local_to_global[local_id] = matched_global
            else:
                local_to_global[local_id] = next_global_id
                next_global_id += 1
        else:
            local_to_global[local_id] = next_global_id
            next_global_id += 1

    # Build global label map
    global_label_map = np.zeros((H, W), dtype=np.int64)
    for local_id, global_id in local_to_global.items():
        global_label_map[curr_label_map == local_id] = global_id

    new_global_id_map = {}
    for local_id, global_id in local_to_global.items():
        new_global_id_map[local_id] = global_id

    return global_label_map, len(sorted_masks), new_global_id_map, next_global_id


def main():
    parser = argparse.ArgumentParser(
        description="Preprocess SAM masks for Gaussian Grouping"
    )
    parser.add_argument(
        "--data_dir", type=str, required=True, help="Path to the scene data directory"
    )
    parser.add_argument(
        "--factor", type=int, default=4, help="Downsample factor (default: 4)"
    )
    parser.add_argument(
        "--sam_checkpoint",
        type=str,
        required=True,
        help="Path to SAM model checkpoint",
    )
    parser.add_argument(
        "--model_type",
        type=str,
        default="vit_h",
        choices=["vit_h", "vit_l", "vit_b"],
        help="SAM model type",
    )
    parser.add_argument(
        "--iou_threshold",
        type=float,
        default=0.3,
        help="IoU threshold for cross-frame mask matching",
    )
    parser.add_argument(
        "--device", type=str, default="cuda", help="Device for SAM inference"
    )
    args = parser.parse_args()

    # Import SAM
    try:
        from segment_anything import SamAutomaticMaskGenerator, sam_model_registry
    except ImportError:
        raise ImportError(
            "segment_anything is required. Install via: "
            "pip install git+https://github.com/facebookresearch/segment-anything.git"
        )

    # Setup output directory
    suffix = f"_{args.factor}" if args.factor > 1 else ""
    output_dir = os.path.join(args.data_dir, f"grouping_masks{suffix}")
    os.makedirs(output_dir, exist_ok=True)

    # Load SAM model
    print(f"Loading SAM model ({args.model_type}) from {args.sam_checkpoint}...")
    sam = sam_model_registry[args.model_type](checkpoint=args.sam_checkpoint)
    sam.to(args.device)
    mask_generator = SamAutomaticMaskGenerator(sam)

    # Load images
    image_paths = load_image_paths(args.data_dir, args.factor)
    print(f"Found {len(image_paths)} images.")

    # Process each image
    prev_label_map = None
    global_id_map = {}
    next_global_id = 1  # 0 is reserved for background
    max_global_id = 0

    for idx, img_path in enumerate(tqdm(image_paths, desc="Generating SAM masks")):
        stem = Path(img_path).stem
        out_path = os.path.join(output_dir, f"{stem}.npy")

        image = cv2.imread(img_path)
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        H, W = image_rgb.shape[:2]

        masks = mask_generator.generate(image_rgb)

        if idx == 0 or prev_label_map is None:
            label_map, num_local = masks_to_label_map(masks, H, W)
            global_label_map = label_map.copy()
            global_id_map = {lid: lid for lid in range(1, num_local + 1)}
            next_global_id = num_local + 1
        else:
            global_label_map, num_local, global_id_map, next_global_id = (
                match_masks_iou(
                    prev_label_map,
                    masks,
                    0,
                    {(0, k): v for k, v in global_id_map.items()},
                    next_global_id,
                    iou_threshold=args.iou_threshold,
                )
            )

        max_global_id = max(max_global_id, global_label_map.max())
        prev_label_map = global_label_map

        np.save(out_path, global_label_map)

    # Save metadata
    num_classes = int(max_global_id) + 1
    meta = {"num_classes": num_classes}
    meta_path = os.path.join(args.data_dir, "grouping_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"Saved {len(image_paths)} mask files to {output_dir}")
    print(f"Total classes (including background): {num_classes}")
    print(f"Metadata saved to {meta_path}")


if __name__ == "__main__":
    main()
