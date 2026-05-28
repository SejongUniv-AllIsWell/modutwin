/**
 * 도어 시각화 helper — 노란 outline.
 *
 * basemap 등록 중 추출된 도어를 뷰어에 표시. 4 corners 를 잇는 단순 line strip.
 *
 * 사용:
 *   const handle = createDoorOutlineEntity(pc, app, {
 *     corners: [[x,y,z], ...],   // 4 corners (A'+Y 프레임)
 *     unitName: '601호' | null,  // 표시용 메타 — 라벨 렌더링은 HTML overlay (useDoorLabels) 가 담당.
 *   });
 *   handle.setCorners(newCorners);
 *   handle.destroy();
 */

export type Vec3 = [number, number, number];

export interface DoorOutlineHandle {
  outlineEntity: any;
  labelEntity: any | null;
  setUnitName(name: string | null): void;
  setCorners(corners: Vec3[]): void;
  destroy(): void;
}

const OUTLINE_COLOR: [number, number, number] = [1.0, 0.92, 0.25]; // #FFEB40

export function createDoorOutlineEntity(
  pc: any,
  app: any,
  opts: {
    corners: Vec3[];
    unitName: string | null;
    rotation?: [number, number, number, number]; // local quaternion. 미지정 시 Z-180.
  },
): DoorOutlineHandle {
  const root = new pc.Entity('doorOutlineRoot');
  const outlineEnt = new pc.Entity('doorOutline');
  root.addChild(outlineEnt);

  let cornersRef: Vec3[] = opts.corners.slice() as Vec3[];

  // 광원 없는 씬 → emissive 만 보임.
  const material = new pc.StandardMaterial();
  material.emissive = new pc.Color(OUTLINE_COLOR[0], OUTLINE_COLOR[1], OUTLINE_COLOR[2]);
  material.useLighting = false;
  material.cull = pc.CULLFACE_NONE;
  material.update();

  // corners 를 잇는 닫힌 line strip mesh (pc.PRIMITIVE_LINES).
  // 각 edge 마다 두 vertex (line list) — corners[i] → corners[(i+1) % N].
  const buildLineMesh = (corners: Vec3[]): any | null => {
    const N = corners.length;
    if (N < 2) return null;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % N];
      const base = i * 2;
      positions.push(a[0], a[1], a[2]);
      positions.push(b[0], b[1], b[2]);
      indices.push(base, base + 1);
    }
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(positions);
    mesh.setIndices(indices);
    mesh.update(pc.PRIMITIVE_LINES);
    return mesh;
  };

  const rebuild = () => {
    const mesh = buildLineMesh(cornersRef);
    if (!mesh) return;
    outlineEnt.removeComponent('render');
    outlineEnt.addComponent('render', {
      meshInstances: [new pc.MeshInstance(mesh, material)],
    });
  };
  rebuild();

  // entity 회전 — splat / wall mesh 와 같은 viewer 컨벤션.
  if (opts.rotation) {
    root.setLocalRotation(opts.rotation[0], opts.rotation[1], opts.rotation[2], opts.rotation[3]);
  } else {
    root.setLocalEulerAngles(0, 0, 180);
  }

  app.root.addChild(root);

  return {
    outlineEntity: root,
    labelEntity: null,
    setUnitName(_name: string | null): void {
      // 라벨은 HTML overlay (useDoorLabels) 가 담당.
    },
    setCorners(corners: Vec3[]): void {
      cornersRef = corners.slice() as Vec3[];
      rebuild();
    },
    destroy(): void {
      try { root.destroy(); } catch {}
    },
  };
}

/** 4 corners 중심 — 라벨 overlay 위치 계산용. */
export function doorCenter(corners: Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (const c of corners) { x += c[0]; y += c[1]; z += c[2]; }
  const n = corners.length || 1;
  return [x / n, y / n, z / n];
}
