// RANSAC: 노이즈가 많은 대응점 집합에서 강체 변환을 robust하게 추정.
// segmentation이 주는 문 네 꼭짓점의 pixel→3D mapping이 noisy할 경우를 대비.
//
// 동작:
//  1) 매 iteration마다 K개 (기본 4) 대응점을 무작위 샘플
//  2) Kabsch로 rigid transform 후보 생성
//  3) 전체 N개에 변환 적용 → target과의 거리 < inlierThresh인 것을 inlier로 count
//  4) inlier가 가장 많은 후보 채택 → 그 inlier들로 refined Kabsch 재실행

import { kabsch, type RigidTransform } from './kabsch';

export interface RansacOptions {
  /** iteration 수 (기본 500) */
  iterations?: number;
  /** inlier 판정 거리 (meters, 기본 0.03) */
  inlierThresh?: number;
  /** 최소 샘플 크기 (기본 4) */
  minSample?: number;
  /** early termination: 이 inlier 비율 이상이면 조기 종료 (기본 0.95) */
  earlyStopRatio?: number;
  /** PRNG seed (재현성 원하면 지정, 없으면 Math.random) */
  seed?: number;
}

export interface RansacResult extends RigidTransform {
  inliers: Uint8Array;
  inlierCount: number;
  iterations: number;
}

function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return (s & 0xffffffff) / 0x100000000;
  };
}

function sampleWithoutReplacement(rng: () => number, n: number, k: number): number[] {
  const out: number[] = [];
  const used = new Set<number>();
  while (out.length < k) {
    const r = Math.floor(rng() * n);
    if (!used.has(r)) { used.add(r); out.push(r); }
  }
  return out;
}

function applyTransform(
  source: Float64Array | number[], idx: number,
  R: Float64Array, t: readonly [number, number, number],
): [number, number, number] {
  const x = source[idx*3], y = source[idx*3+1], z = source[idx*3+2];
  return [
    R[0]*x + R[1]*y + R[2]*z + t[0],
    R[3]*x + R[4]*y + R[5]*z + t[1],
    R[6]*x + R[7]*y + R[8]*z + t[2],
  ];
}

export function ransacRigid(
  source: Float64Array | number[],
  target: Float64Array | number[],
  count: number,
  options: RansacOptions = {},
): RansacResult {
  const iterations = options.iterations ?? 500;
  const inlierThresh = options.inlierThresh ?? 0.03;
  const minSample = Math.max(3, options.minSample ?? 4);
  const earlyStopRatio = options.earlyStopRatio ?? 0.95;
  const rng = makeRng(options.seed);
  const thresh2 = inlierThresh * inlierThresh;

  if (count < minSample) {
    // 샘플이 너무 적으면 그냥 Kabsch로 단번에 계산
    const fit = kabsch(source, target, count);
    const inliers = new Uint8Array(count); inliers.fill(1);
    return { ...fit, inliers, inlierCount: count, iterations: 0 };
  }

  let bestCount = 0;
  let bestInliers = new Uint8Array(count);
  let bestFit: RigidTransform | null = null;
  let doneIter = 0;

  for (let iter = 0; iter < iterations; iter++) {
    doneIter = iter + 1;
    const sampleIdx = sampleWithoutReplacement(rng, count, minSample);
    const sSub = new Float64Array(minSample * 3);
    const tSub = new Float64Array(minSample * 3);
    for (let i = 0; i < minSample; i++) {
      const k = sampleIdx[i];
      sSub[i*3]=source[k*3]; sSub[i*3+1]=source[k*3+1]; sSub[i*3+2]=source[k*3+2];
      tSub[i*3]=target[k*3]; tSub[i*3+1]=target[k*3+1]; tSub[i*3+2]=target[k*3+2];
    }

    let cand: RigidTransform;
    try { cand = kabsch(sSub, tSub, minSample); } catch { continue; }

    // inlier count
    const curInliers = new Uint8Array(count);
    let cnt = 0;
    for (let i = 0; i < count; i++) {
      const [tx, ty, tz] = applyTransform(source, i, cand.R, cand.t);
      const dx = tx - target[i*3], dy = ty - target[i*3+1], dz = tz - target[i*3+2];
      if (dx*dx + dy*dy + dz*dz < thresh2) { curInliers[i] = 1; cnt++; }
    }

    if (cnt > bestCount) {
      bestCount = cnt;
      bestInliers = curInliers;
      bestFit = cand;
      if (cnt / count >= earlyStopRatio) break;
    }
  }

  if (!bestFit || bestCount < minSample) {
    // RANSAC 실패 → 전체를 Kabsch로
    const fit = kabsch(source, target, count);
    const inliers = new Uint8Array(count); inliers.fill(1);
    return { ...fit, inliers, inlierCount: count, iterations: doneIter };
  }

  // 최종 refine: 모든 inlier로 Kabsch
  const sIn = new Float64Array(bestCount * 3);
  const tIn = new Float64Array(bestCount * 3);
  let w = 0;
  for (let i = 0; i < count; i++) {
    if (bestInliers[i]) {
      sIn[w*3]=source[i*3]; sIn[w*3+1]=source[i*3+1]; sIn[w*3+2]=source[i*3+2];
      tIn[w*3]=target[i*3]; tIn[w*3+1]=target[i*3+1]; tIn[w*3+2]=target[i*3+2];
      w++;
    }
  }
  const refined = kabsch(sIn, tIn, bestCount);

  return {
    ...refined,
    inliers: bestInliers,
    inlierCount: bestCount,
    iterations: doneIter,
  };
}
