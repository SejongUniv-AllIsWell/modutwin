"""Extract Gaussians belonging to specific semantic labels after Gaussian Grouping training.

Filters Gaussians by target label IDs and exports them to a new PLY file,
enabling downstream tasks like object-level registration and alignment.

Usage:
    python -m core.select_gaussians.extract_by_label \
        --ply_path results/scene/ply/point_cloud_29999.ply \
        --grouping_path results/scene/ply/grouping_29999.npz \
        --target_labels 5 12 23 \
        --output_path results/scene/door_gaussians.ply
"""

import argparse
import sys
import os

import numpy as np
import torch

from gsplat import export_splats

# Add project root to path for utilities import
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from utilities.ply_io import load_ply


def main():
    parser = argparse.ArgumentParser(
        description="Extract Gaussians by semantic label from Gaussian Grouping results"
    )
    parser.add_argument(
        "--ply_path", type=str, required=True,
        help="Path to the source PLY file (from gsplat training)",
    )
    parser.add_argument(
        "--grouping_path", type=str, required=True,
        help="Path to grouping_*.npz file (contains 'labels' and 'identity')",
    )
    parser.add_argument(
        "--target_labels", type=int, nargs="+", required=True,
        help="Label IDs to extract (space-separated)",
    )
    parser.add_argument(
        "--output_path", type=str, required=True,
        help="Output PLY file path for extracted Gaussians",
    )
    args = parser.parse_args()

    # Load grouping data
    grouping_data = np.load(args.grouping_path)
    labels = grouping_data["labels"]  # [N,]
    print(f"Loaded grouping data: {len(labels)} Gaussians, "
          f"{len(np.unique(labels))} unique labels")

    # Build mask for target labels
    target_set = set(args.target_labels)
    mask = np.isin(labels, list(target_set))
    num_selected = mask.sum()
    print(f"Target labels: {args.target_labels}")
    print(f"Selected {num_selected} / {len(labels)} Gaussians "
          f"({100.0 * num_selected / len(labels):.1f}%)")

    if num_selected == 0:
        print("No Gaussians match the target labels. Exiting.")
        return

    # Load PLY and filter
    ply_data = load_ply(args.ply_path)

    means = torch.from_numpy(ply_data["means"][mask])
    scales = torch.from_numpy(ply_data["scales"][mask])
    quats = torch.from_numpy(ply_data["quats"][mask])
    opacities = torch.from_numpy(ply_data["opacities"][mask])
    sh0 = torch.from_numpy(ply_data["sh0"][mask])
    shN = torch.from_numpy(ply_data["shN"][mask])

    # Export filtered Gaussians
    export_splats(
        means=means,
        scales=scales,
        quats=quats,
        opacities=opacities,
        sh0=sh0,
        shN=shN,
        format="ply",
        save_to=args.output_path,
    )
    print(f"Exported {num_selected} Gaussians to {args.output_path}")


if __name__ == "__main__":
    main()
