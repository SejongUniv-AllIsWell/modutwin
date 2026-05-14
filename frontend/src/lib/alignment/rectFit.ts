// 직사각형 4점 → 직사각형 4점 rigid transform 직접 계산.
//
// normalizeDoorRect 로 src/dst 모두 완벽한 직사각형이 보장된 상태에서,
// SVD 기반 Kabsch 대신 두 직사각형의 직교 basis 비교로 R, t 를 한 번에 산출.
//
// Kabsch 대비 이점:
//  - 180° 매칭 모호성 (rect 의 mirror vs 180° 회전이 RMSD 동률) 제거.
//  - dst basis 의 n 축 = 도어 평면 normal → gap push 방향이 deterministic.
//  - SVD 없음 → 단순 빠름.

import type { Vec3 } from './mat3';

type V3 = [number, number, number];

function getP(p: Float64Array, i: number): V3 {
  return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
}
function avg(p: Float64Array, count = 4): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < count; i++) { x += p[i*3]; y += p[i*3+1]; z += p[i*3+2]; }
  return [x / count, y / count, z / count];
}
function sub(a: V3, b: V3): V3 { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function neg(a: V3): V3 { return [-a[0], -a[1], -a[2]]; }
function dot(a: V3, b: V3): number { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function cross(a: V3, b: V3): V3 {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function unit(a: V3): V3 {
  const L = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0]/L, a[1]/L, a[2]/L];
}
function scale(a: V3, s: number): V3 { return [a[0]*s, a[1]*s, a[2]*s]; }

interface Basis {
  c: V3;      // centroid
  e1: V3;     // unit, 가로 (corner[1] - corner[0] 방향)
  e2: V3;     // unit, 세로
  n: V3;      // unit, 평면 normal
}

/** 4 corner → centroid + 직교 basis. n 은 cross-product 로 결정. */
function buildBasisFromCorners(p: Float64Array): Basis {
  const c = avg(p);
  const e1raw = sub(getP(p, 1), getP(p, 0));
  const e2raw = sub(getP(p, 2), getP(p, 1));
  const e1 = unit(e1raw);
  const n = unit(cross(e1raw, e2raw));
  // e2 = n × e1 — e1 ⊥ n 이라 자동 단위벡터.
  const e2 = cross(n, e1);
  return { c, e1, e2, n };
}

/** dst basis 의 n 을 외부에서 지정한 방향으로 강제. cornerpick winding 무관 deterministic. */
function buildBasisWithForcedNormal(p: Float64Array, nForced: V3): Basis {
  const c = avg(p);
  const e1raw = sub(getP(p, 1), getP(p, 0));
  const n = unit(nForced);
  // e1 에서 n 성분 제거 → 평면 위 e1 단위벡터.
  const e1proj = sub(e1raw, scale(n, dot(e1raw, n)));
  const e1 = unit(e1proj);
  const e2 = cross(n, e1);
  return { c, e1, e2, n };
}

export interface RectFitResult {
  /** row-major 3×3 (9 elements) — kabsch 반환 형식과 동일. */
  R: number[];
  /** 3 elements. */
  t: number[];
  /** 잔차 (perfect rect 가정 시 ≈ 0). 진단용. */
  rmsd: number;
  /** dst 평면 normal in world (gap push 방향으로 사용 가능). dstOutwardWorld 가 지정되면 그것과 동일. */
  dstN: V3;
  /** dst centroid (frame mesh 등에서 사용). */
  dstCenter: V3;
}

/**
 * 직사각형 4점 ↔ 직사각형 4점 rigid fit.
 *
 * @param src   module 측 4 corner world 좌표 (Float64Array length 12).
 * @param dst   basemap 측 4 corner world 좌표 (MIRROR_MAP 등 사전 매칭 적용 후).
 * @param opts.dstForcedN  지정 시 dst basis 의 n 을 이 방향으로 강제. cornerpick winding 무관 deterministic.
 *                         MIRROR_MAP 적용 후 dst 의 자연 cross-product 와 일치하는 방향으로 지정해야 R 이 올바름.
 *                         (typical: basemap door 의 경우 basemap room inward 방향.)
 */
export function rectFit(
  src: Float64Array,
  dst: Float64Array,
  opts: { dstForcedN?: V3 } = {},
): RectFitResult {
  const Bs = buildBasisFromCorners(src);
  const Bd = opts.dstForcedN
    ? buildBasisWithForcedNormal(dst, opts.dstForcedN)
    : buildBasisFromCorners(dst);

  // R 은 src 의 basis 컬럼 (e1, e2, n) 을 dst 의 basis 컬럼으로 보내는 회전.
  //   R · [e1_s e2_s n_s] = [e1_d e2_d n_d]
  //   R = [e1_d e2_d n_d] · [e1_s e2_s n_s]^T
  // row-major 3×3 으로 저장. R[i*3+j] = sum_k Bd_cols[k][i] * Bs_cols[k][j].
  const Bdcols: V3[] = [Bd.e1, Bd.e2, Bd.n];
  const Bscols: V3[] = [Bs.e1, Bs.e2, Bs.n];
  const buildR = (sCols: V3[], dCols: V3[]): number[] => {
    const R = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += dCols[k][i] * sCols[k][j];
        R[i*3 + j] = s;
      }
    }
    return R;
  };
  let R = buildR(Bscols, Bdcols);

  // det(R) 가 -1 이면 reflection — src winding 이 dst 와 반대.
  // src basis 의 n 부호 뒤집고 e2 도 재계산해 회전(det=+1) 되도록 보정.
  const det =
    R[0] * (R[4] * R[8] - R[5] * R[7]) -
    R[1] * (R[3] * R[8] - R[5] * R[6]) +
    R[2] * (R[3] * R[7] - R[4] * R[6]);
  if (det < 0) {
    const nFlipped = neg(Bs.n);
    const e2Flipped = cross(nFlipped, Bs.e1);
    R = buildR([Bs.e1, e2Flipped, nFlipped], Bdcols);
  }

  // t = c_dst - R · c_src
  const Rcs: V3 = [
    R[0]*Bs.c[0] + R[1]*Bs.c[1] + R[2]*Bs.c[2],
    R[3]*Bs.c[0] + R[4]*Bs.c[1] + R[5]*Bs.c[2],
    R[6]*Bs.c[0] + R[7]*Bs.c[1] + R[8]*Bs.c[2],
  ];
  const t = [Bd.c[0] - Rcs[0], Bd.c[1] - Rcs[1], Bd.c[2] - Rcs[2]];

  // 잔차 계산 — perfect rect 가정 위반 정도 (사용자 픽 직사각화 후엔 ~0).
  let sumSq = 0;
  for (let i = 0; i < 4; i++) {
    const sp = getP(src, i);
    const Rsp: V3 = [
      R[0]*sp[0] + R[1]*sp[1] + R[2]*sp[2] + t[0],
      R[3]*sp[0] + R[4]*sp[1] + R[5]*sp[2] + t[1],
      R[6]*sp[0] + R[7]*sp[1] + R[8]*sp[2] + t[2],
    ];
    const dp = getP(dst, i);
    const dx = Rsp[0]-dp[0], dy = Rsp[1]-dp[1], dz = Rsp[2]-dp[2];
    sumSq += dx*dx + dy*dy + dz*dz;
  }
  const rmsd = Math.sqrt(sumSq / 4);

  return { R, t, rmsd, dstN: Bd.n, dstCenter: Bd.c };
}

export type { Vec3 };
