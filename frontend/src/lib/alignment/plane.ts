// 점군에서 평면 fitting. Python core/door_alignment/register_scenes.ransac_plane_fit 포팅.
// segmentation으로 문 gaussian이 넘어왔을 때 평면을 찾고 outlier 제거하는 용도.

import type { Mat3 } from './mat3';
import { eigenSym3, mat3Create } from './mat3';

export interface PlaneFitOptions {
  nIterations?: number;
  /** inlier 판정 거리 (meters) */
  inlierThresh?: number;
  /** opacity 가중치(logit). 각 점의 가중치는 sigmoid(opacity). 없으면 균등. */
  opacities?: Float32Array | number[];
  seed?: number;
}

export interface PlaneFitResult {
  /** 평면 법선 (단위벡터) */
  normal: [number, number, number];
  /** 평면 위 한 점 (inlier 가중 평균) */
  point: [number, number, number];
  /** inlier 마스크 */
  inliers: Uint8Array;
}

function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return (s & 0xffffffff) / 0x100000000;
  };
}

function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

function sample3(rng: () => number, n: number): [number, number, number] {
  const a = Math.floor(rng() * n);
  let b = Math.floor(rng() * n); while (b === a) b = Math.floor(rng() * n);
  let c = Math.floor(rng() * n); while (c === a || c === b) c = Math.floor(rng() * n);
  return [a, b, c];
}

/**
 * 3D 점군에 평면을 RANSAC으로 fitting.
 * opacity가 주어지면 sigmoid 가중치로 inlier score를 계산.
 */
export function ransacPlaneFit(
  points: Float64Array | Float32Array,
  count: number,
  options: PlaneFitOptions = {},
): PlaneFitResult {
  const nIter = options.nIterations ?? 2000;
  const thresh = options.inlierThresh ?? 0.02;
  const rng = makeRng(options.seed);

  const weights = new Float64Array(count);
  if (options.opacities) {
    for (let i = 0; i < count; i++) weights[i] = sigmoid(options.opacities[i]);
  } else {
    weights.fill(1);
  }

  let bestScore = -1;
  let bestMask = new Uint8Array(count);

  for (let iter = 0; iter < nIter; iter++) {
    const [i0, i1, i2] = sample3(rng, count);
    const p0x = points[i0*3], p0y = points[i0*3+1], p0z = points[i0*3+2];
    const p1x = points[i1*3], p1y = points[i1*3+1], p1z = points[i1*3+2];
    const p2x = points[i2*3], p2y = points[i2*3+1], p2z = points[i2*3+2];

    const ax = p1x - p0x, ay = p1y - p0y, az = p1z - p0z;
    const bx = p2x - p0x, by = p2y - p0y, bz = p2z - p0z;
    let nx = ay*bz - az*by;
    let ny = az*bx - ax*bz;
    let nz = ax*by - ay*bx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) continue;
    nx /= nl; ny /= nl; nz /= nl;

    const mask = new Uint8Array(count);
    let score = 0;
    for (let i = 0; i < count; i++) {
      const dx = points[i*3] - p0x, dy = points[i*3+1] - p0y, dz = points[i*3+2] - p0z;
      const d = Math.abs(dx*nx + dy*ny + dz*nz);
      if (d < thresh) { mask[i] = 1; score += weights[i]; }
    }
    if (score > bestScore) { bestScore = score; bestMask = mask; }
  }

  // 가중 최소자승 refit: inlier 중심 centroid + 공분산 최소 고유값의 고유벡터 = normal
  let wsum = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < count; i++) if (bestMask[i]) {
    const w = weights[i];
    cx += points[i*3] * w; cy += points[i*3+1] * w; cz += points[i*3+2] * w;
    wsum += w;
  }
  if (wsum < 1e-12) throw new Error('ransacPlaneFit: no inliers');
  cx /= wsum; cy /= wsum; cz /= wsum;

  const cov = mat3Create();
  for (let i = 0; i < count; i++) if (bestMask[i]) {
    const w = weights[i];
    const dx = points[i*3] - cx, dy = points[i*3+1] - cy, dz = points[i*3+2] - cz;
    cov[0] += w*dx*dx; cov[1] += w*dx*dy; cov[2] += w*dx*dz;
    cov[3] += w*dy*dx; cov[4] += w*dy*dy; cov[5] += w*dy*dz;
    cov[6] += w*dz*dx; cov[7] += w*dz*dy; cov[8] += w*dz*dz;
  }

  const V: Mat3 = mat3Create();
  const eig = new Float64Array(3);
  eigenSym3(cov, V, eig);
  // 최소 고유값의 고유벡터가 평면 법선 (eigenSym3는 내림차순 → index 2가 최소)
  const nx = V[0*3+2], ny = V[1*3+2], nz = V[2*3+2];
  const nl = Math.hypot(nx, ny, nz) || 1;
  return {
    normal: [nx/nl, ny/nl, nz/nl],
    point: [cx, cy, cz],
    inliers: bestMask,
  };
}

