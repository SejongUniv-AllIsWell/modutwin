export type Axis = 'x' | 'y' | 'z';

/** 축+각도 → 쿼터니언 [w, x, y, z] */
export function axisAngleToQuat(axis: Axis, angle: number): [number, number, number, number] {
  const half = angle / 2;
  const s = Math.sin(half);
  const c = Math.cos(half);
  if (axis === 'x') return [c, s, 0, 0];
  if (axis === 'y') return [c, 0, s, 0];
  return [c, 0, 0, s];
}

/** 쿼터니언 곱: q1 * q2 (둘 다 [w,x,y,z]) */
export function quatMul(
  w1: number, x1: number, y1: number, z1: number,
  w2: number, x2: number, y2: number, z2: number,
): [number, number, number, number] {
  return [
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
  ];
}

/** 쿼터니언 정규화 */
export function quatNormalize(w: number, x: number, y: number, z: number): [number, number, number, number] {
  const len = Math.sqrt(w * w + x * x + y * y + z * z);
  if (len < 1e-10) return [1, 0, 0, 0];
  return [w / len, x / len, y / len, z / len];
}

/** pivot 기준으로 축 회전 적용 (위치) */
export function rotatePoint(
  px: number, py: number, pz: number,
  pivot: [number, number, number],
  axis: Axis,
  angle: number,
): [number, number, number] {
  const rx = px - pivot[0];
  const ry = py - pivot[1];
  const rz = pz - pivot[2];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let nx: number, ny: number, nz: number;
  if (axis === 'y') {
    nx = rx * cos + rz * sin; ny = ry; nz = -rx * sin + rz * cos;
  } else if (axis === 'x') {
    nx = rx; ny = ry * cos - rz * sin; nz = ry * sin + rz * cos;
  } else {
    nx = rx * cos - ry * sin; ny = rx * sin + ry * cos; nz = rz;
  }
  return [nx + pivot[0], ny + pivot[1], nz + pivot[2]];
}
