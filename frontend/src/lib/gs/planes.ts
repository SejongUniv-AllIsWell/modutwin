export type Vec3 = [number, number, number];

export interface SurfacePlane {
  id: string;
  normal: Vec3;
  d: number;
}

export function surfacePlanesFromRoom(opts: {
  angleDeg: number;
  walls: [number, number, number, number];
  ceilingY: number;
  floorY: number;
}): SurfacePlane[] {
  const rad = (opts.angleDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const [a1, b1, a2, b2] = opts.walls;
  return [
    { id: 'ceiling', normal: [0, 1, 0], d: opts.ceilingY },
    { id: 'floor',   normal: [0, -1, 0], d: -opts.floorY },
    { id: 'w1a',     normal: [-c, 0, -s], d: -a1 },
    { id: 'w1b',     normal: [c, 0, s], d: b1 },
    { id: 'w2a',     normal: [s, 0, -c], d: -a2 },
    { id: 'w2b',     normal: [-s, 0, c], d: b2 },
  ];
}

export function signedDistance(
  plane: SurfacePlane, x: number, y: number, z: number,
): number {
  return plane.normal[0] * x + plane.normal[1] * y + plane.normal[2] * z - plane.d;
}
