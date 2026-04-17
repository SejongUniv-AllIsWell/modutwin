// 문 꼭짓점 4개 대응에서 강체 변환 추정.
// Python register_scenes.match_corners_with_reflection 포팅: 8가지 순서(4 회전 x 2 반전)를
// 전부 시도해 RMSD 최소가 되는 매칭을 선택. 수동 4점 선택 시 사용자가 꼭짓점 순서를
// 일일이 맞춰주지 않아도 되는 장점이 있다.

import { kabsch, type RigidTransform } from './kabsch';

export interface MatchCornersResult extends RigidTransform {
  /** 어떤 순서 조합이 최적이었는지 (디버깅용) */
  flip: boolean;
  rotate: number;
}

function rollRows(pts: Float64Array, rot: number): Float64Array {
  const out = new Float64Array(pts.length);
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const src = (i - rot + n) % n;
    out[i*3]   = pts[src*3];
    out[i*3+1] = pts[src*3+1];
    out[i*3+2] = pts[src*3+2];
  }
  return out;
}

function reverseRows(pts: Float64Array): Float64Array {
  const out = new Float64Array(pts.length);
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const src = n - 1 - i;
    out[i*3]   = pts[src*3];
    out[i*3+1] = pts[src*3+1];
    out[i*3+2] = pts[src*3+2];
  }
  return out;
}

/**
 * 4개 꼭짓점 기준 강체 변환 추정. source → target.
 * 순환/반전 8가지 조합을 전부 시도해 RMSD 최소 선택.
 */
export function matchCorners(
  source: Float64Array | number[],
  target: Float64Array | number[],
): MatchCornersResult {
  const n = source.length / 3;
  if (n !== target.length / 3) throw new Error('matchCorners: source/target length mismatch');
  if (n < 3) throw new Error('matchCorners: 최소 3개 꼭짓점 필요');

  const src = new Float64Array(source);
  let best: MatchCornersResult | null = null;

  for (const flip of [false, true]) {
    const baseline = flip ? reverseRows(src) : src;
    for (let rot = 0; rot < n; rot++) {
      const rolled = rollRows(baseline, rot);
      const fit = kabsch(rolled, target, n);
      if (!best || fit.rmsd < best.rmsd) {
        best = { ...fit, flip, rotate: rot };
      }
    }
  }
  if (!best) throw new Error('matchCorners: fit 실패');
  return best;
}
