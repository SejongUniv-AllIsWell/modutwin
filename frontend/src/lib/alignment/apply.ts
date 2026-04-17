// 추정된 강체 변환을 GaussianScene에 적용.
// - 위치: R*p + t
// - 가우시안 쿼터니언 (rot_0=w, rot_1=x, rot_2=y, rot_3=z): q_R * q  (left-multiply)
//   R의 회전을 쿼터니언으로 변환 후 합성. 스케일은 변하지 않음.

import type { GaussianScene } from '../ply/types';
import type { RigidTransform } from './kabsch';
import type { Mat3 } from './mat3';

function rotationMatrixToQuaternion(R: Mat3): [number, number, number, number] {
  const m00=R[0], m01=R[1], m02=R[2];
  const m10=R[3], m11=R[4], m12=R[5];
  const m20=R[6], m21=R[7], m22=R[8];
  const tr = m00 + m11 + m22;
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return [w, x, y, z];
}

function quatMul(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): [number, number, number, number] {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw*bw - ax*bx - ay*by - az*bz,
    aw*bx + ax*bw + ay*bz - az*by,
    aw*by - ax*bz + ay*bw + az*bx,
    aw*bz + ax*by - ay*bx + az*bw,
  ];
}

/**
 * Scene 전체에 강체 변환 적용. in-place로 attrs를 수정한다.
 * x/y/z는 필수. rot_0~rot_3가 있으면 쿼터니언 회전도 합성한다.
 */
export function applyRigidToScene(scene: GaussianScene, transform: RigidTransform): void {
  const { R, t } = transform;
  const px = scene.attrs.get('x');
  const py = scene.attrs.get('y');
  const pz = scene.attrs.get('z');
  if (!px || !py || !pz) throw new Error('applyRigidToScene: x/y/z required');

  const N = scene.numSplats;
  for (let i = 0; i < N; i++) {
    const x = px[i], y = py[i], z = pz[i];
    px[i] = R[0]*x + R[1]*y + R[2]*z + t[0];
    py[i] = R[3]*x + R[4]*y + R[5]*z + t[1];
    pz[i] = R[6]*x + R[7]*y + R[8]*z + t[2];
  }

  const r0 = scene.attrs.get('rot_0');
  const r1 = scene.attrs.get('rot_1');
  const r2 = scene.attrs.get('rot_2');
  const r3 = scene.attrs.get('rot_3');
  if (r0 && r1 && r2 && r3) {
    const qR = rotationMatrixToQuaternion(R);
    for (let i = 0; i < N; i++) {
      // PLY 컨벤션: rot_0=w, rot_1=x, rot_2=y, rot_3=z
      const q: [number, number, number, number] = [r0[i], r1[i], r2[i], r3[i]];
      // 단위 쿼터니언으로 정규화 (저장된 쿼터니언이 미정규일 수 있음)
      const norm = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      q[0] /= norm; q[1] /= norm; q[2] /= norm; q[3] /= norm;
      const q2 = quatMul(qR, q);
      r0[i] = q2[0]; r1[i] = q2[1]; r2[i] = q2[2]; r3[i] = q2[3];
    }
  }
}
