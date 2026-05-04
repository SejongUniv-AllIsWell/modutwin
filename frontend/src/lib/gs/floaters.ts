import type { GaussianScene } from '../ply/types';

export interface FloaterOptions {
  voxelSize: number;
  opacityThreshold: number;
  minNeighbors: number;
}

export const DEFAULT_FLOATER_OPTIONS: FloaterOptions = {
  voxelSize: 0.05,
  opacityThreshold: 0.1,
  minNeighbors: 3,
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface FloaterDetectResult {
  mask: Uint8Array;
  deletedCount: number;
  aliveCount: number;
}

/**
 * 외부 가우시안 제거가 끝난 뒤 남은 가우시안에 대해서만 floater 후보를 마킹.
 *
 * 알고리즘:
 *  1) `excludeMask[i]==1` (= shell/brush 등으로 이미 지워질 예정) 인 입자는 skip.
 *  2) 살아있는 입자를 voxelSize 큐브 그리드에 binning.
 *  3) 각 입자에 대해 sigmoid(opacity) < opacityThreshold 인 경우만 검사,
 *     자기 셀 + 26 이웃 셀 누적 카운트가 minNeighbors 미만이면 floater 로 마킹.
 *
 * 반환 mask: 1 = floater (삭제 대상). excludeMask 가 이미 가린 입자는 0.
 */
export function detectFloaters(
  scene: GaussianScene | { numSplats: number; posX: Float32Array; posY: Float32Array; posZ: Float32Array; opacity: Float32Array },
  options: Partial<FloaterOptions> = {},
  excludeMask?: Uint8Array | null,
): FloaterDetectResult {
  const opts = { ...DEFAULT_FLOATER_OPTIONS, ...options };

  let N: number;
  let px: Float32Array, py: Float32Array, pz: Float32Array, op: Float32Array;
  if ('attrs' in scene) {
    N = scene.numSplats;
    const ax = scene.attrs.get('x');
    const ay = scene.attrs.get('y');
    const az = scene.attrs.get('z');
    const ao = scene.attrs.get('opacity');
    if (!ax || !ay || !az || !ao) throw new Error('floaters: x/y/z/opacity attributes required');
    px = ax; py = ay; pz = az; op = ao;
  } else {
    N = scene.numSplats;
    px = scene.posX; py = scene.posY; pz = scene.posZ; op = scene.opacity;
  }

  const inv = 1 / opts.voxelSize;
  const counts = new Map<string, number>();

  let aliveCount = 0;
  for (let i = 0; i < N; i++) {
    if (excludeMask && excludeMask[i]) continue;
    const ix = Math.floor(px[i] * inv);
    const iy = Math.floor(py[i] * inv);
    const iz = Math.floor(pz[i] * inv);
    const k = `${ix},${iy},${iz}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    aliveCount++;
  }

  const mask = new Uint8Array(N);
  let deletedCount = 0;
  for (let i = 0; i < N; i++) {
    if (excludeMask && excludeMask[i]) continue;
    const alpha = sigmoid(op[i]);
    if (alpha >= opts.opacityThreshold) continue;

    const ix = Math.floor(px[i] * inv);
    const iy = Math.floor(py[i] * inv);
    const iz = Math.floor(pz[i] * inv);

    let neighborCount = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const c = counts.get(`${ix + dx},${iy + dy},${iz + dz}`);
          if (c) neighborCount += c;
        }
      }
    }

    if (neighborCount < opts.minNeighbors) {
      mask[i] = 1;
      deletedCount++;
    }
  }

  return { mask, deletedCount, aliveCount };
}
