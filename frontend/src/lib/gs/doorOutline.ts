/**
 * 도어 시각화 helper — 노란 outline + (옵션) 라벨.
 *
 * basemap 등록 진행 중 추출된 도어를 뷰어에 표시하기 위함.
 * 4 corners 를 잇는 line strip (LineRender) + 도어 중앙에 PlayCanvas text mesh 라벨.
 *
 * 사용:
 *   const handle = createDoorOutlineEntity(pc, app, {
 *     corners: [[x,y,z], ...],  // 4 corners in A'+Y frame
 *     unitName: '601호' | null,
 *   });
 *   ...
 *   handle.setUnitName('602호');  // 라벨 갱신
 *   handle.destroy();             // 정리
 */

export type Vec3 = [number, number, number];

export interface DoorOutlineHandle {
  outlineEntity: any;
  labelEntity: any | null;
  setUnitName(name: string | null): void;
  setCorners(corners: Vec3[]): void;
  destroy(): void;
}

// 노란 glow — 코어 (밝은 노랑) + halo (외곽 더 두껍게 + 반투명, additive blend) 2 패스.
// 시각 효과: 가운데 진한 노랑 / 바깥쪽 부드러운 빛 번짐 → 후광 느낌.
const OUTLINE_COLOR_CORE: [number, number, number, number] = [1.0, 0.92, 0.25, 1.0];     // #FFEB40 정도
const OUTLINE_COLOR_HALO_INNER: [number, number, number, number] = [1.0, 0.85, 0.15, 0.55];
const OUTLINE_COLOR_HALO_OUTER: [number, number, number, number] = [1.0, 0.75, 0.0, 0.18];
const HALO_INNER_SCALE = 1.8;   // 코어 두께 × 1.8
const HALO_OUTER_SCALE = 3.2;   // 코어 두께 × 3.2 (외곽 glow)

