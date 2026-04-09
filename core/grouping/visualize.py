"""Visualize SAM grouping masks as colored overlay images.

Creates a color-coded visualization of SAM masks overlaid on the original images.
Each unique label gets a random but consistent color.

Usage:
    python -m core.grouping.visualize \
        --data_dir data/my_scene --factor 4 --num_images 10
"""

import argparse
import os

import cv2
import numpy as np


def create_label_colormap(num_labels: int) -> np.ndarray:
    """Create a deterministic colormap for labels."""
    rng = np.random.RandomState(42)
    colors = rng.randint(50, 255, size=(num_labels + 1, 3), dtype=np.uint8)
    colors[0] = [0, 0, 0]  # background = black
    return colors


def main():
    parser = argparse.ArgumentParser(description="Visualize SAM grouping masks")
    parser.add_argument("--data_dir", type=str, required=True)
    parser.add_argument("--factor", type=int, default=4)
    parser.add_argument("--output_dir", type=str, default=None)
    parser.add_argument("--num_images", type=int, default=10,
                        help="Number of images to visualize")
    parser.add_argument("--alpha", type=float, default=0.5,
                        help="Overlay alpha")
    args = parser.parse_args()

    suffix = f"_{args.factor}" if args.factor > 1 else ""
    img_dir = os.path.join(args.data_dir, f"images{suffix}")
    if not os.path.exists(img_dir):
        img_dir = os.path.join(args.data_dir, "images")
    mask_dir = os.path.join(args.data_dir, f"grouping_masks{suffix}")

    if args.output_dir is None:
        args.output_dir = os.path.join(args.data_dir, "label_vis")
    os.makedirs(args.output_dir, exist_ok=True)

    img_files = sorted([
        f for f in os.listdir(img_dir)
        if f.lower().endswith((".png", ".jpg", ".jpeg"))
    ])

    # Evenly sample images
    if len(img_files) > args.num_images:
        indices = np.linspace(0, len(img_files) - 1, args.num_images, dtype=int)
    else:
        indices = range(len(img_files))

    # Find max label for colormap
    max_label = 0
    for idx in indices:
        stem = os.path.splitext(img_files[idx])[0]
        mask_path = os.path.join(mask_dir, f"{stem}.npy")
        if os.path.exists(mask_path):
            mask = np.load(mask_path)
            max_label = max(max_label, mask.max())

    colors = create_label_colormap(int(max_label) + 1)

    for idx in indices:
        fname = img_files[idx]
        stem = os.path.splitext(fname)[0]

        img = cv2.imread(os.path.join(img_dir, fname))
        mask_path = os.path.join(mask_dir, f"{stem}.npy")
        if not os.path.exists(mask_path):
            continue
        mask = np.load(mask_path)

        # Create colored mask
        color_mask = colors[mask.astype(int) % len(colors)]

        # Blend
        overlay = cv2.addWeighted(img, 1 - args.alpha, color_mask, args.alpha, 0)

        # Add label numbers at mask centroids for large masks
        unique_labels = np.unique(mask)
        for lbl in unique_labels:
            if lbl == 0:
                continue
            lbl_mask = mask == lbl
            area = lbl_mask.sum()
            if area < 500:
                continue
            ys, xs = np.where(lbl_mask)
            cy, cx = int(ys.mean()), int(xs.mean())
            cv2.putText(
                overlay, str(int(lbl)), (cx - 10, cy + 5),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA,
            )

        out_path = os.path.join(args.output_dir, f"labels_{stem}.png")
        cv2.imwrite(out_path, overlay)
        print(f"Saved: {out_path}")

    print(f"\nDone! Check {args.output_dir} for label visualizations.")


if __name__ == "__main__":
    main()
