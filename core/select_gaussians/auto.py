"""Extract Gaussians matching a text prompt using SAM3 segmentation (post-hoc).

Pipeline:
  1. Run SAM3 text-prompted segmentation on training images -> binary masks
  2. Render trained 3DGS model from each camera -> identify contributing Gaussians
  3. Aggregate across views, filter outliers via DBSCAN -> export object Gaussians

Usage:
    python -m core.select_gaussians.auto \
        --model_path results/scene/ply/point_cloud_29999.ply \
        --data_dir data/my_scene \
        --prompt "door" \
        --output_path results/scene/door_gaussians.ply
"""

import argparse
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
from PIL import Image
from tqdm import tqdm

from gsplat import export_splats, rasterization, rasterize_to_indices_in_range

# Add project root to path for utilities import
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from utilities.ply_io import load_ply


# ======================================================================
# Step 1: Model & Data Loading
# ======================================================================


def load_splats(model_path: str) -> dict:
    """Load Gaussian parameters from PLY file or .pt checkpoint."""
    if model_path.endswith(".ply"):
        print(f"[Load] Loading PLY: {model_path}")
        ply_data = load_ply(model_path)
        # Convert to torch tensors
        return {k: torch.from_numpy(v) for k, v in ply_data.items()}
    elif model_path.endswith(".pt"):
        print(f"[Load] Loading checkpoint: {model_path}")
        ckpt = torch.load(model_path, map_location="cpu", weights_only=True)
        splats = {}
        for k, v in ckpt["splats"].items():
            splats[k] = v
        return splats
    else:
        raise ValueError(f"Unsupported model format: {model_path} (use .ply or .pt)")


# ======================================================================
# Step 2: SAM3 Segmentation
# ======================================================================


def segment_images_sam3(
    image_paths: List[str],
    prompt: str,
    confidence_threshold: float = 0.5,
    device: str = "cuda",
    checkpoint_path: str = None,
) -> Dict[int, np.ndarray]:
    """Run SAM3 text-prompted segmentation on training images.

    Args:
        image_paths: List of image file paths.
        prompt: Text prompt (e.g., "door").
        confidence_threshold: Minimum confidence to accept a detection.
        device: Inference device.

    Returns:
        Dict mapping image index -> binary mask [H, W] (bool numpy array).
        Only images with detections above the confidence threshold are included.
    """
    from sam3 import build_sam3_image_model
    from sam3.model.sam3_image_processor import Sam3Processor

    print("[SAM3] Loading model...")
    build_kwargs = {"bpe_path": None}
    if checkpoint_path is not None:
        build_kwargs["checkpoint_path"] = checkpoint_path
    model = build_sam3_image_model(**build_kwargs)
    processor = Sam3Processor(model, confidence_threshold=0.1)
    print(f"[SAM3] Model loaded. Processing {len(image_paths)} images "
          f"with prompt='{prompt}'")

    masks_dict: Dict[int, np.ndarray] = {}

    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
        for idx, img_path in enumerate(tqdm(image_paths, desc="SAM3 segmentation")):
            image = Image.open(img_path).convert("RGB")
            state = processor.set_image(image)
            state = processor.set_text_prompt(state=state, prompt=prompt)

            scores = state.get("scores", [])
            sam_masks = state.get("masks", [])

            if len(scores) == 0:
                continue

            scores_np = (
                scores.float().cpu().numpy()
                if torch.is_tensor(scores)
                else np.array(scores)
            )
            valid = scores_np >= confidence_threshold

            if not valid.any():
                continue

            H, W = image.size[1], image.size[0]
            combined_mask = np.zeros((H, W), dtype=bool)
            for i in range(len(scores_np)):
                if valid[i]:
                    mask_i = sam_masks[i].squeeze(0).float().cpu().numpy() > 0.5
                    combined_mask |= mask_i

            masks_dict[idx] = combined_mask
            max_score = scores_np[valid].max()
            tqdm.write(
                f"  [{idx}] {Path(img_path).name}: "
                f"{valid.sum()} detection(s), max_score={max_score:.3f}"
            )

    print(f"[SAM3] Detected '{prompt}' in {len(masks_dict)}/{len(image_paths)} images")
    return masks_dict