export function createDoorOutlineEntity(
  pc: any,
  app: any,
  opts: {
    corners: Vec3[];        // 4 corners (A'+Y 프레임). 폐곡선 (마지막→첫번째 자동).
    unitName: string | null;
    rotation?: [number, number, number, number]; // local quaternion (entity 에 부여). null = Z-180 default.
  },
): DoorOutlineHandle {
  const root = new pc.Entity('doorOutlineRoot');

  // outline — line strip via immediate rendering layer. PlayCanvas 의 `drawLines` 또는 line render.
  // 가장 호환성 좋은 방법: app.drawLines 를 매 프레임 호출 (immediate API).
  // 대신 안정적 렌더 위해 mesh 기반 line: pc.Mesh + LineList 사용.
  const outlineEnt = new pc.Entity('doorOutline');
  root.addChild(outlineEnt);

  let cornersRef: Vec3[] = opts.corners.slice() as Vec3[];

  // 두꺼운 outline — 각 edge 를 평면 사각형 (quad) 으로 만든다.
  // 도어 평면의 normal 을 추정 (4 corners 의 평균 평면) 해서 그 평면 안에서 두꺼운 띠 형성.
  // 두께는 도어 대각선의 1% (도어 크기 무관 일정 비율) — 최소 1.5cm, 최대 4cm.
  const buildLineMesh = (corners: Vec3[], thicknessOverride?: number): any => {
    if (corners.length < 2) return null;
    const N = corners.length;

    // 도어 평면 normal 추정: 첫 3점으로 (p1-p0) × (p2-p0).
    let nx = 0, ny = 0, nz = 0;
    if (N >= 3) {
      const ux = corners[1][0] - corners[0][0];
      const uy = corners[1][1] - corners[0][1];
      const uz = corners[1][2] - corners[0][2];
      const vx = corners[2][0] - corners[0][0];
      const vy = corners[2][1] - corners[0][1];
      const vz = corners[2][2] - corners[0][2];
      nx = uy * vz - uz * vy;
      ny = uz * vx - ux * vz;
      nz = ux * vy - uy * vx;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      nx /= nlen; ny /= nlen; nz /= nlen;
    } else {
      ny = 1;
    }

    // 두께 — 도어 대각선의 약 3%. 멀리서도 확실히 보이도록.
    const diag = Math.hypot(
      corners[Math.min(2, N - 1)][0] - corners[0][0],
      corners[Math.min(2, N - 1)][1] - corners[0][1],
      corners[Math.min(2, N - 1)][2] - corners[0][2],
    );
    const thickness = thicknessOverride ?? Math.max(0.04, Math.min(0.1, diag * 0.03));
    const half = thickness * 0.5;

    const positions: number[] = [];
    const indices: number[] = [];
    let vi = 0;
    for (let i = 0; i < N; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % N];
      // edge 방향 단위벡터.
      let ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
      const elen = Math.hypot(ex, ey, ez) || 1;
      ex /= elen; ey /= elen; ez /= elen;
      // edge 와 normal 둘 다 직교하는 두께 방향 (평면 안쪽 perpendicular).
      let tx = ny * ez - nz * ey;
      let ty = nz * ex - nx * ez;
      let tz = nx * ey - ny * ex;
      const tlen = Math.hypot(tx, ty, tz) || 1;
      tx /= tlen; ty /= tlen; tz /= tlen;

      // quad 4 vertices: a±half·t, b±half·t.
      const a1 = [a[0] - tx * half, a[1] - ty * half, a[2] - tz * half];
      const a2 = [a[0] + tx * half, a[1] + ty * half, a[2] + tz * half];
      const b1 = [b[0] - tx * half, b[1] - ty * half, b[2] - tz * half];
      const b2 = [b[0] + tx * half, b[1] + ty * half, b[2] + tz * half];

      positions.push(a1[0], a1[1], a1[2]);
      positions.push(a2[0], a2[1], a2[2]);
      positions.push(b2[0], b2[1], b2[2]);
      positions.push(b1[0], b1[1], b1[2]);
      // 두 삼각형 — 양면 보이게 위해 normal/cull off 처리는 material 에서.
      indices.push(vi, vi + 1, vi + 2);
      indices.push(vi, vi + 2, vi + 3);
      vi += 4;
    }
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(positions);
    mesh.setIndices(indices);
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    return mesh;
  };

  // 광원 없는 씬 → emissive 채널만 색으로 보임 (구 BasicMaterial 대체 관용구).
  const makeMaterial = (color: [number, number, number, number]): any => {
    const m = new pc.StandardMaterial();
    m.emissive = new pc.Color(color[0], color[1], color[2]);
    m.useLighting = false;
    m.opacity = color[3];
    if (color[3] < 1) m.blendType = pc.BLEND_NORMAL;
    m.depthWrite = color[3] >= 0.95;  // 코어만 depth write — halo 는 위에 부드럽게 덮음.
    m.cull = pc.CULLFACE_NONE;
    m.update();
    return m;
  };

  // halo — additive 블렌드로 겹쳐 더 밝아져 glow 느낌.
  const makeHaloMaterial = (color: [number, number, number, number]): any => {
    const m = new pc.StandardMaterial();
    m.emissive = new pc.Color(color[0], color[1], color[2]);
    m.useLighting = false;
    m.opacity = color[3];
    m.blendType = pc.BLEND_ADDITIVEALPHA;
    m.depthWrite = false;
    m.cull = pc.CULLFACE_NONE;
    m.update();
    return m;
  };

  // halo (외부 glow 효과) — opacity 낮은 mesh. core 위에 그려 약한 빛 효과.
  // PlayCanvas BasicMaterial 은 line 두께 직접 조절 못 함 (대부분 1px 고정).
  // 대신 halo 한 줄을 추가로 그려서 색 강조 — 진정한 glow 는 post-process 필요 (스코프 외).
  // 코어 두께 — 도어 대각선 기반.
  const computeCoreThickness = (corners: Vec3[]): number => {
    const N = corners.length;
    const diag = Math.hypot(
      corners[Math.min(2, N - 1)][0] - corners[0][0],
      corners[Math.min(2, N - 1)][1] - corners[0][1],
      corners[Math.min(2, N - 1)][2] - corners[0][2],
    );
    return Math.max(0.04, Math.min(0.1, diag * 0.03));
  };

  const updateOutline = () => {
    if (cornersRef.length < 2) return;
    const coreT = computeCoreThickness(cornersRef);
    const coreMesh = buildLineMesh(cornersRef, coreT);
    const haloInnerMesh = buildLineMesh(cornersRef, coreT * HALO_INNER_SCALE);
    const haloOuterMesh = buildLineMesh(cornersRef, coreT * HALO_OUTER_SCALE);
    if (!coreMesh || !haloInnerMesh || !haloOuterMesh) return;

    outlineEnt.removeComponent('render');
    const miOuter = new pc.MeshInstance(haloOuterMesh, makeHaloMaterial(OUTLINE_COLOR_HALO_OUTER));
    const miInner = new pc.MeshInstance(haloInnerMesh, makeHaloMaterial(OUTLINE_COLOR_HALO_INNER));
    const miCore = new pc.MeshInstance(coreMesh, makeMaterial(OUTLINE_COLOR_CORE));
    outlineEnt.addComponent('render', { meshInstances: [miOuter, miInner, miCore] });
  };
  updateOutline();

  // 라벨 — PlayCanvas text 는 fontAsset 필요한데 폰트 인프라가 없으면 복잡.
  // 대안: 작은 sphere/dot 같은 placeholder. 또는 builtin font 시도.
  // 일단 라벨 entity 는 null 로 두고 (별도 작업), 외부 HTML overlay 도입 검토.
  let labelEntity: any | null = null;

  // Z-180 회전 부여 (additional splat / wall mesh 와 동일 시각 컨벤션).
  if (opts.rotation) {
    root.setLocalRotation(opts.rotation[0], opts.rotation[1], opts.rotation[2], opts.rotation[3]);
  } else {
    root.setLocalEulerAngles(0, 0, 180);
  }

  app.root.addChild(root);

  return {
    outlineEntity: root,
    labelEntity,
    setUnitName(_name: string | null): void {
      // PlayCanvas text mesh 라벨이 구현되면 여기서 업데이트.
      // 현재는 HTML overlay 사용 (호출자가 별도 React state 로 위치 계산).
    },
    setCorners(corners: Vec3[]): void {
      cornersRef = corners.slice() as Vec3[];
      updateOutline();
    },
    destroy(): void {
      try { root.destroy(); } catch {}
    },
  };
}

/**
 * 4 corners 중심 좌표 (A'+Y 프레임). 라벨 위치 등에 사용.
 */
export function doorCenter(corners: Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const c of corners) { x += c[0]; y += c[1]; z += c[2]; }
  const n = corners.length || 1;
  return [x / n, y / n, z / n];
}
