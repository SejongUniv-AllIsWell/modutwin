/**
 * 평면 offset 시각화용 화살표 엔티티 생성.
 *
 * 두 가지 용도:
 *   - 안전거리 (globalOffset): 각 면 중심에서 ±normal 양방향. 면별 색.
 *   - 알파 블렌딩 시작 (depthGate): 각 면 중심에서 -normal 방향(방 안쪽)만. 단일 색.
 *
 * 좌표는 A' 프레임 (raw + pendingRotation) — wallMesh와 동일하게
 * Z-180만 직접 부여하여 splat과 정렬.
 *
 * N벽 일반화: 입력은 SurfacePlane[] + 폴리곤 (XZ) + 천장/바닥 Y. wall face center 는
 * 폴리곤 i 번째 변의 중점, ceiling/floor 는 폴리곤 centroid 위에 위치.
 */

import type { Vec3 } from './textureBake';
import type { SurfacePlane, PolygonPoint } from './planes';

export interface SafetyVizGeometry {
  /** ceiling/floor + w0..w(N-1) 모두 포함 (보통 surfacePlanesFromPolygon 결과). */
  planes: SurfacePlane[];
  /** wall 변 정의용 폴리곤 (cycle 순서). planes 의 `w${i}` 와 인덱스 매칭. */
  polygon: PolygonPoint[];
  ceilingY: number;
  floorY: number;
}

interface FaceDef {
  id: string;
  center: Vec3;
  normal: Vec3;
  color: [number, number, number];
}

// w0, w1, w2, ... 순환 색상 (HSV-spread). 단일 시각 가이드이므로 정확한 색 불필요.
const WALL_PALETTE: Array<[number, number, number]> = [
  [1.0, 0.3, 0.3],
  [0.3, 1.0, 0.3],
  [1.0, 1.0, 0.3],
  [0.6, 0.3, 1.0],
  [0.3, 1.0, 1.0],
  [1.0, 0.3, 1.0],
  [1.0, 0.6, 0.2],
  [0.2, 0.6, 1.0],
];

function buildFaces(geom: SafetyVizGeometry): FaceDef[] {
  const { planes, polygon, ceilingY: cy, floorY: fy } = geom;
  const yMid = (cy + fy) / 2;

  // 폴리곤 centroid (XZ) — ceiling/floor face center.
  let cxSum = 0, czSum = 0;
  for (const p of polygon) { cxSum += p.x; czSum += p.z; }
  const cx = polygon.length > 0 ? cxSum / polygon.length : 0;
  const cz = polygon.length > 0 ? czSum / polygon.length : 0;

  const faces: FaceDef[] = [];
  const N = polygon.length;
  for (const plane of planes) {
    if (plane.id === 'ceiling') {
      faces.push({
        id: 'ceiling',
        center: [cx, cy, cz],
        normal: [plane.normal[0], plane.normal[1], plane.normal[2]],
        color: [1.0, 0.5, 0.2],
      });
      continue;
    }
    if (plane.id === 'floor') {
      faces.push({
        id: 'floor',
        center: [cx, fy, cz],
        normal: [plane.normal[0], plane.normal[1], plane.normal[2]],
        color: [0.4, 0.7, 1.0],
      });
      continue;
    }
    const m = /^w(\d+)$/.exec(plane.id);
    if (!m) continue;
    const i = parseInt(m[1], 10);
    if (i < 0 || i >= N) continue;
    const a = polygon[i];
    const b = polygon[(i + 1) % N];
    const mx = (a.x + b.x) * 0.5;
    const mz = (a.z + b.z) * 0.5;
    faces.push({
      id: plane.id,
      center: [mx, yMid, mz],
      normal: [plane.normal[0], plane.normal[1], plane.normal[2]],
      color: WALL_PALETTE[i % WALL_PALETTE.length],
    });
  }
  return faces;
}