def load_cached_masks(
    masks_dir: str, image_paths: List[str]
) -> Dict[int, np.ndarray]:
    """Load previously saved SAM3 masks from .npy files."""
    masks_dict = {}
    for idx, img_path in enumerate(image_paths):
        stem = Path(img_path).stem
        mask_path = os.path.join(masks_dir, f"{stem}.npy")
        if os.path.exists(mask_path):
            mask = np.load(mask_path)
            if mask.any():
                masks_dict[idx] = mask
    print(f"[Cache] Loaded {len(masks_dict)} cached masks from {masks_dir}")
    return masks_dict


def save_masks(
    masks_dict: Dict[int, np.ndarray],
    image_paths: List[str],
    output_dir: str,
):
    """Save SAM3 masks as .npy files and PNG images."""
    os.makedirs(output_dir, exist_ok=True)
    img_dir = output_dir + "_images"
    os.makedirs(img_dir, exist_ok=True)
    for idx, mask in masks_dict.items():
        stem = Path(image_paths[idx]).stem
        np.save(os.path.join(output_dir, f"{stem}.npy"), mask)
        Image.fromarray((mask * 255).astype(np.uint8)).save(
            os.path.join(img_dir, f"{stem}.png")
        )
    print(f"[Cache] Saved {len(masks_dict)} masks to {output_dir}")
    print(f"[Cache] Saved {len(masks_dict)} mask images to {img_dir}")


# ======================================================================
# Step 3: Gaussian-Pixel Contribution Extraction
# ======================================================================