/**
 * 평면에 점들을 투영한 뒤, PCA로 2축을 찾아 축정렬된 bbox의 4 꼭짓점을 3D로 돌려준다.
 * (Python의 rotating calipers min-area OBB 대신 PCA 근사 — ConvexHull 없이 MVP용)
 *
 * @param points 3D 점 (Float64Array Nx3)
 * @param normal 평면 법선
 * @param pointOnPlane 평면 위 한 점
 * @returns 4 꼭짓점 (CCW, Float64Array 4x3)
 */
export function fitOrientedRectangle(
  points: Float64Array | Float32Array,
  count: number,
  normal: readonly [number, number, number],
  pointOnPlane: readonly [number, number, number],
): Float64Array {
  // u, v: 평면 위의 두 직교 단위벡터
  const nx = normal[0], ny = normal[1], nz = normal[2];
  let hx = 0, hy = 0, hz = 1;
  if (Math.abs(nx*hx + ny*hy + nz*hz) > 0.9) { hx = 0; hy = 1; hz = 0; }
  // u = normalize(normal x hint)
  let ux = ny*hz - nz*hy, uy = nz*hx - nx*hz, uz = nx*hy - ny*hx;
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  // v = normalize(normal x u)
  let vx = ny*uz - nz*uy, vy = nz*ux - nx*uz, vz = nx*uy - ny*ux;
  const vl = Math.hypot(vx, vy, vz) || 1; vx /= vl; vy /= vl; vz /= vl;

  // 2D 투영
  const coords = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    const dx = points[i*3] - pointOnPlane[0];
    const dy = points[i*3+1] - pointOnPlane[1];
    const dz = points[i*3+2] - pointOnPlane[2];
    coords[i*2]   = dx*ux + dy*uy + dz*uz;
    coords[i*2+1] = dx*vx + dy*vy + dz*vz;
  }

  // 2D PCA
  let mx = 0, my = 0;
  for (let i = 0; i < count; i++) { mx += coords[i*2]; my += coords[i*2+1]; }
  mx /= count; my /= count;
  let c00 = 0, c01 = 0, c11 = 0;
  for (let i = 0; i < count; i++) {
    const dx = coords[i*2] - mx, dy = coords[i*2+1] - my;
    c00 += dx*dx; c01 += dx*dy; c11 += dy*dy;
  }
  // 2x2 고유값/고유벡터 (대칭)
  const tr = c00 + c11, det = c00*c11 - c01*c01;
  const disc = Math.sqrt(Math.max(0, tr*tr/4 - det));
  const e0 = tr/2 + disc, e1 = tr/2 - disc;
  // e0에 대한 고유벡터
  let ex: number, ey: number;
  if (Math.abs(c01) > 1e-12) { ex = e0 - c11; ey = c01; }
  else { ex = 1; ey = 0; }
  const el = Math.hypot(ex, ey) || 1; ex /= el; ey /= el;
  const fx = -ey, fy = ex;
  void e1;

  // axis-aligned bbox in PCA 프레임
  let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
  for (let i = 0; i < count; i++) {
    const dx = coords[i*2] - mx, dy = coords[i*2+1] - my;
    const p0 = dx*ex + dy*ey;
    const p1 = dx*fx + dy*fy;
    if (p0 < lo0) lo0 = p0; if (p0 > hi0) hi0 = p0;
    if (p1 < lo1) lo1 = p1; if (p1 > hi1) hi1 = p1;
  }

  // 4 꼭짓점 (CCW): (lo0, lo1), (hi0, lo1), (hi0, hi1), (lo0, hi1)
  const box2d: Array<[number, number]> = [
    [lo0, lo1], [hi0, lo1], [hi0, hi1], [lo0, hi1],
  ];

  const out = new Float64Array(12);
  for (let i = 0; i < 4; i++) {
    const [p0, p1] = box2d[i];
    // PCA 프레임 → 원래 2D 좌표
    const ax = p0*ex + p1*fx + mx;
    const ay = p0*ey + p1*fy + my;
    // 2D → 3D
    out[i*3]   = pointOnPlane[0] + ax*ux + ay*vx;
    out[i*3+1] = pointOnPlane[1] + ax*uy + ay*vy;
    out[i*3+2] = pointOnPlane[2] + ax*uz + ay*vz;
  }
  return out;
}
