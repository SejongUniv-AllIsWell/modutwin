'use client';

import { useRef, useState, useCallback, useEffect, RefObject, lazy, Suspense } from 'react';
import { SplatData, SplatViewerCoreRef } from '../SplatViewerCore';
import { useDepthNormal } from './useDepthNormal';
import { surfacePlanesFromRoom, signedDistance } from '@/lib/gs/planes';
import { loadRefineState, saveRefineState, clearRefineState } from '@/lib/refine/persistence';
import type { GaussianScene } from '@/lib/ply/types';

const UNDO_STACK_LIMIT = 3;

const CeilingFloorModal = lazy(() => import('./CeilingFloorModal'));
const WallModal = lazy(() => import('./WallModal'));

// ── Types ──

type Vec3 = [number, number, number];
type Color4 = [number, number, number, number];

interface Plane {
  normal: Vec3;
  d: number;
  center: Vec3;
}

type ToolMode = 'none' | 'translate' | 'rotate';
type RefineMode = 'plane' | 'brush' | 'bbox';
type PaintMode = 'union' | 'diff';

// ── Vector utilities ──

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize3(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len < 1e-8) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function add3(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale3(v: Vec3, s: number): Vec3 { return [v[0] * s, v[1] * s, v[2] * s]; }
function tangentBasis(n: Vec3): [Vec3, Vec3] {
  const up: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t1 = normalize3(cross3(n, up));
  const t2 = cross3(n, t1);
  return [t1, t2];
}
function rotateVec(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const d = dot3(v, axis);
  const cr = cross3(axis, v);
  return [v[0]*c+cr[0]*s+axis[0]*d*(1-c), v[1]*c+cr[1]*s+axis[1]*d*(1-c), v[2]*c+cr[2]*s+axis[2]*d*(1-c)];
}
function planeCorners(center: Vec3, normal: Vec3, size: number): Vec3[] {
  const [t1, t2] = tangentBasis(normal);
  return [
    add3(add3(center, scale3(t1, -size)), scale3(t2, -size)),
    add3(add3(center, scale3(t1, size)), scale3(t2, -size)),
    add3(add3(center, scale3(t1, size)), scale3(t2, size)),
    add3(add3(center, scale3(t1, -size)), scale3(t2, size)),
  ];
}

// ── PCA normal computation ──

function symmetricEigen3x3(mat: number[][]): { values: number[]; vectors: number[][] } {
  const a = mat.map(r => [...r]);
  const v = [[1,0,0],[0,1,0],[0,0,1]];
  for (let iter = 0; iter < 30; iter++) {
    let maxVal = 0, p = 0, q = 1;
    for (let i = 0; i < 3; i++) for (let j = i+1; j < 3; j++) {
      if (Math.abs(a[i][j]) > maxVal) { maxVal = Math.abs(a[i][j]); p = i; q = j; }
    }
    if (maxVal < 1e-12) break;
    const apq = a[p][q];
    const diff = a[p][p] - a[q][q];
    let t: number;
    if (Math.abs(diff) < 1e-12) t = apq > 0 ? 1 : -1;
    else { const phi = diff / (2 * apq); t = 1 / (Math.abs(phi) + Math.sqrt(phi*phi+1)); if (phi < 0) t = -t; }
    const c = 1 / Math.sqrt(t*t+1), s = t*c, tau = s/(1+c);
    a[p][p] -= t * apq; a[q][q] += t * apq; a[p][q] = 0; a[q][p] = 0;
    for (let r = 0; r < 3; r++) {
      if (r === p || r === q) continue;
      const arp = a[r][p], arq = a[r][q];
      a[r][p] = a[p][r] = arp - s*(arq + tau*arp);
      a[r][q] = a[q][r] = arq + s*(arp - tau*arq);
    }
    for (let r = 0; r < 3; r++) {
      const vrp = v[r][p], vrq = v[r][q];
      v[r][p] = vrp - s*(vrq + tau*vrp);
      v[r][q] = vrq + s*(vrp - tau*vrq);
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}

function pcaNormal(positions: Vec3[]): Vec3 {
  const n = positions.length;
  const mean: Vec3 = [0, 0, 0];
  for (const p of positions) { mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
  mean[0] /= n; mean[1] /= n; mean[2] /= n;
  const cov = [[0,0,0],[0,0,0],[0,0,0]];
  for (const p of positions) {
    const d = [p[0]-mean[0], p[1]-mean[1], p[2]-mean[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i]*d[j];
  }
  const { values, vectors } = symmetricEigen3x3(cov);
  const minIdx = values[0] <= values[1] && values[0] <= values[2] ? 0 : values[1] <= values[2] ? 1 : 2;
  return normalize3([vectors[0][minIdx], vectors[1][minIdx], vectors[2][minIdx]]);
}

// ── Space partitioning ──

function computeCellCodes(posX: Float32Array, posY: Float32Array, posZ: Float32Array, n: number, planes: Plane[]): Uint32Array {
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let code = 0;
    for (let p = 0; p < planes.length; p++) {
      const { normal, d } = planes[p];
      if (normal[0]*posX[i]+normal[1]*posY[i]+normal[2]*posZ[i] > d) code |= (1 << p);
    }
    codes[i] = code;
  }
  return codes;
}
function findKeepCell(codes: Uint32Array): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < codes.length; i++) counts.set(codes[i], (counts.get(codes[i]) ?? 0) + 1);
  let best = 0, bestC = 0;
  counts.forEach((c, k) => { if (c > bestC) { bestC = c; best = k; } });
  return best;
}
function isClosed(keepCell: number, numPlanes: number): boolean { return numPlanes >= 4 && keepCell === 0; }

// ── Gizmo constants ──

const WORLD_AXES: Vec3[] = [[1,0,0],[0,1,0],[0,0,1]];
const AXIS_COLORS: Color4[] = [[1,0.3,0.3,1],[0.3,1,0.3,1],[0.4,0.6,1,1]];
const AXIS_COLORS_DIM: Color4[] = [[0.5,0.15,0.15,0.5],[0.15,0.5,0.15,0.5],[0.2,0.3,0.5,0.5]];
const RING_SEGMENTS = 48;
const RING_PICK_PX = 18;

// ── Hook ──

interface RefineToolOptions {
  uploadId?: string;
  reloadWithUrl?: (url: string) => void;
  currentUrl?: string;
  /**
   * uploadId가 없을 때 (로컬 파일 다듬기) 호출되는 외부 업로드 핸들러.
   * 베이크된 PLY 바이트를 받아서 자유롭게 처리(메타데이터 모달 → /uploads/init+complete 등).
   * 성공 시 resolve, 실패 시 reject. resolve되면 setSaved(true) 처리됨.
   */
  onRequestUpload?: (bytes: Uint8Array, filename: string) => Promise<void>;
}

export function useRefineTool(coreRef: RefObject<SplatViewerCoreRef | null>, options?: RefineToolOptions) {
  // ── Shared state ──
  const [splatLoaded, setSplatLoaded] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [refineMode, setRefineMode] = useState<RefineMode>('plane');
  const refineModeRef = useRef<RefineMode>('plane');
  const splatDataRef = useRef<SplatData | null>(null);
  const pristineRef = useRef<Uint16Array | null>(null);
  const pcRef = useRef<any>(null);
  const bboxCenterRef = useRef<Vec3>([0,0,0]);
  const bboxSizeRef = useRef<number>(1);

  // ── Plane state ──
  const [planes, setPlanes] = useState<Plane[]>([]);
  const [selectedPlane, setSelectedPlane] = useState<number>(-1);
  const [outsideCount, setOutsideCount] = useState(0);
  const [closed, setClosed] = useState(false);
  const [toolMode, setToolMode] = useState<ToolMode>('none');
  const planesRef = useRef<Plane[]>([]);
  const selectedPlaneRef = useRef<number>(-1);
  const cellCodesRef = useRef<Uint32Array | null>(null);
  const keepCellRef = useRef<number>(0);
  const toolModeRef = useRef<ToolMode>('none');
  const hoveredAxisRef = useRef<number>(-1);
  const dragRef = useRef<any>(null);
  const [pickingNormal, setPickingNormal] = useState(false);
  const pickingNormalRef = useRef(false);
  const normalDisplayRef = useRef<{ point: Vec3; normal: Vec3 } | null>(null);
  const [depthLoading, setDepthLoading] = useState(false);
  const { computeDepthMap, getNormalAt, isLoading: isDepthLoading, hasDepth, clearDepth } = useDepthNormal();

  // ── Ceiling/Floor state ──
  const [cfModalOpen, setCfModalOpen] = useState(false);
  const [cfMode, setCfMode] = useState<'none' | 'confirmed'>('none');
  const [ceilingY, setCeilingY] = useState(0);
  const [floorY, setFloorY] = useState(0);
  const ceilingYRef = useRef(0);
  const floorYRef = useRef(0);
  const cfModeRef = useRef<'none' | 'confirmed'>('none');

  // ── Wall state ──
  const [wallModalOpen, setWallModalOpen] = useState(false);
  const [wallMode, setWallMode] = useState<'none' | 'confirmed'>('none');
  const [wallAngle, setWallAngle] = useState<number | null>(null);
  const [wallDistances, setWallDistances] = useState<[number, number, number, number] | null>(null);
  const wallAngleRef = useRef<number | null>(null);
  const wallDistancesRef = useRef<[number, number, number, number] | null>(null);
  const wallModeRef = useRef<'none' | 'confirmed'>('none');
  const selectedSurfacesRef = useRef<Set<string>>(new Set());

  // ── Surface selection for flatten/remove ──
  const ALL_SURFACES = ['ceiling', 'floor', 'w1a', 'w1b', 'w2a', 'w2b'] as const;
  type Surface = typeof ALL_SURFACES[number];
  const CF_SURFACES: Surface[] = ['ceiling', 'floor'];
  const WALL_SURFACES: Surface[] = ['w1a', 'w1b', 'w2a', 'w2b'];
  const [selectedSurfaces, setSelectedSurfaces] = useState<Set<Surface>>(new Set());
  const [flattening, setFlattening] = useState(false);
  const [membraneApplying, setMembraneApplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [surfaceOffsets, setSurfaceOffsets] = useState<Record<Surface, number>>({
    ceiling: 0.3, floor: 0.3, w1a: 0.3, w1b: 0.3, w2a: 0.3, w2b: 0.3,
  });
  // 입력 중 임시 문자열 — 빈칸·'-'·'0.' 같은 중간 상태를 허용해 삭제/편집이 가능하게
  const [offsetText, setOffsetText] = useState<Record<Surface, string>>({
    ceiling: '0.3', floor: '0.3', w1a: '0.3', w1b: '0.3', w2a: '0.3', w2b: '0.3',
  });

  // 막 파라미터 (슬라이더)
  const [membraneSpacing, setMembraneSpacing] = useState(0.04);   // 격자 간격 (작을수록 패치 많음)
  const [membraneRadius, setMembraneRadius] = useState(0.08);     // 패치 반경
  const [membraneOpacity, setMembraneOpacity] = useState(0.25);   // 선형 불투명도 0~1

  const toggleSurface = (s: Surface) => {
    // Don't allow toggling disabled surfaces
    if (CF_SURFACES.includes(s) && cfMode !== 'confirmed') return;
    if (WALL_SURFACES.includes(s) && wallMode !== 'confirmed') return;
    setSelectedSurfaces(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  };
  const toggleAllSurfaces = () => {
    const available: Surface[] = [
      ...(cfMode === 'confirmed' ? CF_SURFACES : []),
      ...(wallMode === 'confirmed' ? WALL_SURFACES : []),
    ];
    setSelectedSurfaces(prev => prev.size === available.length ? new Set() : new Set(available));
  };

  // ── 정제 파이프라인 state (lazy-bake 모델) ──
  // 사용자가 "정제 결과 저장"을 누를 때까지 PLY/GPU 데이터는 일절 mutate하지 않는다.
  // 모든 작업은 "의도(intent)"로만 메모리에 보관되고 시각 미리보기는 GPU side로만 처리.

  // 원본 PLY 파싱본 캐시 (A 좌표계, 불변). 첫 정제 작업 또는 저장 시 lazy 파싱.
  const originalSceneRef = useRef<GaussianScene | null>(null);

  // 누적 회전 (rotX, rotZ) 라디안. CF 모달이 누적 입력. 옵션 A: 막 생성 후 lock.
  const pendingRotationRef = useRef<{ rotX: number; rotZ: number }>({ rotX: 0, rotZ: 0 });
  const [pendingRotation, setPendingRotation] = useState<{ rotX: number; rotZ: number }>({ rotX: 0, rotZ: 0 });

  // flatten 마스크: 1=삭제(현재 회전된 프레임 기준 평면 외부). null=아직 적용 안 됨.
  const flattenMaskRef = useRef<Uint8Array | null>(null);
  const [flattenActive, setFlattenActive] = useState(false);
  const flattenActiveRef = useRef(false);
  const [flattenVisible, setFlattenVisible] = useState(true);
  const flattenVisibleRef = useRef(true);

  // 막: 별도 PlayCanvas gsplat 엔티티로 띄움. 진짜 토글 (reload 없음).
  // 두 gsplat 엔티티가 나란히 있을 때 카메라 각도 변화로 알파 블렌드 순서가 흔들리는
  // 문제는 별도 Layer를 메인 World 앞에 삽입해 강제 순서로 회피.
  const membraneSceneRef = useRef<GaussianScene | null>(null);
  const membraneEntityRef = useRef<any>(null);
  const membraneAssetRef = useRef<any>(null);
  const membraneBlobUrlRef = useRef<string | null>(null);
  const membraneLayerRef = useRef<any>(null);
  const [membraneActive, setMembraneActive] = useState(false);
  const membraneActiveRef = useRef(false);

  // 옵션 A: 막 생성 후 CF 모달의 회전 슬라이더 lock
  const [cfRotationLocked, setCfRotationLocked] = useState(false);
  const cfRotationLockedRef = useRef(false);

  // 통합 undo 히스토리 (시간순 단일 스택)
  type OpRecord =
    | { type: 'rotation'; prevRotation: { rotX: number; rotZ: number } }
    | { type: 'flatten'; prevMask: Uint8Array | null; prevActive: boolean }
    | { type: 'membrane'; prevScene: GaussianScene | null; prevActive: boolean; prevLocked: boolean };
  const opHistoryRef = useRef<OpRecord[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);

  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const restoringRef = useRef(false);

  const pushOp = useCallback((rec: OpRecord) => {
    opHistoryRef.current.push(rec);
    if (opHistoryRef.current.length > UNDO_STACK_LIMIT) opHistoryRef.current.shift();
    setUndoDepth(opHistoryRef.current.length);
  }, []);

  // ── PLY 베이스 회전(180Z) + pendingRotation을 splatEntity transform에 적용 ──
  const applyEntityRotation = useCallback(() => {
    const data = splatDataRef.current;
    const pc = coreRef.current?.getPC();
    if (!data?.splatEntity || !pc) return;
    const { rotX, rotZ } = pendingRotationRef.current;

    // pendingRotation이 0이면 SplatViewerCore의 초기 설정과 정확히 동일한 API 사용 (회귀 방지)
    if (rotX === 0 && rotZ === 0) {
      data.splatEntity.setLocalEulerAngles(0, 0, 180);
      return;
    }

    const rotXdeg = rotX * 180 / Math.PI;
    const rotZdeg = rotZ * 180 / Math.PI;
    // 180Z(베이스) ∘ Rz(rotZ) ∘ Rx(rotX)  — rotateScene과 동일 합성 (Rz·Rx · A)
    const qx = new pc.Quat(); qx.setFromAxisAngle(new pc.Vec3(1, 0, 0), rotXdeg);
    const qz = new pc.Quat(); qz.setFromAxisAngle(new pc.Vec3(0, 0, 1), rotZdeg);
    const qBase = new pc.Quat(); qBase.setFromAxisAngle(new pc.Vec3(0, 0, 1), 180);
    const qPending = new pc.Quat(); qPending.mul2(qz, qx);
    const qTotal = new pc.Quat(); qTotal.mul2(qBase, qPending);
    data.splatEntity.setLocalRotation(qTotal);
  }, []);

  // ── flatten 마스크를 colorTexture에 페인트 ──
  // origColorData(브러시 삭제 누적)를 베이스로, 마스크된 곳만 alpha=0.
  // showFlatten=false면 마스크 무시하고 origColorData 그대로 복원.
  const paintFlattenMask = useCallback(() => {
    const data = splatDataRef.current;
    const core = coreRef.current;
    if (!data || !core || !data.colorTexture || !data.origColorData) return;
    const f2h = core.float2Half;
    const td = data.colorTexture.lock();
    if (!td) return;
    const mask = flattenMaskRef.current;
    const showFlatten = flattenActiveRef.current && flattenVisibleRef.current;
    for (let i = 0; i < data.numSplats; i++) {
      const idx = i * 4;
      td[idx]   = data.origColorData[idx];
      td[idx+1] = data.origColorData[idx+1];
      td[idx+2] = data.origColorData[idx+2];
      if (showFlatten && mask && mask[i]) {
        td[idx+3] = f2h(0);
      } else {
        td[idx+3] = data.origColorData[idx+3];
      }
    }
    data.colorTexture.unlock();
  }, [coreRef]);

  // ── 원본 GaussianScene 보장 (lazy 파싱, 캐시) ──
  const ensureOriginalScene = useCallback(async (): Promise<GaussianScene> => {
    if (originalSceneRef.current) return originalSceneRef.current;
    if (!options?.currentUrl) throw new Error('currentUrl 없음');
    const { fetchAndParsePly } = await import('@/lib/ply');
    const scene = await fetchAndParsePly(options.currentUrl);
    originalSceneRef.current = scene;
    return scene;
  }, [options]);

  // ── 회전된 source scene 빌드 (A → A' = pendingRotation · A) ──
  // 주의: posX/Y/Z + rot_0..3 만 새 배열, 나머지는 reference 공유 (메모리 절약)
  const buildRotatedScene = useCallback(async (origin: GaussianScene): Promise<GaussianScene> => {
    const { rotX, rotZ } = pendingRotationRef.current;
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
  }, []);

  // ── splatData 위치 배열을 pendingRotation으로 회전한 사본 (in-place 마스킹용) ──
  const buildRotatedPositions = useCallback((px: Float32Array, py: Float32Array, pz: Float32Array): { x: Float32Array; y: Float32Array; z: Float32Array } => {
    const { rotX, rotZ } = pendingRotationRef.current;
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
  }, []);

  // 막 엔티티 cleanup
  const removeMembraneEntity = useCallback(() => {
    const app = coreRef.current?.getApp();
    if (membraneEntityRef.current) {
      try { membraneEntityRef.current.destroy(); } catch { /* ignore */ }
      membraneEntityRef.current = null;
    }
    if (membraneAssetRef.current && app) {
      try { app.assets.remove(membraneAssetRef.current); } catch { /* ignore */ }
      membraneAssetRef.current = null;
    }
    if (membraneBlobUrlRef.current) {
      URL.revokeObjectURL(membraneBlobUrlRef.current);
      membraneBlobUrlRef.current = null;
    }
  }, [coreRef]);

  // ── 막 전용 Layer 보장 (메인 World layer보다 먼저 렌더되도록) ──
  // PlayCanvas가 두 transparent gsplat을 sortMode_BACK2FRONT로 혼합하면 각도 따라
  // 순서가 흔들리는데, 별도 layer를 World 앞에 두면 강제로 막 → 메인 순서가 됨.
  const ensureMembraneLayer = useCallback(() => {
    const pc = coreRef.current?.getPC();
    const app = coreRef.current?.getApp();
    const cam = coreRef.current?.getCamera();
    if (!pc || !app || !cam) return null;
    if (membraneLayerRef.current) return membraneLayerRef.current;

    const existing = app.scene.layers.getLayerByName('MembranePre');
    if (existing) {
      membraneLayerRef.current = existing;
      return existing;
    }
    const layer = new pc.Layer({
      name: 'MembranePre',
      opaqueSortMode: pc.SORTMODE_NONE,
      transparentSortMode: pc.SORTMODE_BACK2FRONT,
    });
    // World layer 뒤에 삽입 → 막이 메인보다 나중에 렌더 → 막이 메인 위에 보임
    const layerList = app.scene.layers.layerList;
    const worldIdx = layerList.findIndex((l: any) => l.name === 'World');
    if (worldIdx >= 0) {
      app.scene.layers.insert(layer, worldIdx + 1);
    } else {
      app.scene.layers.push(layer);
    }
    // 카메라가 이 layer를 렌더하도록 추가
    if (cam.camera && Array.isArray(cam.camera.layers) && !cam.camera.layers.includes(layer.id)) {
      cam.camera.layers = [...cam.camera.layers, layer.id];
    }
    membraneLayerRef.current = layer;
    return layer;
  }, [coreRef]);

  // ── 막 GaussianScene을 별도 PlayCanvas gsplat 엔티티로 로드 ──
  const loadMembraneEntity = useCallback(async (scene: GaussianScene): Promise<void> => {
    const core = coreRef.current;
    const pc = core?.getPC();
    const app = core?.getApp();
    if (!core || !pc || !app) throw new Error('PlayCanvas not ready');

    removeMembraneEntity();
    const layer = ensureMembraneLayer();

    const { serializePly } = await import('@/lib/ply');
    const bytes = serializePly(scene);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    membraneBlobUrlRef.current = url;

    const asset = new pc.Asset('membrane', 'gsplat', { url: url + '#membrane.ply' });
    app.assets.add(asset);
    membraneAssetRef.current = asset;

    await new Promise<void>((resolve, reject) => {
      asset.once('error', (err: any) => reject(new Error(`membrane asset load failed: ${err?.message ?? err}`)));
      asset.ready(() => resolve());
      app.assets.load(asset);
    });

    const entity = new pc.Entity('membrane');
    // 막 stored 위치 = A' (pendingRotation 적용된 프레임)
    entity.setLocalEulerAngles(0, 0, 180);
    entity.addComponent('gsplat', { asset });
    // 막 전용 layer 지정 (메인 World 보다 먼저 렌더)
    if (layer && entity.gsplat) {
      try { entity.gsplat.layers = [layer.id]; } catch { /* API 미존재 시 무시 */ }
    }
    app.root.addChild(entity);
    membraneEntityRef.current = entity;
  }, [coreRef, removeMembraneEntity, ensureMembraneLayer]);

  // 언마운트 시 막 cleanup
  useEffect(() => {
    return () => {
      removeMembraneEntity();
    };
  }, [removeMembraneEntity]);

  // ── applyFlatten: 토글식 — 비활성 → 마스크 계산 + 활성. 활성 → 비활성(복원). ──
  // 저장 시 활성 상태일 때만 마스크가 베이크에 반영됨.
  const applyFlatten = useCallback(async () => {
    // 이미 활성 → 복원 (비활성화 + 시각 복원)
    if (flattenActiveRef.current) {
      pushOp({
        type: 'flatten',
        prevMask: flattenMaskRef.current ? new Uint8Array(flattenMaskRef.current) : null,
        prevActive: true,
      });
      flattenActiveRef.current = false; setFlattenActive(false);
      paintFlattenMask();
      // 마스크 자체는 보관해 둘 수도 있지만, 다음 클릭에서 어차피 재계산하므로 비움 → 의도 명확화
      flattenMaskRef.current = null;
      // dirty/op 히스토리는 그대로. 토글 자체도 히스토리에 남음.
      setSaved(false);
      const stillDirty = opHistoryRef.current.length > 0
        || pendingRotationRef.current.rotX !== 0
        || pendingRotationRef.current.rotZ !== 0
        || flattenActiveRef.current
        || membraneActiveRef.current;
      dirtyRef.current = stillDirty; setDirty(stillDirty);
      return;
    }

    // 비활성 → 마스크 계산 + 활성
    if (selectedSurfaces.size === 0) { alert('경계면을 하나 이상 선택하세요.'); return; }
    const hasWall = Array.from(selectedSurfaces).some(s => WALL_SURFACES.includes(s));
    if (hasWall && (wallAngleRef.current === null || !wallDistancesRef.current)) return;

    const data = splatDataRef.current;
    if (!data) return;

    setFlattening(true);
    try {
      const { surfacePlanesFromRoom, signedDistance } = await import('@/lib/gs/planes');

      const allPlanes = surfacePlanesFromRoom({
        angleDeg: wallAngleRef.current ?? 0,
        walls: wallDistancesRef.current ?? [0, 0, 0, 0] as [number, number, number, number],
        ceilingY: ceilingYRef.current,
        floorY: floorYRef.current,
      });
      const planes = allPlanes.filter(p => selectedSurfaces.has(p.id as Surface));
      const marginOut = Math.max(...Array.from(selectedSurfaces).map(s => surfaceOffsets[s]));
      const nearProtect = 0.03;  // DEFAULT_SHELL_OPTIONS.nearProtect

      // splatData posX/Y/Z (A 프레임)을 회전 → A' 프레임. 이 프레임에서 평면과 비교.
      const rotPos = buildRotatedPositions(data.posX, data.posY, data.posZ);

      const N = data.numSplats;
      const newMask = new Uint8Array(N);
      let deletedCount = 0;
      const killByPlane: Record<string, number> = {};
      for (const p of planes) killByPlane[p.id] = 0;
      for (let i = 0; i < N; i++) {
        const x = rotPos.x[i], y = rotPos.y[i], z = rotPos.z[i];
        let outside = false;
        for (const p of planes) {
          const sd = signedDistance(p, x, y, z);
          if (sd > nearProtect && sd > marginOut) {
            outside = true;
            killByPlane[p.id]++;
            break;
          }
        }
        if (outside) { newMask[i] = 1; deletedCount++; }
      }
      console.log(`[Shell] flatten mask: ${deletedCount} / ${N} gaussians`);
      console.log('[Shell] kill-by-plane:', killByPlane);
      console.log('[Shell] plane defs:', planes.map(p => ({ id: p.id, n: p.normal, d: p.d })));
      console.log('[Shell] params:', { ceilingY: ceilingYRef.current, floorY: floorYRef.current, wallAngle: wallAngleRef.current, wallDistances: wallDistancesRef.current, marginOut, nearProtect, pendingRot: pendingRotationRef.current });

      // undo 기록 (이전 상태 = 비활성 + 마스크 없음)
      pushOp({ type: 'flatten', prevMask: null, prevActive: false });

      flattenMaskRef.current = newMask;
      flattenActiveRef.current = true; setFlattenActive(true);
      flattenVisibleRef.current = true; setFlattenVisible(true);
      paintFlattenMask();
      dirtyRef.current = true; setDirty(true);
      setSaved(false);
    } catch (e: any) {
      alert(`처리 실패: ${e.message || e}`);
    } finally {
      setFlattening(false);
    }
  }, [selectedSurfaces, surfaceOffsets, buildRotatedPositions, paintFlattenMask, pushOp]);

  // ── applyMembrane: 진짜 토글 (reload 없음). flatten/회전 의도 보존. ──
  // 두 gsplat 엔티티 정렬 흔들림 문제는 별도 Layer를 World 앞에 두어 회피.
  const applyMembrane = useCallback(async () => {
    // 이미 활성 → 막 엔티티만 제거. flatten/회전 의도는 그대로 유지.
    if (membraneActiveRef.current) {
      removeMembraneEntity();
      membraneSceneRef.current = null;
      membraneActiveRef.current = false; setMembraneActive(false);
      cfRotationLockedRef.current = false; setCfRotationLocked(false);
      setSaved(false);
      const stillDirty = opHistoryRef.current.length > 0
        || pendingRotationRef.current.rotX !== 0
        || pendingRotationRef.current.rotZ !== 0
        || flattenActiveRef.current;
      dirtyRef.current = stillDirty; setDirty(stillDirty);
      return;
    }

    // 비활성 → 막 생성
    if (selectedSurfaces.size === 0) { alert('경계면을 하나 이상 선택하세요.'); return; }
    const hasWall = Array.from(selectedSurfaces).some(s => WALL_SURFACES.includes(s));
    const hasCF = Array.from(selectedSurfaces).some(s => CF_SURFACES.includes(s));
    if (hasWall && (wallAngleRef.current === null || !wallDistancesRef.current)) return;
    if (hasCF && cfModeRef.current !== 'confirmed') return;

    setMembraneApplying(true);
    try {
      const { generateMembrane } = await import('@/lib/gs');
      const { filterScene } = await import('@/lib/ply');

      // KNN source: 회전된 + flatten 적용된 씬 (브러시는 splatData origColorData 기반이라 별도 처리)
      const original = await ensureOriginalScene();
      const rotated = await buildRotatedScene(original);
      let knnSource = rotated;
      if (flattenActiveRef.current && flattenMaskRef.current) {
        const keep = new Uint8Array(rotated.numSplats);
        for (let i = 0; i < keep.length; i++) keep[i] = flattenMaskRef.current[i] ? 0 : 1;
        knnSource = filterScene(rotated, keep);
      }

      const roomGeom = {
        angleDeg: wallAngleRef.current ?? 0,
        walls: wallDistancesRef.current ?? [0, 0, 0, 0] as [number, number, number, number],
        ceilingY: ceilingYRef.current,
        floorY: floorYRef.current,
      };

      console.log(`[Membrane] slider opacity=${membraneOpacity}`);

      const membrane = await generateMembrane(
        knnSource.propertyOrder,
        Array.from(selectedSurfaces),
        roomGeom,
        surfaceOffsets,
        knnSource,
        {
          gridSpacing: membraneSpacing,
          patchRadius: membraneRadius,
          patchOpacity: membraneOpacity,
        },
      );
      // 검증: 생성된 막 씬의 opacity 필드 실제값 확인
      const opAttr = membrane.attrs.get('opacity');
      const propIdx = membrane.propertyOrder.indexOf('opacity');
      const expectedLogit = Math.log(Math.max(1e-4, Math.min(1-1e-4, membraneOpacity)) / (1 - Math.max(1e-4, Math.min(1-1e-4, membraneOpacity))));
      console.log(`[Membrane] propertyOrder includes 'opacity'? idx=${propIdx}; opAttr=${opAttr ? `len=${opAttr.length} sample[0]=${opAttr[0]}` : 'MISSING'}; expected logit≈${expectedLogit.toFixed(3)}`);
      console.log(`[Membrane] generated ${membrane.numSplats} patches`);

      // 별도 gsplat 엔티티로 로드 (메인 씬은 안 건드림 → flatten/회전 의도 보존)
      await loadMembraneEntity(membrane);

      membraneSceneRef.current = membrane;
      membraneActiveRef.current = true; setMembraneActive(true);
      cfRotationLockedRef.current = true; setCfRotationLocked(true);
      dirtyRef.current = true; setDirty(true);
      setSaved(false);
    } catch (e: any) {
      alert(`막 생성 실패: ${e.message || e}`);
    } finally {
      setMembraneApplying(false);
    }
  }, [selectedSurfaces, surfaceOffsets, membraneSpacing, membraneRadius, membraneOpacity, ensureOriginalScene, buildRotatedScene, loadMembraneEntity, removeMembraneEntity]);

  // ── Brush/BBox state ──
  const [paintMode, setPaintMode] = useState<PaintMode>('union');
  const [brushSize, setBrushSize] = useState(30);
  const [selectionCount, setSelectionCount] = useState(0);
  const selectionRef = useRef<Uint8Array | null>(null);
  const selHistoryRef = useRef<Uint8Array[]>([]);
  const paintModeRef = useRef<PaintMode>('union');
  const brushSizeRef = useRef(30);
  const brushCursorRef = useRef<HTMLDivElement | null>(null);
  // BBox selection bounds
  const selBboxMinRef = useRef<Vec3>([0,0,0]);
  const selBboxMaxRef = useRef<Vec3>([0,0,0]);
  const [selBboxMin, _setSelBboxMin] = useState<Vec3>([0,0,0]);
  const [selBboxMax, _setSelBboxMax] = useState<Vec3>([0,0,0]);
  const setSelBboxMin = (v: Vec3) => { selBboxMinRef.current = v; _setSelBboxMin(v); };
  const setSelBboxMax = (v: Vec3) => { selBboxMaxRef.current = v; _setSelBboxMax(v); };
  const bboxRangeRef = useRef<{min: Vec3; max: Vec3}>({min:[-1,-1,-1],max:[1,1,1]});

  // Sync refs
  useEffect(() => { planesRef.current = planes; }, [planes]);
  useEffect(() => { selectedPlaneRef.current = selectedPlane; }, [selectedPlane]);
  useEffect(() => { toolModeRef.current = toolMode; }, [toolMode]);
  useEffect(() => { refineModeRef.current = refineMode; }, [refineMode]);
  useEffect(() => { paintModeRef.current = paintMode; }, [paintMode]);
  useEffect(() => { brushSizeRef.current = brushSize; }, [brushSize]);
  useEffect(() => { pickingNormalRef.current = pickingNormal; }, [pickingNormal]);
  useEffect(() => { ceilingYRef.current = ceilingY; }, [ceilingY]);
  useEffect(() => { floorYRef.current = floorY; }, [floorY]);
  useEffect(() => { cfModeRef.current = cfMode; }, [cfMode]);
  useEffect(() => { wallAngleRef.current = wallAngle; }, [wallAngle]);
  useEffect(() => { wallDistancesRef.current = wallDistances; }, [wallDistances]);
  useEffect(() => { wallModeRef.current = wallMode; }, [wallMode]);

  // URL이 비워지면 (메인 제거) splat 상태를 비운다.
  // 새 URL로 바뀌는 경우에는 reset하지 않는다 — 그 이유는 PlayCanvas ResourceLoader가
  // URL별로 리소스를 캐시하므로 같은 URL이 다시 로드될 때 asset.ready가 동기 실행되며,
  // 자식(SplatViewerCore) effect가 부모(여기) effect보다 먼저 실행되는 React 순서 때문에
  // 자식의 onSplatLoaded(true)가 먼저 큐에 들어간 뒤 여기서 setSplatLoaded(false)로
  // 덮어써져 refine UI가 안 뜨는 버그가 생김. 새 URL 로드 시에는 onSplatLoaded가
  // splatDataRef와 splatLoaded를 직접 갱신하도록 맡긴다.
  useEffect(() => {
    if (!options?.currentUrl) {
      splatDataRef.current = null;
      setSplatLoaded(false);
    }
  }, [options?.currentUrl]);

  // ── localStorage 복원: uploadId 진입 시 1회 ──
  const loadedUploadIdRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = options?.uploadId;
    if (!uid || loadedUploadIdRef.current === uid) return;
    const saved = loadRefineState(uid);
    if (!saved) { loadedUploadIdRef.current = uid; return; }

    restoringRef.current = true;
    // 천장/바닥
    if (saved.cfConfirmed) {
      setCeilingY(saved.ceilingY); setFloorY(saved.floorY);
      ceilingYRef.current = saved.ceilingY; floorYRef.current = saved.floorY;
      setCfMode('confirmed'); cfModeRef.current = 'confirmed';
    }
    // 벽면
    if (saved.wallConfirmed && saved.wallAngle !== null && saved.wallDistances) {
      setWallAngle(saved.wallAngle); wallAngleRef.current = saved.wallAngle;
      setWallDistances(saved.wallDistances); wallDistancesRef.current = saved.wallDistances;
      setWallMode('confirmed'); wallModeRef.current = 'confirmed';
    }
    // 경계면 선택
    setSelectedSurfaces(new Set(saved.selectedSurfaces as Surface[]));
    setSurfaceOffsets(saved.surfaceOffsets as Record<Surface, number>);
    setOffsetText(saved.offsetText as Record<Surface, string>);
    // 막 파라미터
    setMembraneSpacing(saved.membraneSpacing);
    setMembraneRadius(saved.membraneRadius);
    setMembraneOpacity(saved.membraneOpacity);
    // PLY 자체는 메모리에서만 다루므로 세션 간 복원 안 함. 항상 원본부터 시작.

    loadedUploadIdRef.current = uid;
    // 한 틱 뒤 복원 플래그 해제
    setTimeout(() => { restoringRef.current = false; }, 0);
  }, [options?.uploadId]);

  // ── localStorage 저장: 관련 state 변경 시마다 ──
  useEffect(() => {
    const uid = options?.uploadId;
    if (!uid || restoringRef.current || loadedUploadIdRef.current !== uid) return;
    saveRefineState(uid, {
      cfConfirmed: cfMode === 'confirmed',
      ceilingY, floorY,
      wallConfirmed: wallMode === 'confirmed',
      wallAngle, wallDistances,
      selectedSurfaces: Array.from(selectedSurfaces),
      surfaceOffsets, offsetText,
      membraneSpacing, membraneRadius, membraneOpacity,
    });
  }, [
    options?.uploadId, undoDepth,
    cfMode, ceilingY, floorY,
    wallMode, wallAngle, wallDistances,
    selectedSurfaces, surfaceOffsets, offsetText,
    membraneSpacing, membraneRadius, membraneOpacity,
  ]);

  const syncPlanes = useCallback(() => setPlanes([...planesRef.current]), []);

  // ── Highlight: planes ──
  const recomputePlanes = useCallback(() => {
    const data = splatDataRef.current; const core = coreRef.current;
    if (!data || !core || planesRef.current.length === 0) {
      setOutsideCount(0); setClosed(false);
      if (data?.colorTexture && data?.origColorData) {
        let td: Uint16Array | null = null;
        try { td = data.colorTexture.lock(); } catch { return; }
        if (td) { td.set(data.origColorData); try { data.colorTexture.unlock(); } catch {} }
      }
      return;
    }
    const codes = computeCellCodes(data.posX, data.posY, data.posZ, data.numSplats, planesRef.current);
    const keep = findKeepCell(codes);
    cellCodesRef.current = codes; keepCellRef.current = keep;
    let out = 0; for (let i = 0; i < codes.length; i++) if (codes[i] !== keep) out++;
    setOutsideCount(out); setClosed(isClosed(keep, planesRef.current.length));

    if (!data.colorTexture || !data.origColorData) return;
    let td: Uint16Array | null = null;
    try { td = data.colorTexture.lock(); } catch { return; }
    if (!td) return;
    const orig = data.origColorData; const f2h = core.float2Half; const h2f = core.half2Float;
    const cl = isClosed(keep, planesRef.current.length);
    for (let i = 0; i < data.numSplats; i++) {
      const idx = i * 4;
      if (codes[i] !== keep) {
        const r = h2f(orig[idx]), g = h2f(orig[idx+1]), b = h2f(orig[idx+2]);
        const t = cl ? 0.8 : 0.5;
        td[idx] = f2h(r*(1-t)+1.0*t); td[idx+1] = f2h(g*(1-t)+0.1*t); td[idx+2] = f2h(b*(1-t)+0.1*t); td[idx+3] = orig[idx+3];
      } else { td[idx]=orig[idx]; td[idx+1]=orig[idx+1]; td[idx+2]=orig[idx+2]; td[idx+3]=orig[idx+3]; }
    }
    try { data.colorTexture.unlock(); } catch {}
  }, [coreRef]);

  // ── Highlight: brush/bbox selection → red ──
  const refreshSelection = useCallback(() => {
    const data = splatDataRef.current; const core = coreRef.current; const sel = selectionRef.current;
    if (!data || !core || !sel) return;
    let cnt = 0; for (let i = 0; i < sel.length; i++) if (sel[i]) cnt++;
    setSelectionCount(cnt);
    if (!data.colorTexture || !data.origColorData) return;
    let td: Uint16Array | null = null;
    try { td = data.colorTexture.lock(); } catch { return; }
    if (!td) return;
    const orig = data.origColorData; const f2h = core.float2Half; const h2f = core.half2Float;
    for (let i = 0; i < data.numSplats; i++) {
      const idx = i * 4;
      if (sel[i]) {
        const r = h2f(orig[idx]), g = h2f(orig[idx+1]), b = h2f(orig[idx+2]);
        td[idx] = f2h(r*0.3+1.0*0.7); td[idx+1] = f2h(g*0.3+0.1*0.7); td[idx+2] = f2h(b*0.3+0.1*0.7); td[idx+3] = orig[idx+3];
      } else { td[idx]=orig[idx]; td[idx+1]=orig[idx+1]; td[idx+2]=orig[idx+2]; td[idx+3]=orig[idx+3]; }
    }
    try { data.colorTexture.unlock(); } catch {}
  }, [coreRef]);

  // ── Unified surface highlight: tint gaussians near selected surfaces ──
  const SURFACE_COLORS: Record<string, [number, number, number]> = {
    ceiling: [0.133, 0.827, 0.933], // #22d3ee cyan
    floor:   [0.659, 0.333, 0.969], // #a855f7 violet
    w1a:     [0.937, 0.267, 0.267], // #ef4444 red
    w1b:     [0.925, 0.282, 0.600], // #ec4899 pink
    w2a:     [0.976, 0.451, 0.086], // #f97316 orange
    w2b:     [0.918, 0.702, 0.031], // #eab308 yellow
  };
  const applySurfaceHighlight = useCallback(() => {
    const data = splatDataRef.current; const core = coreRef.current;
    if (!data?.colorTexture || !data?.origColorData || !core) return;
    const sel = selectedSurfacesRef.current;

    let td: Uint16Array | null = null;
    try { td = data.colorTexture.lock(); } catch { return; }
    if (!td) return;
    const orig = data.origColorData;
    if (sel.size === 0) {
      td.set(orig); try { data.colorTexture.unlock(); } catch {} return;
    }
    const f2h = core.float2Half, h2f = core.half2Float;
    const mixT = 0.75;

    const cy = ceilingYRef.current, fy = floorYRef.current;
    const bandCf = Math.abs(fy - cy) * 0.03;
    const yLo = Math.min(cy, fy), yHi = Math.max(cy, fy);

    let c1 = 0, s1 = 0, c2 = 0, s2 = 0, a1 = 0, b1 = 0, a2 = 0, b2 = 0, bandWall = 0;
    const ang = wallAngleRef.current, walls = wallDistancesRef.current;
    const wallsReady = ang !== null && walls !== null;
    if (wallsReady) {
      const rad = (ang as number) * Math.PI / 180;
      c1 = Math.cos(rad); s1 = Math.sin(rad);
      c2 = Math.cos(rad + Math.PI / 2); s2 = Math.sin(rad + Math.PI / 2);
      [a1, b1, a2, b2] = walls as [number, number, number, number];
      bandWall = Math.min(Math.abs(b1 - a1), Math.abs(b2 - a2)) * 0.03;
    }

    // pendingRotation을 가우시안 좌표에 적용해서 평면(A' 프레임)과 비교 — flatten/막과 동일한 프레임
    const { rotX, rotZ } = pendingRotationRef.current;
    const rotActive = rotX !== 0 || rotZ !== 0;
    const rcx = Math.cos(rotX), rsx = Math.sin(rotX);
    const rcz = Math.cos(rotZ), rsz = Math.sin(rotZ);

    for (let i = 0; i < data.numSplats; i++) {
      const idx = i * 4;
      const x0 = data.posX[i], y0 = data.posY[i], z0 = data.posZ[i];
      // A → A' 회전 (rotateScene과 동일 식)
      let x: number, y: number, z: number;
      if (rotActive) {
        x = rcz * x0 - rsz * rcx * y0 + rsz * rsx * z0;
        y = rsz * x0 + rcz * rcx * y0 - rcz * rsx * z0;
        z = rsx * y0 + rcx * z0;
      } else {
        x = x0; y = y0; z = z0;
      }
      let bestSurf: string | null = null;
      let bestD = Infinity;

      if (sel.has('ceiling')) { const d = Math.abs(y - cy); if (d < bandCf && d < bestD) { bestD = d; bestSurf = 'ceiling'; } }
      if (sel.has('floor'))   { const d = Math.abs(y - fy); if (d < bandCf && d < bestD) { bestD = d; bestSurf = 'floor'; } }
      if (wallsReady && y >= yLo && y <= yHi) {
        const d1 = x * c1 + z * s1;
        const d2 = x * c2 + z * s2;
        if (sel.has('w1a')) { const d = Math.abs(d1 - a1); if (d < bandWall && d < bestD) { bestD = d; bestSurf = 'w1a'; } }
        if (sel.has('w1b')) { const d = Math.abs(d1 - b1); if (d < bandWall && d < bestD) { bestD = d; bestSurf = 'w1b'; } }
        if (sel.has('w2a')) { const d = Math.abs(d2 - a2); if (d < bandWall && d < bestD) { bestD = d; bestSurf = 'w2a'; } }
        if (sel.has('w2b')) { const d = Math.abs(d2 - b2); if (d < bandWall && d < bestD) { bestD = d; bestSurf = 'w2b'; } }
      }

      if (bestSurf) {
        const [cr, cg, cb] = SURFACE_COLORS[bestSurf];
        const r = h2f(orig[idx]), g = h2f(orig[idx+1]), b = h2f(orig[idx+2]);
        td[idx] = f2h(r*(1-mixT)+cr*mixT); td[idx+1] = f2h(g*(1-mixT)+cg*mixT); td[idx+2] = f2h(b*(1-mixT)+cb*mixT); td[idx+3] = orig[idx+3];
      } else {
        td[idx]=orig[idx]; td[idx+1]=orig[idx+1]; td[idx+2]=orig[idx+2]; td[idx+3]=orig[idx+3];
      }
    }
    try { data.colorTexture.unlock(); } catch {}
  }, [coreRef]);

  // Sync ref + re-tint whenever selection changes
  useEffect(() => {
    selectedSurfacesRef.current = selectedSurfaces;
    applySurfaceHighlight();
  }, [selectedSurfaces, applySurfaceHighlight]);

  // ── Restore original colors (mode switch) ──
  const clearHighlight = useCallback(() => {
    const data = splatDataRef.current;
    if (!data?.colorTexture || !data?.origColorData) return;
    const td = data.colorTexture.lock(); if (td) { td.set(data.origColorData); data.colorTexture.unlock(); }
  }, []);

  // ── Mode switch handler ──
  const switchMode = useCallback((mode: RefineMode) => {
    clearHighlight();
    setRefineMode(mode);
    refineModeRef.current = mode;
    // Reset plane gizmo state
    setToolMode('none'); toolModeRef.current = 'none'; dragRef.current = null;
    setPickingNormal(false); pickingNormalRef.current = false; normalDisplayRef.current = null; clearDepth();
    if (mode === 'plane') {
      // Restore plane preview if planes exist
      if (selectionRef.current) selectionRef.current.fill(0);
      setSelectionCount(0);
      setTimeout(() => recomputePlanes(), 0);
    } else {
      // Restore selection preview if any
      setTimeout(() => refreshSelection(), 0);
    }
  }, [clearHighlight, recomputePlanes, refreshSelection]);

  // ── Plane: add ──
  const addPlane = useCallback(() => {
    const cam = coreRef.current?.getCamera();
    let normal: Vec3 = [0,0,1];
    if (cam) { const fwd = cam.forward; normal = normalize3([-fwd.x, -fwd.y, -fwd.z]); }
    const center: Vec3 = [...bboxCenterRef.current];
    planesRef.current = [...planesRef.current, { normal, d: dot3(normal, center), center }];
    syncPlanes(); setTimeout(recomputePlanes, 0);
  }, [coreRef, recomputePlanes, syncPlanes]);

  // ── Plane: apply refine (repeatable) ──
  const applyPlaneRefine = useCallback(() => {
    const data = splatDataRef.current; const codes = cellCodesRef.current; const core = coreRef.current;
    if (!data || !codes || !core || !data.colorTexture || !data.origColorData) return;
    const keep = keepCellRef.current;
    const td = data.colorTexture.lock(); if (!td) return;
    const f2h = core.float2Half;
    for (let i = 0; i < data.numSplats; i++) {
      const idx = i * 4;
      if (codes[i] !== keep) { td[idx+3] = f2h(0); }
      else { td[idx]=data.origColorData[idx]; td[idx+1]=data.origColorData[idx+1]; td[idx+2]=data.origColorData[idx+2]; td[idx+3]=data.origColorData[idx+3]; }
    }
    data.colorTexture.unlock();
    const snap = data.colorTexture.lock(); if (snap) { data.origColorData.set(snap); data.colorTexture.unlock(); }
    planesRef.current = []; syncPlanes(); setSelectedPlane(-1); selectedPlaneRef.current = -1; setOutsideCount(0); setClosed(false);
  }, [coreRef, syncPlanes]);

  // ── Save refined result ──
  // 정제 중에는 어떤 PLY/베이크도 일어나지 않는다. "정제 결과 저장"을 누를 때만
  // 원본 PLY를 한 번 파싱하고, 누적된 의도(회전 + flatten 마스크 + 브러시 삭제 + 막)를
  // 한 번에 베이크해 단일 PLY로 업로드한다.
  const saveRefined = useCallback(async () => {
    if (!options?.uploadId && !options?.onRequestUpload) return;
    if (!dirtyRef.current) {
      alert('먼저 정제 작업을 한 번 이상 적용해야 합니다.');
      return;
    }
    setSaving(true);
    try {
      const { serializePly, filterScene, concatScenes } = await import('@/lib/ply');
      const { rotateScene } = await import('@/lib/gs');
      const { api } = await import('@/lib/api');

      const original = await ensureOriginalScene();
      const N = original.numSplats;
      const data = splatDataRef.current;
      const core = coreRef.current;

      // 1) 통합 keep 마스크 빌드: 브러시 삭제(origColorData alpha=0) ∪ flatten 마스크
      const keep = new Uint8Array(N).fill(1);
      // 브러시 삭제 반영
      if (data?.origColorData && core) {
        const h2f = core.half2Float;
        for (let i = 0; i < N; i++) {
          const a = h2f(data.origColorData[i * 4 + 3]);
          if (a < 1e-3) keep[i] = 0;
        }
      }
      // flatten 마스크 반영
      if (flattenMaskRef.current) {
        for (let i = 0; i < N; i++) if (flattenMaskRef.current[i]) keep[i] = 0;
      }

      // 2) 필터링 (원본 → 살릴 가우시안만)
      let baked = filterScene(original, keep);

      // 3) 회전 베이크 (살린 가우시안만 회전)
      const { rotX, rotZ } = pendingRotationRef.current;
      if (rotX !== 0 || rotZ !== 0) {
        rotateScene(baked, rotX, rotZ);
      }

      // 4) 막 합치기 (이미 A' 프레임으로 생성됨)
      if (membraneSceneRef.current) {
        baked = concatScenes(baked, membraneSceneRef.current);
      }

      console.log(`[Save] baked: ${baked.numSplats} gaussians (rot=${rotX},${rotZ}, membrane=${membraneSceneRef.current?.numSplats ?? 0})`);

      const bytes = serializePly(baked);

      if (options?.onRequestUpload) {
        // 외부 업로드 흐름 (로컬 파일 다듬기) — 메타데이터 모달 후 /uploads/init+complete
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        await options.onRequestUpload(u8, 'refined.ply');
        setSaved(true);
      } else if (options?.uploadId) {
        // 기존 흐름 (서버 upload 기반 다듬기) — /refine/refined-upload-url + /refine/save
        const urlReq = await api.post<{ put_url: string; get_url: string; key: string }>(
          '/refine/refined-upload-url',
          { upload_id: options.uploadId, filename: 'final.ply' },
        );
        const putResp = await fetch(urlReq.put_url, {
          method: 'PUT',
          body: bytes,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
        if (!putResp.ok) throw new Error(`MinIO PUT failed: ${putResp.status}`);

        await api.post<{ scene_id: string; message: string }>('/refine/save', {
          upload_id: options.uploadId,
          source_key: urlReq.key,
        });
        setSaved(true);
      }
    } catch (e: any) {
      alert(`저장 실패: ${e.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [options, ensureOriginalScene, coreRef]);

  // ── Brush/BBox: delete selected (repeatable) ──
  const deleteSelected = useCallback(() => {
    const data = splatDataRef.current; const core = coreRef.current; const sel = selectionRef.current;
    if (!data || !core || !sel || !data.colorTexture || !data.origColorData) return;
    const td = data.colorTexture.lock(); if (!td) return;
    const f2h = core.float2Half;
    for (let i = 0; i < data.numSplats; i++) {
      const idx = i * 4;
      if (sel[i]) { td[idx+3] = f2h(0); }
      else { td[idx]=data.origColorData[idx]; td[idx+1]=data.origColorData[idx+1]; td[idx+2]=data.origColorData[idx+2]; td[idx+3]=data.origColorData[idx+3]; }
    }
    data.colorTexture.unlock();
    const snap = data.colorTexture.lock(); if (snap) { data.origColorData.set(snap); data.colorTexture.unlock(); }
    sel.fill(0); setSelectionCount(0);
  }, [coreRef]);

  // ── Selection helpers ──
  const pushHistory = useCallback(() => {
    const sel = selectionRef.current; if (!sel) return;
    selHistoryRef.current.push(new Uint8Array(sel));
    if (selHistoryRef.current.length > 20) selHistoryRef.current.shift();
  }, []);
  const undo = useCallback(() => {
    const h = selHistoryRef.current; if (!h.length || !selectionRef.current) return;
    selectionRef.current.set(h.pop()!); refreshSelection();
  }, [refreshSelection]);
  const invertSelection = useCallback(() => {
    const sel = selectionRef.current; if (!sel) return; pushHistory();
    for (let i = 0; i < sel.length; i++) sel[i] = sel[i] ? 0 : 1; refreshSelection();
  }, [pushHistory, refreshSelection]);
  const clearSelection = useCallback(() => {
    const sel = selectionRef.current; if (!sel) return; pushHistory(); sel.fill(0); refreshSelection();
  }, [pushHistory, refreshSelection]);

  // ── Reset all (pristine) ──
  // 모든 의도(회전 / flatten / 막) 초기화 + GPU 색 복원 + 메인 entity transform 베이스로 복귀.
  // 메인 씬 reload는 안 함 (PLY 데이터는 절대 안 건드리는 모델이라 reload 필요 없음).
  const resetAll = useCallback(async () => {
    const data = splatDataRef.current; const pristine = pristineRef.current;
    if (data && pristine && data.colorTexture) {
      data.origColorData = new Uint16Array(pristine);
      const td = data.colorTexture.lock(); if (td) { td.set(pristine); data.colorTexture.unlock(); }
    }
    planesRef.current = []; setPlanes([]); setSelectedPlane(-1); selectedPlaneRef.current = -1; setOutsideCount(0); setClosed(false);
    if (selectionRef.current) selectionRef.current.fill(0); setSelectionCount(0);
    // 천장/바닥
    setCfMode('none'); cfModeRef.current = 'none';
    setCeilingY(0); setFloorY(0); ceilingYRef.current = 0; floorYRef.current = 0;
    setCfModalOpen(false);
    // 벽면
    setWallMode('none'); wallModeRef.current = 'none';
    setWallAngle(null); setWallDistances(null);
    wallAngleRef.current = null; wallDistancesRef.current = null;
    setWallModalOpen(false);
    // 경계면 선택
    setSelectedSurfaces(new Set()); selectedSurfacesRef.current = new Set();
    // 정제 의도 초기화
    pendingRotationRef.current = { rotX: 0, rotZ: 0 };
    setPendingRotation({ rotX: 0, rotZ: 0 });
    flattenMaskRef.current = null;
    flattenActiveRef.current = false; setFlattenActive(false);
    flattenVisibleRef.current = true; setFlattenVisible(true);
    membraneSceneRef.current = null;
    membraneActiveRef.current = false; setMembraneActive(false);
    cfRotationLockedRef.current = false; setCfRotationLocked(false);
    removeMembraneEntity();
    // 메인 entity transform 베이스 회전(180Z)으로 복귀
    applyEntityRotation();
    // undo + dirty
    opHistoryRef.current = [];
    setUndoDepth(0);
    dirtyRef.current = false;
    setDirty(false);
    setSaved(false);
    if (options?.uploadId) clearRefineState(options.uploadId);
  }, [options, applyEntityRotation, removeMembraneEntity]);

  // ── Undo: 통합 op 히스토리에서 가장 최근 작업 하나 되돌림 ──
  const undoLast = useCallback(async () => {
    if (opHistoryRef.current.length === 0) return;
    const rec = opHistoryRef.current.pop()!;
    setUndoDepth(opHistoryRef.current.length);
    setSaved(false);

    if (rec.type === 'rotation') {
      pendingRotationRef.current = rec.prevRotation;
      setPendingRotation(rec.prevRotation);
      applyEntityRotation();
    } else if (rec.type === 'flatten') {
      flattenMaskRef.current = rec.prevMask;
      flattenActiveRef.current = rec.prevActive; setFlattenActive(rec.prevActive);
      paintFlattenMask();
    }
    // membrane은 별도 op로 추적하지 않음 (apply 시 모든 의도가 베이크되어 op history가 비워짐).
    // 막 제거 = 전체 리셋이라 undo로 도달할 수 없음.

    const stillDirty = opHistoryRef.current.length > 0
      || pendingRotationRef.current.rotX !== 0
      || pendingRotationRef.current.rotZ !== 0
      || flattenActiveRef.current
      || membraneActiveRef.current;
    dirtyRef.current = stillDirty;
    setDirty(stillDirty);
  }, [applyEntityRotation, paintFlattenMask]);

  // ── BBox selection apply ──
  const applyBboxSel = useCallback((mn: Vec3, mx: Vec3) => {
    const data = splatDataRef.current; const sel = selectionRef.current;
    if (!data || !sel) return;
    for (let i = 0; i < data.numSplats; i++) {
      sel[i] = (data.posX[i]>=mn[0]&&data.posX[i]<=mx[0]&&data.posY[i]>=mn[1]&&data.posY[i]<=mx[1]&&data.posZ[i]>=mn[2]&&data.posZ[i]<=mx[2]) ? 1 : 0;
    }
    refreshSelection();
  }, [refreshSelection]);

  // ── Pick rotation ring ──
  const pickAxis = useCallback((mx: number, my: number, center: Vec3, r: number, cam: any, pc: any): number => {
    let best = -1, bestD = RING_PICK_PX;
    for (let a = 0; a < 3; a++) {
      const [t1, t2] = tangentBasis(WORLD_AXES[a]);
      for (let i = 0; i <= RING_SEGMENTS; i++) {
        const ang = (i/RING_SEGMENTS)*Math.PI*2;
        const pt = add3(center, add3(scale3(t1, Math.cos(ang)*r), scale3(t2, Math.sin(ang)*r)));
        const s = new pc.Vec3(); cam.worldToScreen(new pc.Vec3(pt[0],pt[1],pt[2]), s);
        const d = Math.hypot(s.x-mx, s.y-my); if (d < bestD) { bestD = d; best = a; }
      }
    }
    return best;
  }, []);

  // ── onSplatLoaded ──
  const onSplatLoaded = useCallback((data: SplatData) => {
    splatDataRef.current = data; setTotalCount(data.numSplats); setSplatLoaded(true);
    if (data.origColorData) pristineRef.current = new Uint16Array(data.origColorData);
    selectionRef.current = new Uint8Array(data.numSplats);

    // 새 splatData 수신 시 누적 회전 / flatten 마스크가 있으면 즉시 시각 동기화
    // (페이지 새로고침 후 persistence 복원이나 reset 후 등에서 호출됨)
    setTimeout(() => {
      applyEntityRotation();
      if (flattenActiveRef.current && flattenMaskRef.current) {
        // splatData가 새로 로드된 경우, 이전 마스크의 길이가 다를 수 있으니 검사
        if (flattenMaskRef.current.length === data.numSplats) {
          paintFlattenMask();
        } else {
          // 길이 불일치 → 마스크 무효
          flattenMaskRef.current = null;
          flattenActiveRef.current = false; setFlattenActive(false);
        }
      }
    }, 0);

    let mnX=Infinity,mnY=Infinity,mnZ=Infinity,mxX=-Infinity,mxY=-Infinity,mxZ=-Infinity;
    for (let i = 0; i < data.numSplats; i++) {
      if(data.posX[i]<mnX)mnX=data.posX[i]; if(data.posX[i]>mxX)mxX=data.posX[i];
      if(data.posY[i]<mnY)mnY=data.posY[i]; if(data.posY[i]>mxY)mxY=data.posY[i];
      if(data.posZ[i]<mnZ)mnZ=data.posZ[i]; if(data.posZ[i]>mxZ)mxZ=data.posZ[i];
    }
    bboxCenterRef.current = [(mnX+mxX)/2,(mnY+mxY)/2,(mnZ+mxZ)/2];
    bboxSizeRef.current = Math.max(mxX-mnX, mxY-mnY, mxZ-mnZ);
    bboxRangeRef.current = {min:[mnX,mnY,mnZ], max:[mxX,mxY,mxZ]};
    setSelBboxMin([mnX,mnY,mnZ]); setSelBboxMax([mxX,mxY,mxZ]);

    const core = coreRef.current; const canvas = core?.getCanvas(); const cameraEntity = core?.getCamera();
    if (!core || !canvas || !cameraEntity) return;
    import('playcanvas').then(m => { pcRef.current = m; });

    // ── Local state for mouse handlers ──
    let painting = false;
    let bboxDragAxis = -1, bboxDragIsMax = false, bboxDragStartVal = 0, bboxDragStartMouseY = 0, bboxDragScale = 1;

    // ── Plane pick ──
    const pickPlane = (mx: number, my: number): number => {
      const cam = cameraEntity.camera; const pc = pcRef.current; if (!cam||!pc) return -1;
      const near = new pc.Vec3(), far = new pc.Vec3();
      cam.screenToWorld(mx, my, cam.nearClip, near); cam.screenToWorld(mx, my, cam.farClip, far);
      const dir = new pc.Vec3().sub2(far, near).normalize();
      const ro: Vec3 = [near.x,near.y,near.z], rd: Vec3 = [dir.x,dir.y,dir.z];
      const size = bboxSizeRef.current * 0.6; let bestT = Infinity, bestIdx = -1;
      for (let pi = 0; pi < planesRef.current.length; pi++) {
        const { normal, d, center } = planesRef.current[pi];
        const denom = dot3(normal, rd); if (Math.abs(denom)<1e-6) continue;
        const t = (d-dot3(normal,ro))/denom; if (t<0||t>=bestT) continue;
        const hit: Vec3 = [ro[0]+rd[0]*t, ro[1]+rd[1]*t, ro[2]+rd[2]*t];
        const [t1, t2] = tangentBasis(normal);
        const diff: Vec3 = [hit[0]-center[0], hit[1]-center[1], hit[2]-center[2]];
        if (Math.abs(dot3(diff,t1))<=size && Math.abs(dot3(diff,t2))<=size) { bestT=t; bestIdx=pi; }
      }
      return bestIdx;
    };

    // ── Brush apply ──
    // posX/Y/Z는 원본 PLY 좌표이고 카메라 행렬은 월드 공간이므로 splatEntity의 world transform을 앞에 곱해야 함.
    // (Z축 180° 회전이 반영되어 뷰어가 보여주는 위치와 실제 히트가 일치)
    const applyBrush = (mouseX: number, mouseY: number) => {
      const sd = splatDataRef.current; const sel = selectionRef.current;
      const cam = cameraEntity.camera; const pc = pcRef.current;
      if (!sd || !sel || !cam || !pc) return;
      const vpMat = new pc.Mat4(); vpMat.mul2(cam.projectionMatrix, cam.viewMatrix);
      const mvpMat = new pc.Mat4(); mvpMat.mul2(vpMat, sd.splatEntity.getWorldTransform());
      const m = mvpMat.data; const w = canvas.clientWidth, h = canvas.clientHeight;
      const r2 = brushSizeRef.current**2; const isUnion = paintModeRef.current === 'union';
      for (let i = 0; i < sd.numSplats; i++) {
        const px=sd.posX[i], py=sd.posY[i], pz=sd.posZ[i];
        const cw = m[3]*px+m[7]*py+m[11]*pz+m[15]; if (cw<=0.01) continue;
        const inv = 1/cw;
        const sx = ((m[0]*px+m[4]*py+m[8]*pz+m[12])*inv+1)*0.5*w;
        const sy = (1-(m[1]*px+m[5]*py+m[9]*pz+m[13])*inv)*0.5*h;
        const dx = sx-mouseX, dy = sy-mouseY;
        if (dx*dx+dy*dy < r2) sel[i] = isUnion ? 1 : 0;
      }
      refreshSelection();
    };

    // ── BBox face pick ──
    const pickBboxFace = (mouseX: number, mouseY: number): {axis:number;isMax:boolean}|null => {
      const cam = cameraEntity.camera; const pc = pcRef.current; if (!cam||!pc) return null;
      const near = new pc.Vec3(), far = new pc.Vec3();
      cam.screenToWorld(mouseX, mouseY, cam.nearClip, near); cam.screenToWorld(mouseX, mouseY, cam.farClip, far);
      const dir = new pc.Vec3().sub2(far, near).normalize();
      const mn = selBboxMinRef.current, mx = selBboxMaxRef.current;
      const faces = [{axis:0,isMax:true},{axis:0,isMax:false},{axis:1,isMax:true},{axis:1,isMax:false},{axis:2,isMax:true},{axis:2,isMax:false}];
      const vals = [mx[0],mn[0],mx[1],mn[1],mx[2],mn[2]];
      let bestT = Infinity, best: {axis:number;isMax:boolean}|null = null;
      for (let fi = 0; fi < 6; fi++) {
        const ax = faces[fi].axis;
        const oc = ax===0?near.x:ax===1?near.y:near.z;
        const dc = ax===0?dir.x:ax===1?dir.y:dir.z;
        if (Math.abs(dc)<1e-6) continue;
        const t = (vals[fi]-oc)/dc; if (t<0||t>=bestT) continue;
        const hit = [near.x+dir.x*t, near.y+dir.y*t, near.z+dir.z*t];
        const other = [0,1,2].filter(a=>a!==ax);
        if (other.every(a=>hit[a]>=mn[a]&&hit[a]<=mx[a])) { bestT=t; best=faces[fi]; }
      }
      return best;
    };

    // ── Keyboard ──
    const onKeyDown = (e: KeyboardEvent) => {
      const mode = refineModeRef.current;
      if (mode === 'plane' && selectedPlaneRef.current >= 0) {
        if (e.code === 'KeyT') { setToolMode('translate'); toolModeRef.current = 'translate'; }
        else if (e.code === 'KeyR') { setToolMode('rotate'); toolModeRef.current = 'rotate'; }
      }
      if ((mode === 'brush' || mode === 'bbox') && e.code === 'Delete') {
        deleteSelected();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyT' && toolModeRef.current === 'translate') { setToolMode('none'); toolModeRef.current = 'none'; dragRef.current = null; }
      else if (e.code === 'KeyR' && toolModeRef.current === 'rotate') { setToolMode('none'); toolModeRef.current = 'none'; hoveredAxisRef.current = -1; dragRef.current = null; }
    };

    // ── Mouse ──
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const pc = pcRef.current; if (!pc) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX-rect.left, my = e.clientY-rect.top;
      const mode = refineModeRef.current;

      // ── PLANE MODE ──
      if (mode === 'plane') {
        // ── Normal picking via Depth Map ──
        if (pickingNormalRef.current) {
          e.preventDefault();
          const sd = splatDataRef.current; const cam = cameraEntity.camera;
          if (!sd || !cam || !pc) return;

          // 1. Hit test to find the clicked gaussian (for display position)
          const vpMat = new pc.Mat4(); vpMat.mul2(cam.projectionMatrix, cam.viewMatrix);
          const mm = vpMat.data; const cw2 = canvas.clientWidth, ch2 = canvas.clientHeight;
          const pickR2 = 20 * 20;
          let bestIdx = -1, bestDepth = Infinity;
          for (let i = 0; i < sd.numSplats; i++) {
            const px = sd.posX[i], py = sd.posY[i], pz = sd.posZ[i];
            const cww = mm[3]*px + mm[7]*py + mm[11]*pz + mm[15]; if (cww <= 0.01) continue;
            const inv = 1/cww;
            const sx = ((mm[0]*px + mm[4]*py + mm[8]*pz + mm[12])*inv + 1)*0.5*cw2;
            const sy = (1 - (mm[1]*px + mm[5]*py + mm[9]*pz + mm[13])*inv)*0.5*ch2;
            const dx = sx - mx, dy = sy - my;
            if (dx*dx + dy*dy < pickR2 && cww < bestDepth) { bestDepth = cww; bestIdx = i; }
          }
          if (bestIdx < 0) return;
          const hitPos: Vec3 = [sd.posX[bestIdx], sd.posY[bestIdx], sd.posZ[bestIdx]];

          // 2. Compute depth map (with camera basis at capture time), then get normal
          setDepthLoading(true);
          (async () => {
            try {
              // Capture camera basis now — stored with depth map for consistent transform
              const right = cameraEntity.right;
              const up = cameraEntity.up;
              const fwd = cameraEntity.forward;
              const camRight: Vec3 = [right.x, right.y, right.z];
              const camUp: Vec3 = [up.x, up.y, up.z];
              const camForward: Vec3 = [fwd.x, fwd.y, fwd.z];

              if (!hasDepth()) {
                console.log('[DepthNormal] Computing depth map...');
                const fov = cam.fov || 45;
                await computeDepthMap(canvas, camRight, camUp, camForward, fov);
                console.log('[DepthNormal] Depth map ready:', hasDepth());
              }

              let normal = getNormalAt(mx, my);
              console.log('[DepthNormal] Depth-based normal:', normal);
              if (!normal) {
                // Fallback to PCA
                console.log('[DepthNormal] Falling back to PCA');
                const radius = bboxSizeRef.current * 0.03;
                const r2 = radius * radius;
                const neighbors: Vec3[] = [];
                for (let i = 0; i < sd.numSplats; i++) {
                  const dx = sd.posX[i]-hitPos[0], dy = sd.posY[i]-hitPos[1], dz = sd.posZ[i]-hitPos[2];
                  if (dx*dx + dy*dy + dz*dz < r2) neighbors.push([sd.posX[i], sd.posY[i], sd.posZ[i]]);
                }
                if (neighbors.length >= 10) normal = pcaNormal(neighbors);
              }
              if (normal) {
                // Ensure normal points toward camera
                const cp = cameraEntity.getLocalPosition();
                const toCamera: Vec3 = [cp.x-hitPos[0], cp.y-hitPos[1], cp.z-hitPos[2]];
                if (dot3(normal, toCamera) < 0) normal = scale3(normal, -1);
                normalDisplayRef.current = { point: hitPos, normal };
              }
            } finally {
              setDepthLoading(false);
            }
          })();
          return;
        }
        const tm = toolModeRef.current; const selIdx = selectedPlaneRef.current;
        if (tm === 'translate' && selIdx >= 0) {
          e.preventDefault();
          const plane = planesRef.current[selIdx]; const n = plane.normal; const cam = cameraEntity.camera;
          const ctr = plane.center; const cp = cameraEntity.getLocalPosition();
          const dist = Math.sqrt((cp.x-ctr[0])**2+(cp.y-ctr[1])**2+(cp.z-ctr[2])**2);
          let snd: [number,number] = [0,-1];
          if (cam) { const sc=new pc.Vec3(),st=new pc.Vec3(); cam.worldToScreen(new pc.Vec3(...ctr),sc); cam.worldToScreen(new pc.Vec3(ctr[0]+n[0],ctr[1]+n[1],ctr[2]+n[2]),st); const dx=st.x-sc.x,dy=st.y-sc.y; const l=Math.hypot(dx,dy); if(l>0.001) snd=[dx/l,dy/l]; }
          dragRef.current = { active:true, planeIndex:selIdx, mode:'move', startD:plane.d, startCenter:[...plane.center], startMouseX:e.clientX, startMouseY:e.clientY, moveScale:dist*0.003, screenNormalDir:snd, rotateAxis:-1, scrAxisPerp:[0,0], viewSign:1, prevMouseX:e.clientX, prevMouseY:e.clientY };
          return;
        }
        if (tm === 'rotate' && selIdx >= 0) {
          const plane = planesRef.current[selIdx]; const center = plane.center; const cam = cameraEntity.camera;
          const axIdx = pickAxis(mx, my, center, bboxSizeRef.current*0.15, cam, pc);
          if (axIdx >= 0) {
            e.preventDefault(); const axis = WORLD_AXES[axIdx];
            const sc=new pc.Vec3(),st=new pc.Vec3(); cam.worldToScreen(new pc.Vec3(...center),sc); cam.worldToScreen(new pc.Vec3(center[0]+axis[0],center[1]+axis[1],center[2]+axis[2]),st);
            let adx=st.x-sc.x,ady=st.y-sc.y; const al=Math.hypot(adx,ady); if(al>0.001){adx/=al;ady/=al;}
            const camFwd = cameraEntity.forward;
            const vd = axis[0]*(-camFwd.x)+axis[1]*(-camFwd.y)+axis[2]*(-camFwd.z);
            dragRef.current = { active:true, planeIndex:selIdx, mode:'rotate', rotateAxis:axIdx, scrAxisPerp:[-ady,adx] as [number,number], viewSign:vd>=0?1:-1, startD:plane.d, startCenter:[...plane.center], startMouseX:e.clientX, startMouseY:e.clientY, moveScale:0, screenNormalDir:[0,0], prevMouseX:e.clientX, prevMouseY:e.clientY };
            return;
          }
        }
        if (tm === 'none') {
          const hit = pickPlane(mx, my);
          if (hit >= 0) { setSelectedPlane(hit); selectedPlaneRef.current = hit; }
          else { setSelectedPlane(-1); selectedPlaneRef.current = -1; }
        }
        return;
      }

      // ── BRUSH MODE ──
      if (mode === 'brush') { painting = true; pushHistory(); applyBrush(mx, my); return; }

      // ── BBOX MODE ──
      if (mode === 'bbox') {
        const face = pickBboxFace(mx, my);
        if (face) {
          bboxDragAxis = face.axis; bboxDragIsMax = face.isMax;
          const vals = face.isMax ? selBboxMaxRef.current : selBboxMinRef.current;
          bboxDragStartVal = vals[face.axis]; bboxDragStartMouseY = e.clientY;
          const cp = cameraEntity.getLocalPosition();
          const fc = [(selBboxMinRef.current[0]+selBboxMaxRef.current[0])/2, (selBboxMinRef.current[1]+selBboxMaxRef.current[1])/2, (selBboxMinRef.current[2]+selBboxMaxRef.current[2])/2];
          bboxDragScale = Math.sqrt((cp.x-fc[0])**2+(cp.y-fc[1])**2+(cp.z-fc[2])**2)*0.003;
          pushHistory();
        }
        return;
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const mode = refineModeRef.current;

      // ── PLANE: rotation ring hover + drag ──
      if (mode === 'plane') {
        if (toolModeRef.current === 'rotate' && selectedPlaneRef.current >= 0 && !dragRef.current?.active) {
          const pc = pcRef.current; const cam = cameraEntity.camera;
          if (pc && cam) { const rect = canvas.getBoundingClientRect(); const p = planesRef.current[selectedPlaneRef.current]; if (p) hoveredAxisRef.current = pickAxis(e.clientX-rect.left, e.clientY-rect.top, p.center, bboxSizeRef.current*0.15, cam, pc); }
        }
        const drag = dragRef.current; if (!drag?.active) return; e.preventDefault();
        if (drag.mode === 'move') {
          const dx=e.clientX-drag.startMouseX, dy=e.clientY-drag.startMouseY;
          const proj = dx*drag.screenNormalDir[0]+dy*drag.screenNormalDir[1];
          const newD = drag.startD+proj*drag.moveScale; const n = planesRef.current[drag.planeIndex].normal;
          const off = newD-drag.startD; const nc: Vec3 = [drag.startCenter[0]+n[0]*off, drag.startCenter[1]+n[1]*off, drag.startCenter[2]+n[2]*off];
          planesRef.current = planesRef.current.map((p,i) => i===drag.planeIndex ? {...p,d:newD,center:nc} : p);
          syncPlanes(); recomputePlanes();
        } else if (drag.mode === 'rotate') {
          const dx=e.clientX-drag.prevMouseX, dy=e.clientY-drag.prevMouseY; drag.prevMouseX=e.clientX; drag.prevMouseY=e.clientY;
          const amt = dx*drag.scrAxisPerp[0]+dy*drag.scrAxisPerp[1]; if (Math.abs(amt)<0.3) return;
          const ang = amt*0.005*drag.viewSign; const p = planesRef.current[drag.planeIndex];
          const n = normalize3(rotateVec(p.normal, WORLD_AXES[drag.rotateAxis], ang));
          const nd = dot3(n, p.center);
          planesRef.current = planesRef.current.map((pp,i) => i===drag.planeIndex ? {...pp,normal:n,d:nd} : pp);
          syncPlanes(); recomputePlanes();
        }
        return;
      }

      // ── BRUSH: cursor + paint ──
      if (mode === 'brush') {
        if (brushCursorRef.current) {
          const rect = canvas.getBoundingClientRect(); const x=e.clientX-rect.left, y=e.clientY-rect.top; const sz=brushSizeRef.current*2;
          brushCursorRef.current.style.display='block'; brushCursorRef.current.style.left=`${x-sz/2}px`; brushCursorRef.current.style.top=`${y-sz/2}px`; brushCursorRef.current.style.width=`${sz}px`; brushCursorRef.current.style.height=`${sz}px`;
        }
        if (painting) { const rect = canvas.getBoundingClientRect(); applyBrush(e.clientX-rect.left, e.clientY-rect.top); }
        return;
      }

      // ── BBOX: drag face ──
      if (mode === 'bbox' && bboxDragAxis >= 0) {
        const delta = (bboxDragStartMouseY-e.clientY)*bboxDragScale;
        let nv = bboxDragStartVal+delta; const range = bboxRangeRef.current;
        nv = Math.max(range.min[bboxDragAxis], Math.min(range.max[bboxDragAxis], nv));
        if (bboxDragIsMax) {
          nv = Math.max(nv, selBboxMinRef.current[bboxDragAxis]+0.01);
          const v = [...selBboxMaxRef.current] as Vec3; v[bboxDragAxis] = nv; setSelBboxMax(v); applyBboxSel(selBboxMinRef.current, v);
        } else {
          nv = Math.min(nv, selBboxMaxRef.current[bboxDragAxis]-0.01);
          const v = [...selBboxMinRef.current] as Vec3; v[bboxDragAxis] = nv; setSelBboxMin(v); applyBboxSel(v, selBboxMaxRef.current);
        }
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragRef.current = null; painting = false; bboxDragAxis = -1;
    };
    const onMouseLeave = () => { if (brushCursorRef.current) brushCursorRef.current.style.display = 'none'; };

    canvas.addEventListener('keydown', onKeyDown); canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('mousedown', onMouseDown); canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave); window.addEventListener('mouseup', onMouseUp);

    // ── Visualization loop ──
    const unsubUpdate = core.onUpdate(() => {
      const mode = refineModeRef.current;

      // ── Plane visualization ──
      if (mode === 'plane') {
        const ps = planesRef.current;
        if (ps.length === 0) { /* skip plane drawing but don't return — normal display below */ }
        else {
        const size = bboxSizeRef.current * 0.6; const selIdx = selectedPlaneRef.current; const tm = toolModeRef.current;
        for (let pi = 0; pi < ps.length; pi++) {
          const { normal, center } = ps[pi]; const corners = planeCorners(center, normal, size); const isSel = pi === selIdx;
          const ec: Color4 = isSel ? [1,1,1,1] : [1,0.3,0.3,0.8];
          const fc: Color4 = isSel ? [0.8,0.8,1,0.4] : [1,0.2,0.2,0.2];
          core.drawLine(corners[0],corners[1],ec,false); core.drawLine(corners[1],corners[2],ec,false);
          core.drawLine(corners[2],corners[3],ec,false); core.drawLine(corners[3],corners[0],ec,false);
          core.drawLine(corners[0],corners[2],fc,false); core.drawLine(corners[1],corners[3],fc,false);
          const [t1,t2] = tangentBasis(normal);
          for (let g=1;g<4;g++){const f=-1+2*g/4; core.drawLine(add3(center,add3(scale3(t1,f*size),scale3(t2,-size))),add3(center,add3(scale3(t1,f*size),scale3(t2,size))),fc,false); core.drawLine(add3(center,add3(scale3(t1,-size),scale3(t2,f*size))),add3(center,add3(scale3(t1,size),scale3(t2,f*size))),fc,false);}
          core.drawLine(center, add3(center, scale3(normal, size*0.15)), isSel?[0,1,1,1]:[0,0.7,0.7,0.6], false);

          if (isSel && tm === 'translate') {
            const hl=bboxSizeRef.current*0.2, hs=hl*0.15; const tA=add3(center,scale3(normal,hl)), tB=add3(center,scale3(normal,-hl));
            const ac: Color4 = [1,1,0,1]; core.drawLine(tB,tA,ac,false);
            const [ht1,ht2]=tangentBasis(normal); const bA=add3(center,scale3(normal,hl-hs*2)), bB=add3(center,scale3(normal,-hl+hs*2));
            for (const d of [ht1,scale3(ht1,-1),ht2,scale3(ht2,-1)]){core.drawLine(tA,add3(bA,scale3(d,hs)),ac,false);core.drawLine(tB,add3(bB,scale3(d,hs)),ac,false);}
          }
          if (isSel && tm === 'rotate') {
            const gr=bboxSizeRef.current*0.15; const hov=hoveredAxisRef.current; const da=dragRef.current?.active?dragRef.current.rotateAxis:-1;
            for (let a=0;a<3;a++){const isA=a===da,isH=a===hov&&da<0; const col:Color4=isA||isH?AXIS_COLORS[a]:AXIS_COLORS_DIM[a];
              const [rt1,rt2]=tangentBasis(WORLD_AXES[a]); let prev:Vec3|null=null;
              for(let i=0;i<=RING_SEGMENTS;i++){const ang=(i/RING_SEGMENTS)*Math.PI*2;const pt=add3(center,add3(scale3(rt1,Math.cos(ang)*gr),scale3(rt2,Math.sin(ang)*gr)));if(prev)core.drawLine(prev,pt,col,false);prev=pt;}}
          }
        }
        } // end else (ps.length > 0)
      }

      // ── BBox wireframe ──
      if (mode === 'bbox') {
        const mn=selBboxMinRef.current, mx=selBboxMaxRef.current;
        const cs: Vec3[] = [[mn[0],mn[1],mn[2]],[mx[0],mn[1],mn[2]],[mx[0],mx[1],mn[2]],[mn[0],mx[1],mn[2]],[mn[0],mn[1],mx[2]],[mx[0],mn[1],mx[2]],[mx[0],mx[1],mx[2]],[mn[0],mx[1],mx[2]]];
        const es: [number,number][] = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
        const bc: Color4=[0,1,0.5,1], bh: Color4=[1,1,0,1];
        for (const [a,b] of es) {
          let col=bc;
          if(bboxDragAxis>=0){const dv=bboxDragIsMax?selBboxMaxRef.current[bboxDragAxis]:selBboxMinRef.current[bboxDragAxis];if(Math.abs(cs[a][bboxDragAxis]-dv)<0.001&&Math.abs(cs[b][bboxDragAxis]-dv)<0.001)col=bh;}
          core.drawLine(cs[a],cs[b],col,false);
        }
      }

      // ── Normal display ──
      const nd = normalDisplayRef.current;
      if (nd) {
        const len = bboxSizeRef.current * 0.15;
        core.drawLine(nd.point, add3(nd.point, scale3(nd.normal, len)), [0,1,1,1], false);
        core.drawLine(nd.point, add3(nd.point, scale3(nd.normal, -len * 0.3)), [0,0.5,0.5,0.6], false);
        const s = len * 0.03;
        for (const ax of WORLD_AXES) core.drawLine(add3(nd.point, scale3(ax, -s)), add3(nd.point, scale3(ax, s)), [1,1,0,1], false);
      }

      // ── Ceiling/Floor: no per-frame work (coloring done on confirm/change) ──
    });

    return () => {
      canvas.removeEventListener('keydown', onKeyDown); canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('mousedown', onMouseDown); canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave); window.removeEventListener('mouseup', onMouseUp);
      unsubUpdate();
    };
  }, [coreRef, recomputePlanes, refreshSelection, syncPlanes, pickAxis, pushHistory, applyBboxSel, deleteSelected]);

  // Auto recompute for planes
  useEffect(() => { if (splatLoaded && refineModeRef.current === 'plane') recomputePlanes(); }, [planes, splatLoaded, recomputePlanes]);

  // ── UI ──
  const ui = splatLoaded ? (
    <>
      {/* Brush cursor */}
      <div ref={brushCursorRef} className="absolute pointer-events-none rounded-full border border-red-400/60" style={{display:'none',boxShadow:'0 0 4px rgba(255,100,100,0.3)'}} />

      <div className="absolute top-3 left-16 z-40 bg-black/70 text-gray-300 text-xs rounded p-3 flex flex-col gap-2 select-none min-w-[230px]">
        <div className="text-white font-bold text-sm mb-1">다듬기</div>

        {/* Mode tabs */}
        <div className="flex gap-1">
          {([['plane','평면'],['brush','브러쉬'],['bbox','BBox']] as const).map(([key, label]) => (
            <button key={key} onClick={() => switchMode(key as RefineMode)}
              className={`px-2 py-1 rounded cursor-pointer text-xs ${refineMode===key?'bg-blue-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>
              {label}
            </button>
          ))}
        </div>

        {/* ── Plane controls ── */}
        {refineMode === 'plane' && (
          <>
            {/* Ceiling/Floor */}
            <div className="border border-gray-600 rounded p-2 flex flex-col gap-1.5">
              <div className="text-gray-400 text-[10px] font-bold">천장 / 바닥</div>
              {cfMode === 'none' ? (
                <button onClick={() => setCfModalOpen(true)}
                  className="px-3 py-1.5 bg-teal-600 hover:bg-teal-500 text-white rounded cursor-pointer text-xs">
                  천장/바닥 설정
                </button>
              ) : (
                <>
                  <div className="text-green-400 text-[10px] font-bold">천장/바닥 확정됨</div>
                  <button onClick={() => setCfModalOpen(true)}
                    className="px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded cursor-pointer text-xs">다시 수정</button>
                </>
              )}
            </div>

            {/* 벽면 */}
            <div className="border border-gray-600 rounded p-2 flex flex-col gap-1.5">
              <div className="text-gray-400 text-[10px] font-bold">벽면 (X/Z 정렬)</div>
              {wallMode === 'none' && (
                <button onClick={() => setWallModalOpen(true)} disabled={cfMode !== 'confirmed'}
                  className="px-3 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded cursor-pointer text-xs">
                  {cfMode !== 'confirmed' ? '천장/바닥 먼저 확정' : '벽면 설정'}
                </button>
              )}
              {wallMode === 'confirmed' && (
                <>
                  <div className="text-green-400 text-[10px] font-bold">
                    벽면 확정됨 ({wallAngle?.toFixed(1)}°)
                  </div>
                  <button onClick={() => setWallModalOpen(true)}
                    className="px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded cursor-pointer text-xs">다시 수정</button>
                </>
              )}
            </div>

            {/* 경계면 선택 후 바깥 가우시안 제거 (Shell 제거) — 체크박스는 해당 설정이 확정되어야 활성화 */}
            <div className="border border-gray-600 rounded p-2 flex flex-col gap-1.5">
              <div className="text-gray-400 text-[10px] font-bold">경계면 처리</div>
              {(() => {
                const labels: Record<Surface, { name: string; color: string }> = {
                  ceiling: { name: '천장', color: '#22d3ee' },
                  floor:   { name: '바닥', color: '#a855f7' },
                  w1a:     { name: '벽1a', color: '#ef4444' },
                  w1b:     { name: '벽1b', color: '#ec4899' },
                  w2a:     { name: '벽2a', color: '#f97316' },
                  w2b:     { name: '벽2b', color: '#eab308' },
                };
                const isDisabled = (s: Surface) =>
                  CF_SURFACES.includes(s) ? cfMode !== 'confirmed' : wallMode !== 'confirmed';
                return (
                  <div className="flex flex-col gap-1">
                    {ALL_SURFACES.map(s => {
                      const disabled = isDisabled(s);
                      return (
                        <div key={s} className={`flex items-center gap-1.5 text-[11px] ${disabled ? 'opacity-40' : ''}`}>
                          <label className={`flex items-center gap-1.5 flex-1 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                            <input type="checkbox" checked={selectedSurfaces.has(s)} disabled={disabled}
                              onChange={() => toggleSurface(s)}
                              className="accent-blue-500" />
                            <span style={{ color: labels[s].color }}>{labels[s].name}</span>
                          </label>
                          <span className="text-gray-500 text-[10px]">안전거리</span>
                          <input type="text" inputMode="decimal" value={offsetText[s]} disabled={disabled}
                            onChange={e => {
                              const v = e.target.value;
                              setOffsetText(prev => ({ ...prev, [s]: v }));
                              const n = parseFloat(v);
                              if (!isNaN(n)) setSurfaceOffsets(prev => ({ ...prev, [s]: n }));
                            }}
                            onBlur={() => {
                              // 포커스 잃으면 숫자 상태와 동기화 (빈칸/부적합 입력 복구)
                              setOffsetText(prev => ({ ...prev, [s]: String(surfaceOffsets[s]) }));
                            }}
                            className="w-14 px-1 py-0.5 bg-gray-800 border border-gray-600 rounded text-white text-[10px] font-mono disabled:opacity-50" />
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              <button onClick={toggleAllSurfaces}
                disabled={cfMode !== 'confirmed' && wallMode !== 'confirmed'}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:opacity-50 text-gray-200 rounded cursor-pointer disabled:cursor-not-allowed text-[11px]">
                전체 선택/해제
              </button>
              <button onClick={() => applyFlatten()}
                disabled={flattening || membraneApplying || (!flattenActive && selectedSurfaces.size === 0)}
                className={`w-full px-2 py-1.5 rounded cursor-pointer text-xs font-bold disabled:bg-gray-600 disabled:text-gray-400 ${
                  flattenActive
                    ? 'bg-amber-600 hover:bg-amber-500 text-white'
                    : 'bg-red-600 hover:bg-red-500 text-white'
                }`}>
                {flattening ? '처리 중...' : (flattenActive ? '바깥 복원' : '바깥 제거')}
              </button>
              <div className="border-t border-gray-700 pt-2 mt-1 space-y-1.5">
                {/* 막 파라미터 슬라이더 */}
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className="text-gray-400 w-14">격자 간격</span>
                    <input type="range" min={0.005} max={0.08} step={0.005}
                      value={membraneSpacing}
                      onChange={(e) => setMembraneSpacing(parseFloat(e.target.value))}
                      className="flex-1 accent-blue-500 cursor-pointer" />
                    <span className="text-white font-mono w-12 text-right">
                      {(membraneSpacing * 100).toFixed(1)}cm
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className="text-gray-400 w-14">패치 반경</span>
                    <input type="range" min={0.01} max={0.15} step={0.005}
                      value={membraneRadius}
                      onChange={(e) => setMembraneRadius(parseFloat(e.target.value))}
                      className="flex-1 accent-blue-500 cursor-pointer" />
                    <span className="text-white font-mono w-12 text-right">
                      {(membraneRadius * 100).toFixed(1)}cm
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className="text-gray-400 w-14">불투명도</span>
                    <input type="range" min={0.01} max={1.0} step={0.01}
                      value={membraneOpacity}
                      onChange={(e) => setMembraneOpacity(parseFloat(e.target.value))}
                      className="flex-1 accent-blue-500 cursor-pointer" />
                    <span className="text-white font-mono w-12 text-right">
                      {membraneOpacity.toFixed(2)}
                    </span>
                  </div>
                </div>
                <button onClick={() => applyMembrane()}
                  disabled={flattening || membraneApplying || (!membraneActive && selectedSurfaces.size === 0)}
                  className={`w-full px-2 py-1.5 rounded cursor-pointer text-xs font-bold disabled:bg-gray-600 disabled:text-gray-400 ${
                    membraneActive
                      ? 'bg-amber-600 hover:bg-amber-500 text-white'
                      : 'bg-white hover:bg-gray-200 text-black'
                  }`}>
                  {membraneApplying ? '처리 중...' : (membraneActive ? '막 제거하기' : '얇은 막 씌우기')}
                </button>
                {cfRotationLocked && (
                  <div className="text-[9px] text-amber-400/80 text-center">막 활성 — 회전 잠김</div>
                )}
              </div>
            </div>

            <div className="flex gap-1">
              <button onClick={addPlane} disabled={planes.length>=20}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 text-white rounded cursor-pointer text-xs">
                + 평면 추가
              </button>
              <button onClick={() => { const next = !pickingNormal; setPickingNormal(next); pickingNormalRef.current = next; if (!next) clearDepth(); }}
                disabled={depthLoading}
                className={`px-3 py-1.5 ${depthLoading ? 'bg-gray-500 text-gray-300 cursor-wait' : pickingNormal ? 'bg-yellow-500 hover:bg-yellow-400 text-black' : 'bg-purple-600 hover:bg-purple-500 text-white'} rounded cursor-pointer text-xs`}>
                {depthLoading ? 'Depth 분석중...' : pickingNormal ? '점을 클릭...' : '법선 생성 (Depth)'}
              </button>
            </div>
            {planes.length > 0 && (
              <div className="flex flex-col gap-1 mt-1">
                {planes.map((_,i) => (
                  <div key={i} onClick={() => {const n=i===selectedPlane?-1:i; setSelectedPlane(n); selectedPlaneRef.current=n;}}
                    className={`px-2 py-1.5 rounded cursor-pointer flex justify-between items-center ${i===selectedPlane?'bg-white/10 border border-white/40':'bg-gray-800/50 border border-transparent hover:bg-gray-700/50'}`}>
                    <span>평면 {i+1}</span>
                    <button onClick={(e)=>{e.stopPropagation();setSelectedPlane(-1);selectedPlaneRef.current=-1;planesRef.current=planesRef.current.filter((_,j)=>j!==i);syncPlanes();setTimeout(recomputePlanes,0);}}
                      className="text-red-400 hover:text-red-300 px-1 cursor-pointer">✕</button>
                  </div>
                ))}
              </div>
            )}
            {toolMode !== 'none' && selectedPlane >= 0 && (
              <div className={`px-2 py-1 rounded text-center font-bold ${toolMode==='translate'?'bg-yellow-600/30 text-yellow-300':'bg-purple-600/30 text-purple-300'}`}>
                {toolMode==='translate'?'이동 모드 (T)':'회전 모드 (R)'}
              </div>
            )}
            <div className="text-[10px] text-gray-500 leading-relaxed">
              좌클릭: 평면 선택 | T+드래그: 이동 | R+드래그: 회전
            </div>
            {planes.length > 0 && (
              <div className="border-t border-gray-600 pt-2 mt-1">
                <div className="mb-1">{closed?<span className="text-red-400 font-bold">폐공간 완성</span>:<span className="text-gray-400">폐공간 미완성</span>}</div>
                <div className="text-gray-400">
                  유지: <span className="text-green-400 font-bold">{(totalCount-outsideCount).toLocaleString()}</span>
                  {' '}삭제: <span className="text-red-400 font-bold">{outsideCount.toLocaleString()}</span>
                  {' '}/ {totalCount.toLocaleString()}
                </div>
              </div>
            )}
            {planes.length > 0 && (
              <>
                <button onClick={applyPlaneRefine} className="mt-1 px-3 py-2 bg-red-600 hover:bg-red-500 text-white rounded cursor-pointer font-bold text-xs">
                  다듬기 실행
                </button>
              </>
            )}
          </>
        )}

        {/* ── Brush controls ── */}
        {refineMode === 'brush' && (
          <>
            <div className="flex gap-1">
              <button onClick={()=>setPaintMode('union')} className={`px-2 py-0.5 rounded cursor-pointer ${paintMode==='union'?'bg-green-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>+ 합집합</button>
              <button onClick={()=>setPaintMode('diff')} className={`px-2 py-0.5 rounded cursor-pointer ${paintMode==='diff'?'bg-red-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>- 차집합</button>
            </div>
            <div className="flex items-center gap-2">
              <span>크기</span>
              <input type="range" min="5" max="150" step="1" value={brushSize} onChange={e=>setBrushSize(Number(e.target.value))} className="w-24 h-1 accent-blue-500 cursor-pointer" />
              <div className="flex items-center justify-center" style={{width:36,height:36}}>
                <div className="rounded-full border border-red-400/60" style={{width:Math.min(brushSize,32),height:Math.min(brushSize,32)}} />
              </div>
            </div>
            <div className="border-t border-gray-600 pt-2 mt-1">
              <div className="mb-1.5">선택: <span className="text-red-400 font-bold">{selectionCount.toLocaleString()}</span> / {totalCount.toLocaleString()}</div>
              <div className="flex gap-1 flex-wrap">
                <button onClick={undo} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded cursor-pointer">Undo</button>
                <button onClick={invertSelection} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded cursor-pointer">반전</button>
                <button onClick={clearSelection} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded cursor-pointer">초기화</button>
              </div>
            </div>
            {selectionCount > 0 && (
              <button onClick={deleteSelected} className="mt-1 px-3 py-2 bg-red-600 hover:bg-red-500 text-white rounded cursor-pointer font-bold text-xs">
                선택 삭제 (Delete)
              </button>
            )}
          </>
        )}

        {/* ── BBox controls ── */}
        {refineMode === 'bbox' && (
          <>
            <div className="text-[10px] text-gray-400">좌클릭+드래그: 면을 잡아서 크기 조절</div>
            <div className="text-[10px] text-gray-500 font-mono">
              X: [{selBboxMin[0].toFixed(1)}, {selBboxMax[0].toFixed(1)}]<br/>
              Y: [{selBboxMin[1].toFixed(1)}, {selBboxMax[1].toFixed(1)}]<br/>
              Z: [{selBboxMin[2].toFixed(1)}, {selBboxMax[2].toFixed(1)}]
            </div>
            <div className="border-t border-gray-600 pt-2 mt-1">
              <div className="mb-1.5">선택: <span className="text-red-400 font-bold">{selectionCount.toLocaleString()}</span> / {totalCount.toLocaleString()}</div>
              <div className="flex gap-1">
                <button onClick={undo} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded cursor-pointer">Undo</button>
                <button onClick={clearSelection} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded cursor-pointer">초기화</button>
              </div>
            </div>
            {selectionCount > 0 && (
              <button onClick={deleteSelected} className="mt-1 px-3 py-2 bg-red-600 hover:bg-red-500 text-white rounded cursor-pointer font-bold text-xs">
                선택 삭제 (Delete)
              </button>
            )}
          </>
        )}

        {/* Save — 서버 업로드 기반(uploadId) 또는 외부 업로드 핸들러 둘 다 지원 */}
        {(options?.uploadId || options?.onRequestUpload) && dirty && (
          saved ? (
            <div className="mt-2 px-3 py-2 bg-green-800/50 text-green-300 rounded text-xs text-center font-bold">
              저장 완료
            </div>
          ) : (
            <button onClick={saveRefined} disabled={saving}
              className="mt-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-600 text-white rounded cursor-pointer font-bold text-xs">
              {saving ? '저장 중...' : '정제 결과 저장'}
            </button>
          )
        )}

        {/* Undo / Reset (공통) */}
        <div className="mt-1 flex gap-1">
          <button
            onClick={undoLast}
            disabled={undoDepth === 0}
            className="flex-1 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded cursor-pointer disabled:cursor-not-allowed text-xs"
            title="마지막 파괴적 작업(회전/바깥 제거/막 씌우기) 되돌리기"
          >
            되돌리기 {undoDepth > 0 ? `(${undoDepth})` : ''}
          </button>
          <button onClick={resetAll} className="flex-1 px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded cursor-pointer text-xs">
            전체 리셋
          </button>
        </div>
      </div>

      {/* Ceiling/Floor Modal */}
      {cfModalOpen && splatDataRef.current && (
        <Suspense fallback={null}>
          <CeilingFloorModal
            posX={splatDataRef.current.posX}
            posY={splatDataRef.current.posY}
            posZ={splatDataRef.current.posZ}
            numSplats={splatDataRef.current.numSplats}
            initialCeiling={cfMode !== 'none' ? ceilingY : null}
            initialFloor={cfMode !== 'none' ? floorY : null}
            initialRotX={pendingRotation.rotX}
            initialRotZ={pendingRotation.rotZ}
            onConfirm={async (lo, hi, rotX, rotZ) => {
              // modal: lo = 작은 Y (바닥), hi = 큰 Y (천장)
              // rotX/rotZ는 raw posX/Y/Z에 적용될 절대 회전 (모달이 항상 raw에서 시작).
              // 우리는 이를 곧 새로운 절대 pendingRotation으로 본다 (composition 회피).
              const c = hi, f = lo;

              const newRot = { rotX, rotZ };
              const oldRot = pendingRotationRef.current;
              const rotChanged = (newRot.rotX !== oldRot.rotX) || (newRot.rotZ !== oldRot.rotZ);

              // 옵션 A — 막이 이미 만들어졌다면 회전 lock
              if (rotChanged && cfRotationLockedRef.current) {
                alert('막이 이미 생성되어 회전을 적용할 수 없습니다. 회전을 더 하려면 막을 먼저 되돌려 주세요.');
              } else if (rotChanged) {
                pushOp({ type: 'rotation', prevRotation: { ...oldRot } });
                pendingRotationRef.current = newRot;
                setPendingRotation(newRot);
                applyEntityRotation();
                dirtyRef.current = true; setDirty(true);
                setSaved(false);
              }

              // 회전 변경 후 flatten 마스크 / 벽 정의 무효화 (이전 회전 프레임 기준이라 stale).
              if (rotChanged) {
                if (flattenMaskRef.current) {
                  flattenMaskRef.current = null;
                  flattenActiveRef.current = false; setFlattenActive(false);
                  paintFlattenMask();
                }
                if (wallModeRef.current === 'confirmed') {
                  setWallMode('none'); wallModeRef.current = 'none';
                  setWallAngle(null); wallAngleRef.current = null;
                  setWallDistances(null); wallDistancesRef.current = null;
                }
              }

              setCeilingY(c); setFloorY(f);
              ceilingYRef.current = c; floorYRef.current = f;
              setCfMode('confirmed'); cfModeRef.current = 'confirmed';
              setCfModalOpen(false);
              setSelectedSurfaces(prevSel => {
                const next = new Set(prevSel);
                CF_SURFACES.forEach(s => next.add(s));
                return next;
              });
            }}
            onClose={() => setCfModalOpen(false)}
          />
        </Suspense>
      )}

      {/* Wall Modal — pendingRotation 적용된 좌표를 넘겨 A' 프레임에서 작업하도록 */}
      {wallModalOpen && splatDataRef.current && cfMode === 'confirmed' && (() => {
        const rp = buildRotatedPositions(
          splatDataRef.current.posX,
          splatDataRef.current.posY,
          splatDataRef.current.posZ,
        );
        return (
        <Suspense fallback={null}>
          <WallModal
            posX={rp.x}
            posY={rp.y}
            posZ={rp.z}
            numSplats={splatDataRef.current.numSplats}
            ceilingY={ceilingY}
            floorY={floorY}
            initialAngle={wallAngle}
            initialWalls={wallDistances}
            onConfirm={(angleDeg, walls) => {
              setWallAngle(angleDeg); wallAngleRef.current = angleDeg;
              setWallDistances(walls); wallDistancesRef.current = walls;
              setWallMode('confirmed'); wallModeRef.current = 'confirmed';
              setWallModalOpen(false);
              setSelectedSurfaces(prev => {
                const next = new Set(prev);
                WALL_SURFACES.forEach(s => next.add(s));
                return next;
              });
            }}
            onClose={() => setWallModalOpen(false)}
          />
        </Suspense>
        );
      })()}
    </>
  ) : null;

  return { ui, onSplatLoaded, planes };
}