def find_contributing_gaussians(
    splats: dict,
    parser,
    masks_dict: Dict[int, np.ndarray],
    device: str = "cuda",
    depth_tolerance: Optional[float] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    """Identify which Gaussians contribute to masked pixels across views.

    For each image with a mask:
      1. Render the scene from that camera (packed=False)
      2. Use rasterize_to_indices_in_range to get (gaussian_id, pixel_id) pairs
      3. Filter by mask AND depth proximity to surface
      4. Accumulate vote counts

    Args:
        splats: Gaussian parameter dict.
        parser: COLMAP dataset parser (with camera_ids, Ks_dict, camtoworlds, etc.).
        masks_dict: Dict of image_index -> binary mask [H, W].
        device: Compute device.
        depth_tolerance: Max depth behind surface to accept. None = auto.

    Returns:
        vote_count: [N,] number of views voting this Gaussian as the object.
        visible_count: [N,] number of views where this Gaussian is visible.
    """
    import cv2

    N = splats["means"].shape[0]
    vote_count = np.zeros(N, dtype=np.int32)
    visible_count = np.zeros(N, dtype=np.int32)

    means = splats["means"].to(device)
    quats = splats["quats"].to(device)
    scales = torch.exp(splats["scales"].to(device))
    opacities = torch.sigmoid(splats["opacities"].to(device))
    sh0 = splats["sh0"].to(device)

    if depth_tolerance is None:
        depth_tolerance = parser.scene_scale * 0.1
    use_depth_filter = depth_tolerance > 0
    if use_depth_filter:
        print(f"[Extract] Depth filtering enabled: tolerance={depth_tolerance:.4f}")

    masked_indices = sorted(masks_dict.keys())
    print(f"[Extract] Processing {len(masked_indices)} views with masks...")

    for idx in tqdm(masked_indices, desc="Extracting Gaussian contributions"):
        camera_id = parser.camera_ids[idx]
        K = torch.from_numpy(parser.Ks_dict[camera_id]).float().to(device)
        c2w = torch.from_numpy(parser.camtoworlds[idx]).float().to(device)
        viewmat = torch.linalg.inv(c2w)
        W, H = parser.imsize_dict[camera_id]

        mask_np = masks_dict[idx]
        if mask_np.shape != (H, W):
            mask_np = cv2.resize(
                mask_np.astype(np.uint8), (W, H),
                interpolation=cv2.INTER_NEAREST,
            ).astype(bool)

        with torch.no_grad():
            _, _, info = rasterization(
                means=means,
                quats=quats,
                scales=scales,
                opacities=opacities,
                colors=sh0,
                viewmats=viewmat.unsqueeze(0),
                Ks=K.unsqueeze(0),
                width=W,
                height=H,
                sh_degree=0,
                packed=False,
                near_plane=0.01,
                far_plane=1e10,
            )

            transmittances = torch.ones(1, H, W, device=device)
            gaussian_ids, pixel_ids, _ = rasterize_to_indices_in_range(
                range_start=0,
                range_end=N,
                transmittances=transmittances,
                means2d=info["means2d"],
                conics=info["conics"],
                opacities=info["opacities"],
                image_width=W,
                image_height=H,
                tile_size=info["tile_size"],
                isect_offsets=info["isect_offsets"],
                flatten_ids=info["flatten_ids"],
            )

        g_ids = gaussian_ids.cpu().numpy()
        p_ids = pixel_ids.cpu().numpy()

        unique_visible = np.unique(g_ids)
        visible_count[unique_visible] += 1

        py = p_ids // W
        px = p_ids % W
        in_mask = mask_np[py, px]

        if use_depth_filter and in_mask.any():
            rot = viewmat[:3, :3]
            trans = viewmat[:3, 3]
            depths_all = (rot[2:3, :] @ means.T).squeeze(0) + trans[2]
            depths_all = depths_all.cpu().numpy()

            pair_depths = depths_all[g_ids]
            masked_pair_idx = np.where(in_mask)[0]
            surface_depth = np.full(H * W, np.inf, dtype=np.float32)
            np.minimum.at(
                surface_depth, p_ids[masked_pair_idx],
                pair_depths[masked_pair_idx],
            )

            ref_depth = surface_depth[p_ids]
            depth_ok = pair_depths <= (ref_depth + depth_tolerance)
            in_mask_filtered = in_mask & depth_ok
        else:
            in_mask_filtered = in_mask

        masked_g_ids = g_ids[in_mask_filtered]
        unique_masked = np.unique(masked_g_ids)
        vote_count[unique_masked] += 1

    voted = (vote_count > 0).sum()
    visible = (visible_count > 0).sum()
    print(f"[Extract] {voted} Gaussians voted as object out of {visible} visible")

    return vote_count, visible_count


# ======================================================================
# Step 4: Aggregation & Outlier Removal
# ======================================================================


def aggregate_and_filter(
    means: np.ndarray,
    vote_count: np.ndarray,
    visible_count: np.ndarray,
    scene_scale: float,
    score_threshold: float = 0.3,
    dbscan_eps: Optional[float] = None,
    dbscan_min_samples: int = 10,
) -> np.ndarray:
    """Aggregate multi-view votes and remove outliers via DBSCAN.

    Args:
        means: [N, 3] 3D positions of all Gaussians.
        vote_count: [N,] per-Gaussian vote counts.
        visible_count: [N,] per-Gaussian visibility counts.
        scene_scale: Scene scale for adaptive DBSCAN eps.
        score_threshold: Minimum door_score to be a candidate.
        dbscan_eps: DBSCAN epsilon (auto-scaled if None).
        dbscan_min_samples: DBSCAN minimum cluster size.

    Returns:
        Boolean mask [N,] of selected Gaussians.
    """
    from sklearn.cluster import DBSCAN

    N = len(means)
    final_mask = np.zeros(N, dtype=bool)

    door_score = np.zeros(N, dtype=np.float32)
    visible_mask = visible_count > 0
    door_score[visible_mask] = vote_count[visible_mask] / visible_count[visible_mask]

    candidates = door_score >= score_threshold
    n_candidates = candidates.sum()
    print(f"[Aggregate] Score threshold >= {score_threshold}: {n_candidates} candidates")

    if n_candidates == 0:
        print("[Aggregate] No candidates found. Try lowering --score_threshold.")
        return final_mask

    eps = dbscan_eps if dbscan_eps is not None else scene_scale * 0.02
    print(f"[Aggregate] DBSCAN eps={eps:.4f}, min_samples={dbscan_min_samples}")

    candidate_means = means[candidates]
    clustering = DBSCAN(eps=eps, min_samples=dbscan_min_samples).fit(candidate_means)
    labels = clustering.labels_

    valid_labels = labels[labels >= 0]
    if len(valid_labels) == 0:
        print("[Aggregate] DBSCAN found no clusters. Try increasing --dbscan_eps.")
        final_mask[candidates] = True
        return final_mask

    unique_labels, label_counts = np.unique(valid_labels, return_counts=True)
    largest_idx = np.argmax(label_counts)
    largest_label = unique_labels[largest_idx]
    largest_count = label_counts[largest_idx]

    print(f"[Aggregate] Found {len(unique_labels)} clusters. "
          f"Largest: label={largest_label}, size={largest_count}")
    for lbl, cnt in zip(unique_labels, label_counts):
        print(f"  Cluster {lbl}: {cnt} Gaussians")

    cluster_mask_local = labels == largest_label
    candidate_indices = np.where(candidates)[0]
    selected_indices = candidate_indices[cluster_mask_local]
    final_mask[selected_indices] = True

    # Planarity analysis
    pts = means[final_mask]
    centroid = pts.mean(axis=0)
    pts_c = pts - centroid
    cov = pts_c.T @ pts_c / len(pts_c)
    eigvals = np.linalg.eigvalsh(cov)
    eigvals = np.sort(eigvals)[::-1]
    planarity = 1.0 - eigvals[2] / eigvals[1] if eigvals[1] > 1e-8 else 0
    bbox = pts.max(axis=0) - pts.min(axis=0)

    print(f"[Aggregate] Final selection: {final_mask.sum()} Gaussians")
    print(f"  Centroid: ({centroid[0]:.3f}, {centroid[1]:.3f}, {centroid[2]:.3f})")
    print(f"  BBox: ({bbox[0]:.3f}, {bbox[1]:.3f}, {bbox[2]:.3f})")
    print(f"  Planarity: {planarity:.4f} (1.0 = perfectly planar)")

    return final_mask


# ======================================================================
# Step 5: Export
# ======================================================================


def export_extracted_gaussians(
    splats: dict,
    mask: np.ndarray,
    output_path: str,
):
    """Export selected Gaussians to PLY file."""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    export_splats(
        means=splats["means"][mask],
        scales=splats["scales"][mask],
        quats=splats["quats"][mask],
        opacities=splats["opacities"][mask],
        sh0=splats["sh0"][mask],
        shN=splats["shN"][mask],
        format="ply",
        save_to=output_path,
    )
    print(f"[Export] Saved {mask.sum()} Gaussians to {output_path}")


# ======================================================================
# Main Pipeline
# ======================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Extract Gaussians matching a text prompt using SAM3 segmentation"
    )
    parser.add_argument(
        "--model_path", type=str, required=True,
        help="Path to trained .ply or .pt checkpoint",
    )
    parser.add_argument(
        "--data_dir", type=str, required=True,
        help="Path to COLMAP dataset directory",
    )
    parser.add_argument("--data_factor", type=int, default=4,
                        help="Image downsample factor (must match training)")
    parser.add_argument("--normalize", action="store_true",
                        help="Apply scene normalization (must match training)")
    parser.add_argument("--prompt", type=str, default="door",
                        help="Text prompt for SAM3 segmentation")
    parser.add_argument("--sam3_confidence", type=float, default=0.5,
                        help="SAM3 confidence threshold")
    parser.add_argument("--sam3_checkpoint", type=str, default=None,
                        help="Path to local SAM3 checkpoint")
    parser.add_argument("--score_threshold", type=float, default=0.3,
                        help="Minimum fraction of views voting for object")
    parser.add_argument("--dbscan_eps", type=float, default=None,
                        help="DBSCAN epsilon (auto-scaled if None)")
    parser.add_argument("--dbscan_min_samples", type=int, default=10,
                        help="DBSCAN minimum cluster size")
    parser.add_argument("--depth_tolerance", type=float, default=None,
                        help="Depth filter tolerance (auto if None, 0=disabled)")
    parser.add_argument("--output_path", type=str, default=None,
                        help="Output PLY path (default: <model_dir>/<prompt>_gaussians.ply)")
    parser.add_argument("--save_masks", action="store_true",
                        help="Save SAM3 masks as .npy files for reuse")
    parser.add_argument("--masks_dir", type=str, default=None,
                        help="Load existing masks from this directory (skip SAM3)")
    parser.add_argument("--device", type=str, default="cuda")
    args = parser.parse_args()

    if args.output_path is None:
        model_dir = os.path.dirname(args.model_path)
        args.output_path = os.path.join(model_dir, f"{args.prompt}_gaussians.ply")

    print("=" * 60)
    print("Gaussian Extraction Pipeline (SAM3 + gsplat)")
    print("=" * 60)
    print(f"  Model: {args.model_path}")
    print(f"  Data:  {args.data_dir}")
    print(f"  Prompt: '{args.prompt}'")
    print(f"  Output: {args.output_path}")
    print()

    # Step 1: Load model and data
    print("-- Step 1: Loading model and dataset --")
    splats = load_splats(args.model_path)
    N = splats["means"].shape[0]
    print(f"[Load] {N} Gaussians loaded")

    # Import COLMAP parser from gsplat examples (external dependency)
    from datasets.colmap import Parser as ColmapParser

    colmap_parser = ColmapParser(
        data_dir=args.data_dir,
        factor=args.data_factor,
        normalize=args.normalize,
    )
    print(f"[Load] {len(colmap_parser.image_paths)} images, "
          f"scene_scale={colmap_parser.scene_scale:.4f}")
    print()

    # Step 2: SAM3 segmentation
    print("-- Step 2: SAM3 Segmentation --")
    if args.masks_dir is None:
        auto_masks_dir = os.path.join(args.data_dir, f"sam3_masks_{args.prompt}")
        if os.path.isdir(auto_masks_dir):
            args.masks_dir = auto_masks_dir
            print(f"[Cache] Found existing masks at {auto_masks_dir}")

    if args.masks_dir is not None:
        masks_dict = load_cached_masks(args.masks_dir, colmap_parser.image_paths)
    else:
        masks_dict = segment_images_sam3(
            image_paths=colmap_parser.image_paths,
            prompt=args.prompt,
            confidence_threshold=args.sam3_confidence,
            device=args.device,
            checkpoint_path=args.sam3_checkpoint,
        )
        if args.save_masks:
            masks_save_dir = os.path.join(args.data_dir, f"sam3_masks_{args.prompt}")
            save_masks(masks_dict, colmap_parser.image_paths, masks_save_dir)

    if len(masks_dict) == 0:
        print(f"[Error] SAM3 did not detect '{args.prompt}' in any image. Exiting.")
        sys.exit(1)
    print()

    # Step 3: Extract contributing Gaussians
    print("-- Step 3: Gaussian-Pixel Contribution Extraction --")
    vote_count, visible_count = find_contributing_gaussians(
        splats=splats,
        parser=colmap_parser,
        masks_dict=masks_dict,
        device=args.device,
        depth_tolerance=args.depth_tolerance,
    )
    print()

    # Step 4: Aggregate and filter
    print("-- Step 4: Multi-View Aggregation & Outlier Removal --")
    final_mask = aggregate_and_filter(
        means=splats["means"].numpy(),
        vote_count=vote_count,
        visible_count=visible_count,
        scene_scale=colmap_parser.scene_scale,
        score_threshold=args.score_threshold,
        dbscan_eps=args.dbscan_eps,
        dbscan_min_samples=args.dbscan_min_samples,
    )
    print()

    if final_mask.sum() == 0:
        print("[Error] No Gaussians passed filtering. Try adjusting thresholds.")
        sys.exit(1)

    # Step 5: Export
    print("-- Step 5: Export --")
    export_extracted_gaussians(splats, final_mask, args.output_path)

    meta_path = args.output_path.replace(".ply", "_meta.npz")
    np.savez(
        meta_path,
        vote_count=vote_count,
        visible_count=visible_count,
        final_mask=final_mask,
    )
    print(f"[Export] Metadata saved to {meta_path}")

    print()
    print("=" * 60)
    print("Done!")
    print(f"  Total Gaussians: {N}")
    print(f"  Extracted: {final_mask.sum()} ({100.0 * final_mask.sum() / N:.2f}%)")
    print(f"  Output: {args.output_path}")
    print("=" * 60)


if __name__ == "__main__":
    main()
