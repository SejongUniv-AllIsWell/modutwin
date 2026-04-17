// Kabsch 알고리즘: N개의 대응점 (source → target) 사이 최소자승 강체 변환 R, t 추정.
// target ≈ R * source + t.
//
// SVD를 통해 회전을 유도하고, det 보정으로 반사가 없는 정상 회전을 얻는다.

import type { Mat3, Vec3 } from './mat3';
import { mat3Create, mat3Mul, mat3Transpose, mat3Det, svd3 } from './mat3';

export interface RigidTransform {
  /** 3x3 회전 행렬 (row-major) */
  R: Mat3;
  /** 평행이동 벡터 */
  t: Vec3;
  /** 각 대응점 잔차의 RMSD (meters) */
  rmsd: number;
}

/**
 * source[i] → target[i] 대응에 대해 강체 변환을 추정.
 * @param source Float64Array(N*3), [x0,y0,z0, x1,y1,z1, ...]
 * @param target Float64Array(N*3), 동일 길이
 * @param count  N
 * @returns R, t, rmsd. count < 3이면 회전을 유일하게 결정할 수 없으므로 예외.
 */
export function kabsch(
  source: Float64Array | number[],
  target: Float64Array | number[],
  count: number,
): RigidTransform {
  if (count < 3) throw new Error(`Kabsch: 최소 3개 대응점이 필요 (got ${count})`);

  // Centroid
  let pcx=0, pcy=0, pcz=0, qcx=0, qcy=0, qcz=0;
  for (let i = 0; i < count; i++) {
    pcx += source[i*3]; pcy += source[i*3+1]; pcz += source[i*3+2];
    qcx += target[i*3]; qcy += target[i*3+1]; qcz += target[i*3+2];
  }
  pcx /= count; pcy /= count; pcz /= count;
  qcx /= count; qcy /= count; qcz /= count;

  // H = sum_i (p_i - pc)(q_i - qc)^T  (3x3)
  const H = mat3Create();
  for (let i = 0; i < count; i++) {
    const dpx = source[i*3] - pcx, dpy = source[i*3+1] - pcy, dpz = source[i*3+2] - pcz;
    const dqx = target[i*3] - qcx, dqy = target[i*3+1] - qcy, dqz = target[i*3+2] - qcz;
    H[0] += dpx*dqx; H[1] += dpx*dqy; H[2] += dpx*dqz;
    H[3] += dpy*dqx; H[4] += dpy*dqy; H[5] += dpy*dqz;
    H[6] += dpz*dqx; H[7] += dpz*dqy; H[8] += dpz*dqz;
  }

  // SVD: H = U * S * V^T
  const U = mat3Create(), V = mat3Create();
  const S = new Float64Array(3);
  svd3(H, U, S, V);

  // R = V * diag(1,1,d) * U^T, d = sign(det(V U^T))
  const Ut = mat3Create();
  mat3Transpose(Ut, U);
  const VUt = mat3Create();
  mat3Mul(VUt, V, Ut);
  const d = mat3Det(VUt) < 0 ? -1 : 1;

  // V' = V * diag(1,1,d) — V의 3번째 열에 d를 곱함
  const Vp = new Float64Array(V);
  Vp[2] *= d; Vp[5] *= d; Vp[8] *= d;

  const R = mat3Create();
  mat3Mul(R, Vp, Ut);

  // t = qc - R * pc
  const tx = qcx - (R[0]*pcx + R[1]*pcy + R[2]*pcz);
  const ty = qcy - (R[3]*pcx + R[4]*pcy + R[5]*pcz);
  const tz = qcz - (R[6]*pcx + R[7]*pcy + R[8]*pcz);

  // RMSD
  let sumSq = 0;
  for (let i = 0; i < count; i++) {
    const px = source[i*3], py = source[i*3+1], pz = source[i*3+2];
    const rx = R[0]*px + R[1]*py + R[2]*pz + tx;
    const ry = R[3]*px + R[4]*py + R[5]*pz + ty;
    const rz = R[6]*px + R[7]*py + R[8]*pz + tz;
    const ex = rx - target[i*3], ey = ry - target[i*3+1], ez = rz - target[i*3+2];
    sumSq += ex*ex + ey*ey + ez*ez;
  }
  const rmsd = Math.sqrt(sumSq / count);

  return { R, t: [tx, ty, tz], rmsd };
}

/**
 * Kabsch 결과를 사용해 point cloud에 변환을 적용.
 * 위치는 R*p + t, 스케일/불투명도는 그대로, 회전(쿼터니언)은 R과 합성.
 *
 * @param positions Float32Array(N*3) [x,y,z,...]  — in-place 수정
 * @param transform {R, t}
 */
export function applyRigidToPositions(
  positions: Float32Array,
  numPoints: number,
  transform: RigidTransform,
): void {
  const { R, t } = transform;
  for (let i = 0; i < numPoints; i++) {
    const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
    positions[i*3]   = R[0]*x + R[1]*y + R[2]*z + t[0];
    positions[i*3+1] = R[3]*x + R[4]*y + R[5]*z + t[1];
    positions[i*3+2] = R[6]*x + R[7]*y + R[8]*z + t[2];
  }
}
