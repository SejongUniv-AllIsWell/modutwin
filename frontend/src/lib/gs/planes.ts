export type Vec3 = [number, number, number];

export interface SurfacePlane {
  id: string;
  normal: Vec3;
  d: number;
}

/**
 * 레거시: 축 정렬 4벽 + 천장/바닥 = 6면 SurfacePlane[].
 * `angleDeg` 회전된 frame 에서 a1/b1 (축1 min/max), a2/b2 (축2 min/max) 거리로 4벽 정의.
 * 새 코드는 가능하면 `surfacePlanesFromPolygon` 사용 (자유 N벽).
 */
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

export interface PolygonPoint {
  x: number;
  z: number;
}

/**
 * 폴리곤 (XZ 평면의 N 점) → 천장/바닥 + N벽 SurfacePlane[].
 *
 * - 폴리곤 점들은 닫힌 다각형으로 해석 (마지막 점이 첫 점과 연결).
 * - CCW/CW 방향 무관 — centroid 기준으로 각 변의 outward normal 방향 자동 결정.
 * - 각 벽 surfaceId: `w0..w(N-1)` 동적.
 */
export function surfacePlanesFromPolygon(opts: {
  polygon: PolygonPoint[];
  ceilingY: number;
  floorY: number;
}): SurfacePlane[] {
  const { polygon, ceilingY, floorY } = opts;
  if (polygon.length < 3) {
    // 폴리곤 < 3점이면 벽 없음. 천장/바닥만.
    return [
      { id: 'ceiling', normal: [0, 1, 0], d: ceilingY },
      { id: 'floor',   normal: [0, -1, 0], d: -floorY },
    ];
  }

  let cx = 0, cz = 0;
  for (const p of polygon) { cx += p.x; cz += p.z; }
  cx /= polygon.length;
  cz /= polygon.length;

  const walls: SurfacePlane[] = [];
  const N = polygon.length;
  for (let i = 0; i < N; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % N];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) continue;  // 중복점 skip
    // 후보 normal — 90° 회전 (XZ 평면, Y=0).
    let nx = dz / len;
    let nz = -dx / len;
    // outward 방향 확인: 변의 중점 - centroid 와 같은 부호여야 outward.
    const mx = (a.x + b.x) * 0.5;
    const mz = (a.z + b.z) * 0.5;
    const out = nx * (mx - cx) + nz * (mz - cz);
    if (out < 0) { nx = -nx; nz = -nz; }
    // 평면 방정식: n·p = d, 한 점 a 가 평면 위.
    const d = nx * a.x + nz * a.z;
    walls.push({ id: `w${i}`, normal: [nx, 0, nz], d });
  }

  return [
    { id: 'ceiling', normal: [0, 1, 0], d: ceilingY },
    { id: 'floor',   normal: [0, -1, 0], d: -floorY },
    ...walls,
  ];
}

/**
 * surfaceId → 시각 가이드 색.
 *  - ceiling: brown (#92400e — 코드상 PLY +Y 면, Z-180 회전 후 시각 바닥)
 *  - floor:   cyan  (#22d3ee — 시각 천장)
 *  - w*:      **세이지 그린** (#86efac) 단일 — N개 벽 모두 동일 색
 */
export const WALL_COLOR_SAGE: [number, number, number] = [0.525, 0.937, 0.675]; // #86efac
export function surfaceColor(id: string): [number, number, number] {
  if (id === 'ceiling') return [0.573, 0.251, 0.055];
  if (id === 'floor')   return [0.133, 0.827, 0.933];
  // 벽면은 동적이든 레거시(w1a/w1b/w2a/w2b)든 모두 세이지 그린 단일.
  return WALL_COLOR_SAGE;
}

export function signedDistance(
  plane: SurfacePlane, x: number, y: number, z: number,
): number {
  return plane.normal[0] * x + plane.normal[1] * y + plane.normal[2] * z - plane.d;
}
