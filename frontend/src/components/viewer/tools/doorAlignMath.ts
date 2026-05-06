import type { Vec3 } from './doorAlignDoors';

/** 3x3 회전행렬 (row-major) → quaternion [w, x, y, z] */
export function rotationMatrixToQuat(R: ArrayLike<number>): [number, number, number, number] {
  const m00 = R[0],
    m01 = R[1],
    m02 = R[2];
  const m10 = R[3],
    m11 = R[4],
    m12 = R[5];
  const m20 = R[6],
    m21 = R[7],
    m22 = R[8];
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

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** "[[x,y,z],[x,y,z],[x,y,z],[x,y,z]]" 형태 JSON 파싱 */
export function parseBasemapCorners(text: string): Vec3[] | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const out: Vec3[] = [];
    for (const c of parsed) {
      if (!Array.isArray(c) || c.length !== 3) return null;
      const x = Number(c[0]),
        y = Number(c[1]),
        z = Number(c[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
      out.push([x, y, z]);
    }
    return out;
  } catch {
    return null;
  }
}
