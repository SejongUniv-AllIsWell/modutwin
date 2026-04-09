"""Gaussian Grouping module for per-Gaussian semantic identity encoding.

Provides a 1x1 Conv2d classifier, cross-entropy loss against SAM masks,
and a 3D KNN regularization loss that encourages nearby Gaussians to
share similar identity encodings.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor


class GroupingModule(nn.Module):
    """1x1 Conv2d classifier that maps rendered identity features to class logits.

    Args:
        feature_dim: Dimension of per-Gaussian identity encoding (default: 16).
        num_classes: Number of semantic classes from SAM masks (default: 256).
    """

    def __init__(self, feature_dim: int = 16, num_classes: int = 256):
        super().__init__()
        self.classifier = nn.Conv2d(feature_dim, num_classes, kernel_size=1)

    def forward(self, identity_features: Tensor) -> Tensor:
        """Map rendered identity features to class logits.

        Args:
            identity_features: [B, H, W, D] rendered identity feature map.

        Returns:
            [B, num_classes, H, W] class logits.
        """
        # [B, H, W, D] -> [B, D, H, W]
        x = identity_features.permute(0, 3, 1, 2)
        return self.classifier(x)


def grouping_loss(
    rendered_identity: Tensor,
    grouping_masks: Tensor,
    classifier: GroupingModule,
    valid_mask: Tensor = None,
) -> Tensor:
    """Cross-entropy loss between rendered identity features and SAM labels.

    Args:
        rendered_identity: [B, H, W, D] rendered identity feature map.
        grouping_masks: [B, H, W] int64 SAM label map.
        classifier: GroupingModule to produce logits.
        valid_mask: [B, H, W] bool mask for valid (undistorted) regions.

    Returns:
        Scalar cross-entropy loss.
    """
    logits = classifier(rendered_identity)  # [B, num_classes, H, W]
    targets = grouping_masks.long()  # [B, H, W]

    if valid_mask is not None:
        # Flatten to apply mask: only compute loss on valid pixels
        B, C, H, W = logits.shape
        logits_flat = logits.permute(0, 2, 3, 1).reshape(-1, C)  # [B*H*W, C]
        targets_flat = targets.reshape(-1)  # [B*H*W]
        mask_flat = valid_mask.reshape(-1)  # [B*H*W]
        logits_flat = logits_flat[mask_flat]
        targets_flat = targets_flat[mask_flat]
        if logits_flat.numel() == 0:
            return torch.tensor(0.0, device=logits.device, requires_grad=True)
        return F.cross_entropy(logits_flat, targets_flat)
    else:
        return F.cross_entropy(logits, targets)


def grouping_regularization_loss(
    identity_features: Tensor,
    means: Tensor,
    k: int = 5,
    max_points: int = 50000,
) -> Tensor:
    """3D KNN regularization: nearby Gaussians should have similar identity encodings.

    Computes pairwise L2 distance in identity space between each Gaussian and
    its k nearest 3D neighbors, encouraging spatial coherence.

    Args:
        identity_features: [N, D] per-Gaussian identity features.
        means: [N, 3] Gaussian positions (detached).
        k: Number of nearest neighbors.
        max_points: Subsample to this many points for efficiency.

    Returns:
        Scalar regularization loss.
    """
    N = identity_features.shape[0]
    device = identity_features.device

    if N <= k:
        return torch.tensor(0.0, device=device, requires_grad=True)

    # Subsample for efficiency
    if N > max_points:
        indices = torch.randperm(N, device=device)[:max_points]
        identity_sub = identity_features[indices]
        means_sub = means[indices]
    else:
        identity_sub = identity_features
        means_sub = means

    # Compute pairwise distances in 3D space using cdist
    M = means_sub.shape[0]
    dists = torch.cdist(means_sub.unsqueeze(0), means_sub.unsqueeze(0)).squeeze(0)

    # Set self-distance to inf
    dists.fill_diagonal_(float("inf"))

    # Get k nearest neighbors
    _, knn_idx = dists.topk(k, dim=1, largest=False)  # [M, k]

    # Compute identity feature differences
    neighbors = identity_sub[knn_idx]  # [M, k, D]
    diff = identity_sub.unsqueeze(1) - neighbors  # [M, k, D]
    loss = (diff ** 2).sum(dim=-1).mean()

    return loss
