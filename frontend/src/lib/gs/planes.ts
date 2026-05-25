export type Vec3 = [number, number, number];

export interface SurfacePlane {
  id: string;
  normal: Vec3;
  d: number;
  /**
   * 벽 plane 한정 — 무한 plane 이 아닌 실제 segment 영역.
   * 사용처: `raycastToPlanes` 첫 코너 픽에서 평면 교점이 이 segment 영역 안에 있을 때만 후보 인정.
   * 그러지 않으면 N-각형(특히 비스듬한 벽이나 concave)에서 같은 ray 가 여러 벽 plane 을 양수 t 로
   * 교차해 사용자가 보지 않는 다른 벽 plane 이 잘못 채택되는 문제 (수동 도어 픽이 안쪽으로 들어가
   * 찍히거나 작게 쪼그라드는 증상) 발생.
   * 천장/바닥은 polygon mask 가 별도로 처리하므로 여기선 미부여.
   */
  segment?: {
    a: { x: number; z: number };  // edge 시작점 (polygon[i])
    b: { x: number; z: number };  // edge 끝점 (polygon[(i+1)%N])
    yMin: number;                  // floor y
    yMax: number;                  // ceiling y
  };
}

export interface PolygonPoint {
  x: number;
  z: number;
}

/**
 * 폴리곤 (XZ 평면의 N 점) → 천장/바닥 + N벽 SurfacePlane[].
 *
 * - 폴리곤 점들은 닫힌 다각형으로 해석 (마지막 점이 첫 점과 연결).
 * - **shoelace + winding 기반** outward normal 결정 — convex/concave 모두 robust.
 *   - signed area > 0 → polygon 점들이 XZ 평면에서 CCW (반시계).
 *     각 변 (a→b) 의 outward normal = 진행방향 오른쪽 (시계방향 90° 회전): (dz, 0, -dx)/len.
 *   - signed area < 0 → CW. outward 는 반대.
 *   centroid 기반 판정은 비-볼록 polygon (L자/ㄷ자) 에서 centroid 가 외부일 때 잘못된 방향을
 *   고를 수 있어 사용 안 함.
 * - 각 벽 surfaceId: `w0..w(N-1)` 동적. polygon i번째 변 ↔ `w${i}`.
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

  // shoelace signed area — XZ 평면 (y 무시).
  //   sum = Σ (x_i * z_{i+1} - x_{i+1} * z_i). 양수면 CCW (XZ 좌표축 기준), 음수면 CW.
  let signed2A = 0;
  const N = polygon.length;
  for (let i = 0; i < N; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % N];
    signed2A += a.x * b.z - b.x * a.z;
  }
  // outward 방향 부호 — CCW 면 변 진행방향 오른쪽 (시계 90° = (dz, -dx)) 이 outward.
  // sign > 0 → CCW → outward = (dz, -dx)/len.   sign < 0 → CW → outward = (-dz, dx)/len.
  const outwardSign = signed2A > 0 ? 1 : -1;

  const walls: SurfacePlane[] = [];
  for (let i = 0; i < N; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % N];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) continue;  // 중복점 skip
    const nx = outwardSign * (dz / len);
    const nz = outwardSign * (-dx / len);
    // 평면 방정식: n·p = d, 한 점 a 가 평면 위.
    const d = nx * a.x + nz * a.z;
    walls.push({
      id: `w${i}`, normal: [nx, 0, nz], d,
      segment: {
        a: { x: a.x, z: a.z },
        b: { x: b.x, z: b.z },
        yMin: Math.min(ceilingY, floorY),
        yMax: Math.max(ceilingY, floorY),
      },
    });
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
  // 벽면 (`w0..w(N-1)` 동적 ID) 은 모두 세이지 그린 단일.
  return WALL_COLOR_SAGE;
}

export function signedDistance(
  plane: SurfacePlane, x: number, y: number, z: number,
): number {
  return plane.normal[0] * x + plane.normal[1] * y + plane.normal[2] * z - plane.d;
}
