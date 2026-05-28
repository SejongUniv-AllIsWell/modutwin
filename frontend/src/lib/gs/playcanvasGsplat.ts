/**
 * PlayCanvas gsplat shader model constants.
 *
 * Source checked against PlayCanvas shader chunks:
 * - gsplat/vert/gsplatCommon: clipCorner(alpha)
 * - gsplat/frag/gsplat: A=dot(gaussianUV, gaussianUV), discard A>1,
 *   alpha=((exp(-4A)-exp(-4))/(1-exp(-4))) * opacity, discard alpha<1/255.
 *
 * In covariance/Mahalanobis notation q=d^T Sigma^-1 d and A=q/8.
 * The maximum hard visible support is q<=8, i.e. sqrt(8) sigma.
 * Actual support is smaller for low-opacity splats because of the 1/255 alpha discard.
 */

export const GSPLAT_SH0 = 0.28209479177387814;
export const GSPLAT_Q_CUTOFF = 8;
export const GSPLAT_SIGMA_CUTOFF = Math.sqrt(GSPLAT_Q_CUTOFF);
export const GSPLAT_EDGE_EXP = Math.exp(-0.5 * GSPLAT_Q_CUTOFF);
export const GSPLAT_INV_EDGE_NORM = 1 / (1 - GSPLAT_EDGE_EXP);
export const GSPLAT_ALPHA_CUTOFF = 1 / 255;

export function sigmoidOpacity(opacityLogit: number): number {
  return 1 / (1 + Math.exp(-opacityLogit));
}

export function gsplatVisibleSigmaRadius(alpha: number): number {
  if (alpha <= GSPLAT_ALPHA_CUTOFF) return 0;
  const threshold = GSPLAT_EDGE_EXP + (1 - GSPLAT_EDGE_EXP) * (GSPLAT_ALPHA_CUTOFF / alpha);
  const q = -2 * Math.log(Math.min(1, Math.max(GSPLAT_EDGE_EXP, threshold)));
  return Math.min(GSPLAT_SIGMA_CUTOFF, Math.sqrt(Math.max(0, q)));
}

export function gsplatKernelAlpha(alpha: number, q: number): number {
  if (q > GSPLAT_Q_CUTOFF) return 0;
  const profile = (Math.exp(-0.5 * q) - GSPLAT_EDGE_EXP) * GSPLAT_INV_EDGE_NORM;
  const a = alpha * profile;
  return a >= GSPLAT_ALPHA_CUTOFF ? a : 0;
}
