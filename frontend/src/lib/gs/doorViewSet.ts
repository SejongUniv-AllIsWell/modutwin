// 클라이언트 렌더 SAM3 — 벽 정면 카메라 뷰셋 생성기.
//
// 서버 `core/door_detection/render/camera_sampler.py: sample_wall_facing_cameras` 의
// 기하 부분을 TS 로 포팅. 입력은 다듬기에서 확정된 **A' 프레임** 방 footprint(폴리곤 X-Z)
// + 천장/바닥 Y + raw→A' 회전(rotX,rotZ). 카메라는 A' 에서 벽 정면으로 만든 뒤
// **A'→raw(Rᵀ)** 로 변환해 PlayCanvas(=raw PLY 프레임) 렌더에 바로 쓸 수 있게 한다.
//
// 차이점(의도적): 서버의 air-check(가우시안 KDTree back-off)는 클라에 means KDTree 가
// 없어 생략하고 standoff 를 고정한다. 커버리지가 부족하면 nTotal/standoffScale 로 보정.

export interface DoorCameraSpec {
  idx: number;
  /** raw PLY 프레임 (PlayCanvas world) */
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  /** 세로 FOV(도). 정사각 이미지이므로 fov_x=fov_y. */
  fov: number;
}

type Vec3 = [number, number, number];
type Mat3 = [number, number, number, number, number, number, number, number, number]; // row-major

// bake_rotation_matrix(rotX, rotZ) = Rz(rotZ)·Rx(rotX)  (raw→A'), row-major 3x3.
function bakeRotationMatrix(rotX: number, rotZ: number): Mat3 {
  const cx = Math.cos(rotX), sx = Math.sin(rotX);
  const cz = Math.cos(rotZ), sz = Math.sin(rotZ);
  // Rx
  const rx: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  // Rz
  const rz: Mat3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mat3mul(rz, rx);
}

function mat3mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

function mat3T(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

function matVec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function buildDoorViewSet(params: {
  wallPolygonAP: { x: number; z: number }[]; // A' footprint (cycle 순)
  floorY: number;
  ceilingY: number;
  rotX: number; // raw→A'
  rotZ: number;
  nTotal?: number;
  fovDeg?: number;
  eyeRatio?: number;
  minStandoff?: number;
  depthFrac?: number;
  standoffScale?: number;
}): DoorCameraSpec[] {
  const {
    wallPolygonAP, floorY, ceilingY, rotX, rotZ,
    nTotal = 32, fovDeg = 60, eyeRatio = 0.7,
    minStandoff = 0.6, depthFrac = 0.85, standoffScale = 1.0,
  } = params;

  const poly = wallPolygonAP.map(p => [p.x, p.z] as [number, number]);
  const n = poly.length;
  if (n < 3) throw new Error(`wall polygon needs >=3 points, got ${n}`);

  // centroid
  const centroid: [number, number] = [
    poly.reduce((s, p) => s + p[0], 0) / n,
    poly.reduce((s, p) => s + p[1], 0) / n,
  ];

  // 시각 바닥/천장 (A' Z-180: 큰 Y = 시각 바닥) — 서버 known-room 과 동일.
  const realFloorY = Math.max(floorY, ceilingY);
  const realCeilingY = Math.min(floorY, ceilingY);
  const eyeY = realFloorY + eyeRatio * (realCeilingY - realFloorY);
  const targetY = (floorY + ceilingY) / 2;

  const roomH = Math.abs(ceilingY - floorY);
  const halfFov = (fovDeg * Math.PI) / 180 / 2;
  const standoffForHeight = roomH / 2 / Math.max(Math.tan(halfFov), 1e-6);

  // edges
  const edges: { a: [number, number]; dir: [number, number]; L: number }[] = [];
  let perim = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const seg: [number, number] = [b[0] - a[0], b[1] - a[1]];
    const L = Math.hypot(seg[0], seg[1]);
    if (L < 1e-6) continue;
    edges.push({ a, dir: [seg[0] / L, seg[1] / L], L });
    perim += L;
  }
  if (!edges.length || perim <= 0) throw new Error('degenerate wall polygon');

  // A'→raw 회전 (Rᵀ)
  const Rap2raw = mat3T(bakeRotationMatrix(rotX, rotZ));
  const toRaw = (v: Vec3): Vec3 => matVec3(Rap2raw, v);

  const specs: DoorCameraSpec[] = [];
  let idx = 0;
  for (const { a, dir, L } of edges) {
    // 안쪽 normal (centroid 향함)
    let inward: [number, number] = [dir[1], -dir[0]];
    const mid: [number, number] = [a[0] + dir[0] * (L / 2), a[1] + dir[1] * (L / 2)];
    const toC: [number, number] = [centroid[0] - mid[0], centroid[1] - mid[1]];
    if (inward[0] * toC[0] + inward[1] * toC[1] <= 0) inward = [-inward[0], -inward[1]];

    // 벽에서 방 안쪽 깊이 (standoff 상한)
    let depth = 0;
    for (const p of poly) {
      const proj = (p[0] - mid[0]) * inward[0] + (p[1] - mid[1]) * inward[1];
      if (proj > depth) depth = proj;
    }
    let standoff = Math.min(
      Math.max(standoffForHeight, minStandoff),
      Math.max(minStandoff, depth * depthFrac),
    );
    standoff *= standoffScale;

    const nAlong = Math.max(1, Math.round((nTotal * L) / perim));
    for (let k = 0; k < nAlong; k++) {
      const t = (k + 0.5) / nAlong;
      const wx = a[0] + dir[0] * (t * L);
      const wz = a[1] + dir[1] * (t * L);
      const camX = wx + inward[0] * standoff;
      const camZ = wz + inward[1] * standoff;

      // A' 프레임 카메라 → raw 변환
      const posAP: Vec3 = [camX, eyeY, camZ];
      const tgtAP: Vec3 = [wx, targetY, wz];
      const upAP: Vec3 = [0, 1, 0]; // A' world up (서버 WORLD_UP)
      specs.push({
        idx: idx++,
        position: toRaw(posAP),
        target: toRaw(tgtAP),
        up: toRaw(upAP),
        fov: fovDeg,
      });
    }
  }
  return specs;
}
