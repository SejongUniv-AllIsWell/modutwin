import type { GaussianScene } from '@/lib/ply/types';

export interface RotationAngles {
  rotX: number;
  rotZ: number;
}

export interface RotatedPositions {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
}

export async function buildRotatedScene(origin: GaussianScene, rotation: RotationAngles): Promise<GaussianScene> {
  const { rotX, rotZ } = rotation;
  if (rotX === 0 && rotZ === 0) return origin;
  const { rotateScene } = await import('@/lib/gs');
  const cloned: GaussianScene = {
    numSplats: origin.numSplats,
    propertyOrder: [...origin.propertyOrder],
    attrs: new Map(origin.attrs),
  };
  for (const p of ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) {
    const arr = origin.attrs.get(p);
    if (arr) cloned.attrs.set(p, new Float32Array(arr));
  }
  rotateScene(cloned, rotX, rotZ);
  return cloned;
}

export function buildRotatedPositions(
  px: Float32Array,
  py: Float32Array,
  pz: Float32Array,
  rotation: RotationAngles,
): RotatedPositions {
  const { rotX, rotZ } = rotation;
  if (rotX === 0 && rotZ === 0) return { x: px, y: py, z: pz };
  const n = px.length;
  const cx = Math.cos(rotX), sx = Math.sin(rotX);
  const cz = Math.cos(rotZ), sz = Math.sin(rotZ);
  const rx = new Float32Array(n);
  const ry = new Float32Array(n);
  const rz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = px[i], y = py[i], z = pz[i];
    rx[i] = cz * x - sz * cx * y + sz * sx * z;
    ry[i] = sz * x + cz * cx * y - cz * sx * z;
    rz[i] = sx * y + cx * z;
  }
  return { x: rx, y: ry, z: rz };
}
