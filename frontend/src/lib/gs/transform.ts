import type { GaussianScene } from '../ply/types';

/**
 * Rotate every gaussian in place by R = Rz(rotZ) · Rx(rotX).
 * Updates positions (x,y,z) and rotation quaternions (rot_0..rot_3 = w,x,y,z).
 * Scales/SH coefficients are unchanged (SH rotation is non-trivial but SH DC
 * is invariant, so for SH=0 scenes this is exact).
 */
export function rotateScene(scene: GaussianScene, rotX: number, rotZ: number): void {
  if (rotX === 0 && rotZ === 0) return;

  const cx = Math.cos(rotX), sx = Math.sin(rotX);
  const cz = Math.cos(rotZ), sz = Math.sin(rotZ);
  // R = Rz·Rx
  //   [cz, -sz·cx,  sz·sx]
  //   [sz,  cz·cx, -cz·sx]
  //   [0,   sx,     cx   ]

  const px = scene.attrs.get('x');
  const py = scene.attrs.get('y');
  const pz = scene.attrs.get('z');
  if (!px || !py || !pz) throw new Error('rotateScene: x/y/z required');

  for (let i = 0; i < scene.numSplats; i++) {
    const x = px[i], y = py[i], z = pz[i];
    px[i] = cz * x - sz * cx * y + sz * sx * z;
    py[i] = sz * x + cz * cx * y - cz * sx * z;
    pz[i] = sx * y + cx * z;
  }

  // Quaternion form of R = Rz·Rx:
  //   q_Rx = (cos(rotX/2), sin(rotX/2), 0, 0)
  //   q_Rz = (cos(rotZ/2), 0, 0, sin(rotZ/2))
  //   q_R  = q_Rz · q_Rx = (cz2·cx2, cz2·sx2, sz2·sx2, sz2·cx2)
  const cx2 = Math.cos(rotX / 2), sx2 = Math.sin(rotX / 2);
  const cz2 = Math.cos(rotZ / 2), sz2 = Math.sin(rotZ / 2);
  const Rw = cz2 * cx2, Rx = cz2 * sx2, Ry = sz2 * sx2, Rz = sz2 * cx2;

  const r0 = scene.attrs.get('rot_0');
  const r1 = scene.attrs.get('rot_1');
  const r2 = scene.attrs.get('rot_2');
  const r3 = scene.attrs.get('rot_3');
  if (r0 && r1 && r2 && r3) {
    for (let i = 0; i < scene.numSplats; i++) {
      const qw = r0[i], qx = r1[i], qy = r2[i], qz = r3[i];
      // q_new = q_R · q
      r0[i] = Rw * qw - Rx * qx - Ry * qy - Rz * qz;
      r1[i] = Rw * qx + Rx * qw + Ry * qz - Rz * qy;
      r2[i] = Rw * qy - Rx * qz + Ry * qw + Rz * qx;
      r3[i] = Rw * qz + Rx * qy - Ry * qx + Rz * qw;
    }
  }
}

/** Rotate a single 3D point by R = Rz(rotZ) · Rx(rotX). */
export function rotatePoint(x: number, y: number, z: number, rotX: number, rotZ: number): [number, number, number] {
  const cx = Math.cos(rotX), sx = Math.sin(rotX);
  const cz = Math.cos(rotZ), sz = Math.sin(rotZ);
  return [
    cz * x - sz * cx * y + sz * sx * z,
    sz * x + cz * cx * y - cz * sx * z,
    sx * y + cx * z,
  ];
}

/**
 * Rotate every gaussian in place by Ry(rotY).
 * Updates positions (x,z) and rotation quaternions. y/scales unchanged.
 *
 * 용도: 벽면이 X/Z 축과 나란하도록 wallAngle 만큼 (또는 그 반대) 회전할 때.
 */
export function rotateSceneY(scene: GaussianScene, rotY: number): void {
  if (rotY === 0) return;
  const c = Math.cos(rotY), s = Math.sin(rotY);
  // Ry: [c 0 s; 0 1 0; -s 0 c]
  const px = scene.attrs.get('x');
  const py = scene.attrs.get('y');
  const pz = scene.attrs.get('z');
  if (!px || !py || !pz) throw new Error('rotateSceneY: x/y/z required');
  for (let i = 0; i < scene.numSplats; i++) {
    const x = px[i], z = pz[i];
    px[i] = c * x + s * z;
    pz[i] = -s * x + c * z;
  }
  // Quaternion: q_Ry = (cos(rotY/2), 0, sin(rotY/2), 0)
  const c2 = Math.cos(rotY / 2), s2 = Math.sin(rotY / 2);
  const Rw = c2, Ry = s2;
  const r0 = scene.attrs.get('rot_0');
  const r1 = scene.attrs.get('rot_1');
  const r2 = scene.attrs.get('rot_2');
  const r3 = scene.attrs.get('rot_3');
  if (r0 && r1 && r2 && r3) {
    for (let i = 0; i < scene.numSplats; i++) {
      const qw = r0[i], qx = r1[i], qy = r2[i], qz = r3[i];
      // q_new = q_R · q  where q_R = (Rw, 0, Ry, 0)
      r0[i] = Rw * qw - Ry * qy;
      r1[i] = Rw * qx + Ry * qz;
      r2[i] = Rw * qy + Ry * qw;
      r3[i] = Rw * qz - Ry * qx;
    }
  }
}

/** Rotate a single 3D point by Ry(rotY). */
export function rotatePointY(x: number, y: number, z: number, rotY: number): [number, number, number] {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return [c * x + s * z, y, -s * x + c * z];
}

/**
 * Translate every gaussian in place by (tx, ty, tz). Positions only.
 * Rotations/scales/SH 모두 translation-invariant 이므로 변경 없음.
 */
export function translateScene(scene: GaussianScene, tx: number, ty: number, tz: number): void {
  if (tx === 0 && ty === 0 && tz === 0) return;
  const px = scene.attrs.get('x');
  const py = scene.attrs.get('y');
  const pz = scene.attrs.get('z');
  if (!px || !py || !pz) throw new Error('translateScene: x/y/z required');
  for (let i = 0; i < scene.numSplats; i++) {
    px[i] += tx; py[i] += ty; pz[i] += tz;
  }
}

/**
 * 가우시안 위치의 alpha-가중 평균(중심) 산출.
 * alpha < 1e-3 인 splat 은 무시 (브러시 삭제 등으로 잘려나간 가우시안 배제).
 * 알파 어레이가 없으면 모두 사용.
 */
export function computeBboxCenter(scene: GaussianScene): [number, number, number] {
  const px = scene.attrs.get('x');
  const py = scene.attrs.get('y');
  const pz = scene.attrs.get('z');
  if (!px || !py || !pz) throw new Error('computeBboxCenter: x/y/z required');
  let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (let i = 0; i < scene.numSplats; i++) {
    const x = px[i], y = py[i], z = pz[i];
    if (x < mnX) mnX = x; if (x > mxX) mxX = x;
    if (y < mnY) mnY = y; if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
  }
  return [(mnX + mxX) / 2, (mnY + mxY) / 2, (mnZ + mxZ) / 2];
}