function createArrow(
  pc: any,
  center: Vec3,
  dir: Vec3,
  length: number,
  color: [number, number, number],
  thickness: number,
  name: string,
): any {
  const mat = new pc.StandardMaterial();
  mat.useLighting = false;
  mat.emissive.set(color[0], color[1], color[2]);
  mat.diffuse.set(0, 0, 0);
  mat.cull = pc.CULLFACE_NONE;
  mat.update();

  const root = new pc.Entity(name);

  const bodyLen = length * 0.8;
  const tipLen = length * 0.2;

  const body = new pc.Entity('body');
  body.addComponent('render', { type: 'cylinder' });
  body.render.material = mat;
  body.setLocalScale(thickness * 2, bodyLen, thickness * 2);
  body.setLocalPosition(0, bodyLen / 2, 0);
  root.addChild(body);

  const tip = new pc.Entity('tip');
  tip.addComponent('render', { type: 'cone' });
  tip.render.material = mat;
  tip.setLocalScale(thickness * 5, tipLen, thickness * 5);
  tip.setLocalPosition(0, bodyLen + tipLen / 2, 0);
  root.addChild(tip);

  const upX = 0, upY = 1, upZ = 0;
  const dx = dir[0], dy = dir[1], dz = dir[2];
  const dot = upX * dx + upY * dy + upZ * dz;
  const q = new pc.Quat();
  if (dot > 0.9999) {
    // identity
  } else if (dot < -0.9999) {
    q.setFromAxisAngle(new pc.Vec3(1, 0, 0), 180);
  } else {
    const ax = upY * dz - upZ * dy;
    const ay = upZ * dx - upX * dz;
    const az = upX * dy - upY * dx;
    const aLen = Math.hypot(ax, ay, az) || 1;
    const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    q.setFromAxisAngle(new pc.Vec3(ax / aLen, ay / aLen, az / aLen), angleDeg);
  }
  root.setLocalRotation(q);
  root.setLocalPosition(center[0], center[1], center[2]);

  return root;
}

export interface OffsetArrowsOptions {
  /** 'both' = ±normal 둘 다, 'outward' = +normal만, 'inward' = -normal만 */
  direction: 'both' | 'outward' | 'inward';
  /** 모든 면에 동일한 색을 강제. 미지정 시 면별 색. */
  colorOverride?: [number, number, number];
  thickness?: number;
  name?: string;
  /** 화살표 시작점을 face center로부터 normal 방향으로 얼마나 이동할지 (m).
   *  + = 바깥(normal), - = 안쪽. 0이면 face center에서 시작. */
  originOffset?: number;
}

/**
 * 모든 면 (천장/바닥/N벽) 에 화살표를 배치한 부모 엔티티 반환.
 * app.root에 붙이면 됨 (Z-180은 내부에서 부여).
 */
export function createOffsetArrows(
  pc: any,
  geom: SafetyVizGeometry,
  offset: number,
  opts: OffsetArrowsOptions,
): any {
  const parent = new pc.Entity(opts.name ?? 'offsetArrows');
  parent.setLocalEulerAngles(0, 0, 180);
  if (offset <= 0) return parent;

  const thickness = opts.thickness ?? 0.015;
  const originOffset = opts.originOffset ?? 0;
  const faces = buildFaces(geom);
  for (const f of faces) {
    const color = opts.colorOverride ?? f.color;
    const originCenter: Vec3 = [
      f.center[0] + originOffset * f.normal[0],
      f.center[1] + originOffset * f.normal[1],
      f.center[2] + originOffset * f.normal[2],
    ];
    if (opts.direction === 'both' || opts.direction === 'outward') {
      parent.addChild(createArrow(pc, originCenter, f.normal, offset, color, thickness, `${f.id}_out`));
    }
    if (opts.direction === 'both' || opts.direction === 'inward') {
      const negDir: Vec3 = [-f.normal[0], -f.normal[1], -f.normal[2]];
      parent.addChild(createArrow(pc, originCenter, negDir, offset, color, thickness, `${f.id}_in`));
    }
  }
  return parent;
}
