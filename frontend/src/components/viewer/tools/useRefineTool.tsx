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
type RefineMode = 'plane' | 'brush' | 'bbox' | 'rect' | 'transparent';
type PaintMode = 'union' | 'intersect' | 'diff';
type SelectSubMode = 'brush' | 'bbox' | 'rect';
const SELECT_SUB_MODES: ReadonlyArray<SelectSubMode> = ['brush', 'bbox', 'rect'];
const isSelectMode = (m: RefineMode): m is SelectSubMode => (SELECT_SUB_MODES as readonly string[]).includes(m);

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

interface SaveMetadata {
  building_id: string;
  floor_id: string;
  module_id: string;
  building_name?: string;
  floor_number?: number;
  module_name?: string;
  /** SAM3 프롬프트 팝업의 자유 텍스트 (현재는 메타데이터 모달 외부에서 별도 수집). */
  sam_prompt?: string;
  /** 로컬 파일에서 시작했을 때 register-local 로 새로 생성된 upload_id. */
  upload_id?: string;
}

interface RefineToolOptions {
  uploadId?: string;
  // 다듬기가 베이스로 삼는 원본 PLY URL — ensureOriginalScene 에서 fetch&parse.
  currentUrl?: string;
  // resetAll 에서 새 URL로 SplatViewerCore in-place reload.
  reloadWithUrl?: (url: string) => void;
  // 사용자에게 보여주는 파일명 (이미 'refined_' prefix 가 붙어있을 수도 있음 — 이중 prefix 방지용으로 strip).
  // 저장 시 MinIO key 의 파일명에 사용: `refined_<원본>.ply`.
  originalFilename?: string;
  // 저장 성공 후 postSaveModal '예' 선택 시 호출. UnifiedSplatEditor 내부에서 mode='align' 으로 전환.
  // 미지정이면 '예' 버튼은 모달만 닫고 아무 일도 안 함.
  onSwitchToAlign?: () => void;
  // 저장 클릭 시 호출 — 외부에서 메타데이터 입력 모달을 띄우고 결과 반환.
  // 항상 호출되며, 받은 building/floor/module 로 새 upload 를 등록한 뒤 PLY+sidecar 를 그 위에 PUT.
  // reject 되면 저장 흐름 취소.
  onRequestMetadata?: () => Promise<SaveMetadata>;
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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // 다듬기 완료 → 문 설정 (SAM3 프롬프트 팝업) → 문 설정 완료에서 일괄 영속.
  // 진행 중 전체 화면 오버레이 (업로드 단계 가시화).
  const [uploadProgressOpen, setUploadProgressOpen] = useState(false);
  const [uploadProgressMessage, setUploadProgressMessage] = useState('');
  // 단일 안전거리 — 모든 경계면(천장/바닥/4벽)이 공유
  // 외부 splat 제거 임계값 (m). 0 이면 평면(sd=0) 보다 바깥(sd>0)인 모든 splat 을 제거.
  // 사용자가 추가 안전거리 (e.g., 평면이 약간 부정확할 때 일부 보호) 원하면 양수 값으로 미세 조정.
  const [globalOffset, setGlobalOffset] = useState(0);
  const [globalOffsetText, setGlobalOffsetText] = useState('0');
  // shell 마스크 계산용 (모든 면 동일 globalOffset)
  const surfaceOffsets: Record<Surface, number> = {
    ceiling: globalOffset, floor: globalOffset, w1a: globalOffset, w1b: globalOffset, w2a: globalOffset, w2b: globalOffset,
  };

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

  // floater 마스크: 1=삭제(저불투명 + 희소 가우시안). 모듈 외부 제거(flatten) 활성 상태에서만 적용 가능.
  // excludeMask = brush 삭제 ∪ flatten 마스크 — 이 둘로 가린 상태에서 남은 가우시안만 후보.
  const floaterMaskRef = useRef<Uint8Array | null>(null);
  const [floaterActive, setFloaterActive] = useState(false);
  const floaterActiveRef = useRef(false);
  const [floatering, setFloatering] = useState(false);
  const [floaterVoxelSize, setFloaterVoxelSize] = useState(0.05);
  const [floaterOpacityCut, setFloaterOpacityCut] = useState(0.1);
  const [floaterMinNeighbors, setFloaterMinNeighbors] = useState(3);

  // 경계 clipping: 6 평면으로 비등방 scale 축소. center 가 안쪽인 splat 의 extent 가 평면을 넘지 않도록.
  // ON: GPU sc0/sc1/sc2 in-place 변경 + transformB 재업로드. 저장 시 cached scene 의 scale 도 같이 적용.
  // OFF: snapshot 으로 원본 scale 복원.
  const [clippingActive, setClippingActive] = useState(false);
  const clippingActiveRef = useRef(false);
  const [clipping, setClipping] = useState(false); // 처리 중 플래그
  // snapshot: clip 적용된 splat 들의 원본 log-scale (idx 별).
  const clippingSnapshotRef = useRef<Array<{ idx: number; s0: number; s1: number; s2: number }>>([]);
  // 평면 안쪽으로 끊어줄 여유 거리 (m). 사용자가 경험적으로 조절 후 적정값 찾으면 슬라이더 제거 예정.
  const [clippingEpsilon, setClippingEpsilon] = useState(0.001);

  // ── Wall mesh test (texture-baked quad mesh, MVP)
  const [wallMeshActive, setWallMeshActive] = useState(false);
  const [wallMeshBaking, setWallMeshBaking] = useState(false);
  const [wallMeshDebugWhite, setWallMeshDebugWhite] = useState(false);
  const wallMeshEntitiesRef = useRef<any[]>([]);
  // 가장 최근 베이크 결과 (디버그 다운로드 / 알파 그리드 진단 / 영속화용)
  const lastBakesRef = useRef<Map<string, {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    input: import('@/lib/gs/textureBake').PlaneBakeInput;
    corners: import('@/lib/gs/textureBake').TextureBakeResult['corners'];
    uvs: import('@/lib/gs/textureBake').TextureBakeResult['uvs'];
  }>>(new Map());

  // 알파 그리드 진단
  const [alphaGridActive, setAlphaGridActive] = useState(false);
  const alphaGridEntityRef = useRef<any>(null);

  // 디버그: 원본 splat 엔티티 숨기기 (메시 단독 확인용)
  const [splatHidden, setSplatHidden] = useState(false);

  // 안전거리 실시간 미리보기 — 토글 ON 시 globalOffset / selectedSurfaces 변할 때마다
  // 삭제될 가우시안을 즉시 투명 처리 (paintFlattenMask 재활용, 별도 preview 마스크).
  const [flattenPreviewActive, setFlattenPreviewActive] = useState(false);
  const flattenPreviewActiveRef = useRef(false);
  const flattenPreviewMaskRef = useRef<Uint8Array | null>(null);

  // ── 안전거리 시각화 (화살표) ──
  const [safetyVizActive, setSafetyVizActive] = useState(false);
  // depthGate (방 안쪽 alpha blending start 경계). 사용자가 모달에서 정의한 경계면(sd=0) 에서 시작 →
  // 막 위치 (MESH_PLANE_INSET=0) 와 정확히 일치 → "층 두 개" 잔상 제거. 0 으로 고정.
  const bakeInnerGate = 0;
  const safetyVizEntityRef = useRef<any>(null);

  // 옵션 A: 막 생성 후 CF 모달의 회전 슬라이더 lock

  // 통합 undo 히스토리 (시간순 단일 스택)
  type OpRecord =
    | { type: 'rotation'; prevRotation: { rotX: number; rotZ: number } }
    | { type: 'flatten'; prevMask: Uint8Array | null; prevActive: boolean }
    | { type: 'floater'; prevMask: Uint8Array | null; prevActive: boolean }
    | { type: 'clipping'; prevSnapshot: Array<{ idx: number; s0: number; s1: number; s2: number }>; prevActive: boolean }
    | { type: 'wallMesh'; prevEntities: any[]; prevActive: boolean };
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
    // preview: 빨강으로 표시 (alpha 유지). applied: alpha=0 (실제 삭제 시각화).
    // 둘 다 켜져있으면 preview가 우선.
    const previewMask = flattenPreviewActiveRef.current ? flattenPreviewMaskRef.current : null;
    const appliedMask = (flattenActiveRef.current && flattenVisibleRef.current) ? flattenMaskRef.current : null;
    const floaterMask = floaterActiveRef.current ? floaterMaskRef.current : null;
    // 빨강 (R=1, G=0, B=0)
    const redR = f2h(1.0), redG = f2h(0.0), redB = f2h(0.0);
    for (let i = 0; i < data.numSplats; i++) {
      const idx = i * 4;
      if (previewMask && previewMask[i]) {
        // 삭제될 가우시안 미리보기 — 빨강 + 원본 alpha 유지
        td[idx]   = redR;
        td[idx+1] = redG;
        td[idx+2] = redB;
        td[idx+3] = data.origColorData[idx+3];
      } else if (appliedMask && appliedMask[i]) {
        // 실제 적용된 flatten — alpha=0으로 가림
        td[idx]   = data.origColorData[idx];
        td[idx+1] = data.origColorData[idx+1];
        td[idx+2] = data.origColorData[idx+2];
        td[idx+3] = f2h(0);
      } else if (floaterMask && floaterMask[i]) {
        // floater 삭제 — alpha=0
        td[idx]   = data.origColorData[idx];
        td[idx+1] = data.origColorData[idx+1];
        td[idx+2] = data.origColorData[idx+2];
        td[idx+3] = f2h(0);
      } else {
        td[idx]   = data.origColorData[idx];
        td[idx+1] = data.origColorData[idx+1];
        td[idx+2] = data.origColorData[idx+2];
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


  // 원본 splat 엔티티 가리기 (디버그)
  useEffect(() => {
    const data = coreRef.current?.getSplatData();
    if (!data?.splatEntity) return;
    data.splatEntity.enabled = !splatHidden;
    return () => {
      // 언마운트 시 복구
      if (data.splatEntity) data.splatEntity.enabled = true;
    };
  }, [splatHidden, coreRef]);

  // ── 안전거리 / 알파블렌딩 시작 위치 화살표 시각화 ──
  // 토글 ON + wallMode confirmed (방 기하 확정) 일 때만 그림.
  // globalOffset / pendingRotation 변할 때마다 재생성.
  useEffect(() => {
    const core = coreRef.current;
    const app = core?.getApp();
    const pc = core?.getPC();
    if (!app || !pc) return;

    // 항상 이전 엔티티 정리 후 다시 생성
    const cleanup = () => {
      if (safetyVizEntityRef.current) {
        try { safetyVizEntityRef.current.destroy(); } catch {}
        safetyVizEntityRef.current = null;
      }
    };
    cleanup();

    const wallReady = wallMode === 'confirmed' && wallAngle !== null && wallDistances !== null;
    const cfReady = cfMode === 'confirmed';
    if (!wallReady || !cfReady) return;
    if (!safetyVizActive) return;

    let cancelled = false;
    (async () => {
      const { createOffsetArrows } = await import('@/lib/gs/safetyArrows');
      if (cancelled) return;
      const room = {
        angleDeg: wallAngle!,
        walls: wallDistances! as [number, number, number, number],
        ceilingY,
        floorY,
      };
      const ent = createOffsetArrows(pc, room, globalOffset, {
        direction: 'both',
        name: 'safetyArrows',
      });
      app.root.addChild(ent);
      safetyVizEntityRef.current = ent;
    })();

    return () => { cancelled = true; cleanup(); };
  }, [
    safetyVizActive, globalOffset,
    wallMode, wallAngle, wallDistances, cfMode, ceilingY, floorY,
    coreRef,
  ]);

  // ── 안전거리 실시간 미리보기: globalOffset/selectedSurfaces 변할 때마다 마스크 재계산 + 페인트 ──
  useEffect(() => {
    if (!flattenPreviewActive) {
      // 끄기 — 마스크 비우고 paint 한번 (applied 마스크 / 원본 복원)
      flattenPreviewActiveRef.current = false;
      flattenPreviewMaskRef.current = null;
      paintFlattenMask();
      return;
    }
    flattenPreviewActiveRef.current = true;

    const data = splatDataRef.current;
    if (!data) return;
    if (selectedSurfaces.size === 0) {
      // 면 미선택 — 빈 마스크 (아무것도 가림 없음)
      flattenPreviewMaskRef.current = new Uint8Array(data.numSplats);
      paintFlattenMask();
      return;
    }
    const hasWall = Array.from(selectedSurfaces).some(s => WALL_SURFACES.includes(s));
    if (hasWall && (wallAngle === null || !wallDistances)) return;

    let cancelled = false;
    (async () => {
      const { surfacePlanesFromRoom, signedDistance } = await import('@/lib/gs/planes');
      if (cancelled) return;

      const allPlanes = surfacePlanesFromRoom({
        angleDeg: wallAngle ?? 0,
        walls: (wallDistances ?? [0, 0, 0, 0]) as [number, number, number, number],
        ceilingY, floorY,
      });
      const planes = allPlanes.filter(p => selectedSurfaces.has(p.id as Surface));
      // 평면(sd=0) 바깥(sd > globalOffset) 인 splat 을 kill. globalOffset=0 이면 sd>0 모든 외부 splat.
      // (이전 버전의 nearProtect=3cm hardcoded floor 제거 — 평면 본체 보호는 splat 위치 자체가 sd≤0
      //  영역에 모여있어 자연스럽게 보장됨.)
      const cutThreshold = globalOffset;

      const rotPos = buildRotatedPositions(data.posX, data.posY, data.posZ);
      const N = data.numSplats;
      const mask = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        const x = rotPos.x[i], y = rotPos.y[i], z = rotPos.z[i];
        for (const p of planes) {
          const sd = signedDistance(p, x, y, z);
          if (sd > cutThreshold) { mask[i] = 1; break; }
        }
      }
      if (cancelled) return;
      flattenPreviewMaskRef.current = mask;
      paintFlattenMask();
    })();

    return () => { cancelled = true; };
  }, [
    flattenPreviewActive, globalOffset, selectedSurfaces,
    wallAngle, wallDistances, ceilingY, floorY,
    buildRotatedPositions, paintFlattenMask,
  ]);

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
      // floater 는 flatten 위에서만 의미 있어서 같이 해제
      if (floaterActiveRef.current) {
        pushOp({
          type: 'floater',
          prevMask: floaterMaskRef.current ? new Uint8Array(floaterMaskRef.current) : null,
          prevActive: true,
        });
        floaterActiveRef.current = false; setFloaterActive(false);
        floaterMaskRef.current = null;
      }
      paintFlattenMask();
      // 마스크 자체는 보관해 둘 수도 있지만, 다음 클릭에서 어차피 재계산하므로 비움 → 의도 명확화
      flattenMaskRef.current = null;
      // dirty/op 히스토리는 그대로. 토글 자체도 히스토리에 남음.
      setSaved(false);
      const stillDirty = opHistoryRef.current.length > 0
        || pendingRotationRef.current.rotX !== 0
        || pendingRotationRef.current.rotZ !== 0
        || flattenActiveRef.current;
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
      // 평면(sd=0) 바깥 (sd > globalOffset) 인 splat 을 kill. globalOffset=0 이면 sd>0 모든 외부 splat.
      const cutThreshold = globalOffset;

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
          if (sd > cutThreshold) {
            outside = true;
            killByPlane[p.id]++;
            break;
          }
        }
        if (outside) { newMask[i] = 1; deletedCount++; }
      }
      console.log(`[Shell] flatten mask: ${deletedCount} / ${N} gaussians`);
      console.log('[Shell] kill-by-plane:', killByPlane);
      console.log('[Shell] params:', { cutThreshold, pendingRot: pendingRotationRef.current });

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

  // ── applyClipping: 토글식 — 비등방 scale 축소로 가우시안 extent 가 6 평면을 넘지 않게.
  // ON: 평면별 g_i² = 1 - a_in² (1 - f²), f = |sd|/ext. axis 별 min(g²) 적용.
  //     GPU sc0/1/2 prop in-place 변경 + transformB 재업로드. 원본 log-scale snapshot 보관.
  // OFF: snapshot 으로 복원.
  // 저장 시 (`commitRefinedToServer` 안): clippingActive 면 cached scene 의 scale 에도 적용.
  const applyClipping = useCallback(async () => {
    const data = splatDataRef.current;
    const core = coreRef.current;
    if (!data || !core) return;
    const float2Half = core.float2Half;
    const liveSc0 = data.gsplatData?.getProp('scale_0') as Float32Array | undefined;
    const liveSc1 = data.gsplatData?.getProp('scale_1') as Float32Array | undefined;
    const liveSc2 = data.gsplatData?.getProp('scale_2') as Float32Array | undefined;
    if (!liveSc0 || !liveSc1 || !liveSc2) { alert('가우시안 scale 속성을 찾을 수 없습니다.'); return; }

    setClipping(true);
    try {
      // OFF (현재 ON) → 원복: live + cached 둘 다 snapshot 으로 되돌림.
      if (clippingActiveRef.current) {
        const snap = clippingSnapshotRef.current;
        const cached = originalSceneRef.current;
        const cs0 = cached?.attrs.get('scale_0') as Float32Array | undefined;
        const cs1 = cached?.attrs.get('scale_1') as Float32Array | undefined;
        const cs2 = cached?.attrs.get('scale_2') as Float32Array | undefined;
        for (const s of snap) {
          liveSc0[s.idx] = s.s0; liveSc1[s.idx] = s.s1; liveSc2[s.idx] = s.s2;
          if (cs0 && cs1 && cs2) {
            cs0[s.idx] = s.s0; cs1[s.idx] = s.s1; cs2[s.idx] = s.s2;
          }
        }
        const { syncScalesGPU } = await import('./gpuSync');
        syncScalesGPU(snap.map(s => s.idx), data, float2Half);
        clippingSnapshotRef.current = [];
        clippingActiveRef.current = false;
        setClippingActive(false);
        return;
      }

      // ON → clip 계산 + 적용.
      const wallReady = wallMode === 'confirmed' && wallAngleRef.current !== null && wallDistancesRef.current !== null;
      const cfReady = cfMode === 'confirmed';
      if (!wallReady || !cfReady) {
        alert('천장/바닥 + 벽 4면을 먼저 확정하세요.');
        return;
      }

      const { surfacePlanesFromRoom } = await import('@/lib/gs/planes');
      const planes = surfacePlanesFromRoom({
        angleDeg: wallAngleRef.current!,
        walls: wallDistancesRef.current! as [number, number, number, number],
        ceilingY: ceilingYRef.current,
        floorY: floorYRef.current,
      });

      // 평면은 A' 프레임 (CF/Wall 모달이 정의). 따라서 splat 의 위치/회전도 A' 프레임으로 변환해야 일관.
      // buildRotatedScene 은 cached scene 을 복제해 x/y/z + rot_* 를 A' 로 회전. scale_* 는 reference 공유
      // (frame 무관하게 local-axis 에 정의된 양이라 회전 영향 없음 → clip 결과 그대로 cached 에 적용 가능).
      const cached = await ensureOriginalScene();
      const rotated = await buildRotatedScene(cached);
      const { computeBoundaryClipping } = await import('@/lib/gs/clipping');
      const updates = computeBoundaryClipping(rotated, planes, { epsilon: clippingEpsilon });
      console.log(`[Clipping] ${updates.length} / ${cached.numSplats} splats clipped.`);

      const cs0 = cached.attrs.get('scale_0') as Float32Array;
      const cs1 = cached.attrs.get('scale_1') as Float32Array;
      const cs2 = cached.attrs.get('scale_2') as Float32Array;

      // snapshot — cached / live 둘 다 동일 origin (PLY parse 결과) 이므로 한쪽 값만 보관.
      const snap: Array<{ idx: number; s0: number; s1: number; s2: number }> = [];
      for (const u of updates) {
        snap.push({ idx: u.idx, s0: u.origLogScale[0], s1: u.origLogScale[1], s2: u.origLogScale[2] });
        // cached scene → 저장 시 PLY 에 baked in.
        cs0[u.idx] = u.newLogScale[0]; cs1[u.idx] = u.newLogScale[1]; cs2[u.idx] = u.newLogScale[2];
        // live PC gsplat data → 즉시 시각 반영.
        liveSc0[u.idx] = u.newLogScale[0]; liveSc1[u.idx] = u.newLogScale[1]; liveSc2[u.idx] = u.newLogScale[2];
      }
      const { syncScalesGPU } = await import('./gpuSync');
      syncScalesGPU(updates.map(u => u.idx), data, float2Half);
      // undo 기록 — 이전 상태 (clipping 비활성).
      pushOp({ type: 'clipping', prevSnapshot: [], prevActive: false });
      clippingSnapshotRef.current = snap;
      clippingActiveRef.current = true;
      setClippingActive(true);
      dirtyRef.current = true; setDirty(true);
      setSaved(false);
    } catch (e: any) {
      alert(`clipping 처리 실패: ${e?.message ?? e}`);
    } finally {
      setClipping(false);
    }
  }, [coreRef, ensureOriginalScene, buildRotatedScene, wallMode, cfMode, clippingEpsilon, pushOp]);

  // ── applyFloater: 토글식. flatten(모듈 외부 제거) 활성 상태일 때만 호출 가능.
  // brush 삭제 ∪ flatten 마스크 = excludeMask. 남은 가우시안에 대해 voxel 카운트 + opacity 컷으로 floater 검출.
  const applyFloater = useCallback(async () => {
    // 활성 → 복원
    if (floaterActiveRef.current) {
      pushOp({
        type: 'floater',
        prevMask: floaterMaskRef.current ? new Uint8Array(floaterMaskRef.current) : null,
        prevActive: true,
      });
      floaterActiveRef.current = false; setFloaterActive(false);
      floaterMaskRef.current = null;
      paintFlattenMask();
      setSaved(false);
      const stillDirty = opHistoryRef.current.length > 0
        || pendingRotationRef.current.rotX !== 0
        || pendingRotationRef.current.rotZ !== 0
        || flattenActiveRef.current
        || floaterActiveRef.current;
      dirtyRef.current = stillDirty; setDirty(stillDirty);
      return;
    }

    if (!flattenActiveRef.current) {
      alert('먼저 "모듈 외부 제거" 를 적용해주세요. floater 는 그 이후 남은 가우시안 중에서만 찾습니다.');
      return;
    }

    const data = splatDataRef.current;
    const core = coreRef.current;
    if (!data) return;

    setFloatering(true);
    try {
      const { detectFloaters } = await import('@/lib/gs/floaters');

      const N = data.numSplats;
      // excludeMask = brush 삭제 (origColorData alpha=0) ∪ flatten 마스크
      const exclude = new Uint8Array(N);
      if (data.origColorData && core) {
        const h2f = core.half2Float;
        for (let i = 0; i < N; i++) {
          const a = h2f(data.origColorData[i * 4 + 3]);
          if (a < 1e-3) exclude[i] = 1;
        }
      }
      if (flattenMaskRef.current) {
        for (let i = 0; i < N; i++) if (flattenMaskRef.current[i]) exclude[i] = 1;
      }

      // detectFloaters 의 SplatData 시그니처 — opacity 는 원본 PLY 의 logit (sigmoid 전).
      // splatDataRef 에는 'opacity' 가 없으므로 originalScene 을 fetch 해서 사용.
      const original = await ensureOriginalScene();
      if (original.numSplats !== N) {
        throw new Error(`splatData(${N}) 와 original(${original.numSplats}) 입자 수 불일치`);
      }

      const t0 = performance.now();
      const { mask, deletedCount, aliveCount } = detectFloaters(
        original,
        {
          voxelSize: floaterVoxelSize,
          opacityThreshold: floaterOpacityCut,
          minNeighbors: floaterMinNeighbors,
        },
        exclude,
      );
      const dt = performance.now() - t0;
      console.log(`[Floater] alive=${aliveCount}/${N}, deleted=${deletedCount}, took ${dt.toFixed(1)}ms`);
      console.log('[Floater] params:', {
        voxelSize: floaterVoxelSize,
        opacityCut: floaterOpacityCut,
        minNeighbors: floaterMinNeighbors,
      });

      pushOp({ type: 'floater', prevMask: null, prevActive: false });
      floaterMaskRef.current = mask;
      floaterActiveRef.current = true; setFloaterActive(true);
      paintFlattenMask();
      dirtyRef.current = true; setDirty(true);
      setSaved(false);
    } catch (e: any) {
      alert(`floater 검출 실패: ${e.message || e}`);
    } finally {
      setFloatering(false);
    }
  }, [floaterVoxelSize, floaterOpacityCut, floaterMinNeighbors, ensureOriginalScene, paintFlattenMask, pushOp]);

  // ── Wall mesh test (MVP): 선택된 면을 텍스처 메시로 굽고 splat entity child로 추가
  const bakeWallMeshTest = useCallback(async () => {
    // 기존 메시는 항상 먼저 제거하고 (만약 면이 선택돼있으면) 새로 베이크.
    // 면이 0개면 그냥 제거만 (토글 OFF).
    if (wallMeshEntitiesRef.current.length > 0) {
      for (const e of wallMeshEntitiesRef.current) { try { e.destroy(); } catch { /* ignore */ } }
      wallMeshEntitiesRef.current = [];
      setWallMeshActive(false);
      if (selectedSurfaces.size === 0) return; // 제거만 하고 끝
      // 그 외엔 fall through 해서 새로 베이크
    }
    if (selectedSurfaces.size === 0) { alert('테스트할 면을 하나 이상 선택하세요.'); return; }
    const hasCF = Array.from(selectedSurfaces).some(s => CF_SURFACES.includes(s));
    // 벽 거리는 천장/바닥 막의 가로/세로 범위 산정에도 쓰이므로 어떤 면이든 벽면 설정이 확정돼야 함.
    if (wallAngleRef.current === null || !wallDistancesRef.current) { alert('벽면 (X/Z) 설정이 먼저 확정돼야 합니다.'); return; }
    if (hasCF && cfModeRef.current !== 'confirmed') { alert('천장/바닥 정보가 확정되지 않았습니다.'); return; }

    setWallMeshBaking(true);
    try {
      const { bakeTextureForPlane, planeBakeInputForSurface, MESH_PLANE_INSET } = await import('@/lib/gs/textureBake');
      const { createWallMeshEntity } = await import('@/lib/gs/wallMesh');
      const { filterScene } = await import('@/lib/ply');

      // 텍스처 굽기에 사용할 source scene 구성:
      //  - flatten(모듈 외부 제거) 마스크: ❌ 미적용 (depthGate가 표면 근방만 채택하므로 외부 floater 영향 X)
      //  - 브러시/bbox 삭제: ✅ 적용 (origColorData alpha=0으로 누적돼 있음)
      const original = await ensureOriginalScene();
      const splatData0 = coreRef.current?.getSplatData();
      const core0 = coreRef.current;
      let brushFilteredOriginal = original;
      if (splatData0?.origColorData && core0 && splatData0.numSplats === original.numSplats) {
        const h2f = core0.half2Float;
        const keep = new Uint8Array(original.numSplats);
        let kept = 0;
        for (let i = 0; i < original.numSplats; i++) {
          const a = h2f(splatData0.origColorData[i * 4 + 3]);
          if (a >= 1e-3) { keep[i] = 1; kept++; }
        }
        if (kept < original.numSplats) {
          brushFilteredOriginal = filterScene(original, keep);
          console.log(`[bakeWallMeshTest] 브러시/bbox 삭제 반영: ${original.numSplats - kept} 가우시안 제거 (남은 ${kept})`);
        }
      }
      const rotated = await buildRotatedScene(brushFilteredOriginal);
      const source = rotated;

      const room = {
        angleDeg: wallAngleRef.current ?? 0,
        walls: (wallDistancesRef.current ?? [0, 0, 0, 0]) as [number, number, number, number],
        ceilingY: ceilingYRef.current,
        floorY: floorYRef.current,
      };

      const core = coreRef.current;
      const splatData = core?.getSplatData();
      const app = core?.getApp();
      const pc = core?.getPC();
      if (!app || !pc || !splatData?.splatEntity) {
        alert('PlayCanvas 또는 splat entity가 초기화되지 않았습니다.');
        return;
      }

      // 메시는 6면 모두 평면(sd=0) 에서 법선 방향(=방 바깥) 으로 MESH_PLANE_INSET (1mm) 들여놓음.
      // planeBakeInputForSurface 안의 extend* 도 같은 상수에서 파생 → 직육면체 코너 자동 정합.
      console.log(`[bakeWallMeshTest] mesh inset: ${(MESH_PLANE_INSET * 1000).toFixed(1)}mm (모든 면 동일)`);

      lastBakesRef.current.clear();
      console.log(`[bakeWallMeshTest] CLICK — bakeInnerGate=${bakeInnerGate} (slider value at button click time)`);
      for (const surfaceId of Array.from(selectedSurfaces)) {
        const input = planeBakeInputForSurface(surfaceId, room);
        console.log(`[bakeWallMeshTest] surface=${surfaceId} → calling bakeTextureForPlane with depthGate=${bakeInnerGate}`);
        // autoMargin: 0 → 사용자 경계면을 strict 하게 사용. paintSd 기반 자동 확장 비활성화.
        const bake = await bakeTextureForPlane(input, source, { depthGate: bakeInnerGate, autoMargin: 0 });
        const ent = createWallMeshEntity(
          pc, app, splatData.splatEntity, bake, `wallMesh_${surfaceId}`,
          { solidWhite: wallMeshDebugWhite },
        );
        wallMeshEntitiesRef.current.push(ent);
        // 디버그: 베이크 결과 보관 (PNG 다운로드용)
        lastBakesRef.current.set(surfaceId, {
          rgba: bake.rgba, width: bake.width, height: bake.height, input: bake.input,
          corners: bake.corners, uvs: bake.uvs,
        });
      }
      // undo 기록 — 이전 상태 (막 없음).
      pushOp({ type: 'wallMesh', prevEntities: [], prevActive: false });
      setWallMeshActive(true);
      dirtyRef.current = true; setDirty(true);
      setSaved(false);
    } catch (e: any) {
      alert(`막 생성 실패: ${e.message || e}`);
    } finally {
      setWallMeshBaking(false);
    }
  }, [selectedSurfaces, surfaceOffsets, ensureOriginalScene, buildRotatedScene, coreRef, wallMeshDebugWhite, bakeInnerGate, pushOp]);

  // 가장 최근 베이크 결과를 PNG로 다운로드 (디버그)
  const downloadBakedTextures = useCallback(() => {
    const bakes = lastBakesRef.current;
    if (bakes.size === 0) { alert('베이크된 텍스처가 없습니다. 먼저 "막 생성하기" 실행.'); return; }
    const ts = Date.now();
    bakes.forEach(({ rgba, width, height }, surfaceId) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const imgData = new ImageData(new Uint8ClampedArray(rgba), width, height);
      ctx.putImageData(imgData, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bake_${surfaceId}_${ts}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 'image/png');
    });
  }, []);

  // ── 알파 그리드 진단: 50cm 간격 그리드, 베이크 텍스처에서 알파 샘플링 ──
  // 빨강(α=0) → 초록(α=1) 컬러 구. 콘솔에 모든 (surface, u, v, r, g, b, a) 덤프.
  const toggleAlphaGrid = useCallback(() => {
    // OFF
    if (alphaGridActive) {
      if (alphaGridEntityRef.current) {
        try { alphaGridEntityRef.current.destroy(); } catch {}
        alphaGridEntityRef.current = null;
      }
      setAlphaGridActive(false);
      return;
    }
    // ON
    const bakes = lastBakesRef.current;
    if (bakes.size === 0) { alert('베이크 결과가 없습니다. 먼저 "막 생성하기" 실행.'); return; }
    const core = coreRef.current;
    const app = core?.getApp();
    const pc = core?.getPC();
    if (!app || !pc) return;

    const parent = new pc.Entity('alphaGrid');
    parent.setLocalEulerAngles(0, 0, 180);

    const SPACING = 0.5; // 50cm
    const LABEL_W = 0.25; // 25cm 폭 라벨
    const LABEL_H = 0.12; // 12cm 높이
    const rows: Array<{ surface: string; u: string; v: string; r: number; g: number; b: number; a: number }> = [];

    // canvas → texture 헬퍼. 알파 값에 따라 배경/글자색 변경.
    const makeLabelTex = (alpha: number): any => {
      const W = 256, H = 128;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d')!;
      // 배경 — 알파 0이면 빨강, 1이면 초록 (가독성용 톤)
      const bgR = Math.round((1 - alpha) * 180);
      const bgG = Math.round(alpha * 180);
      ctx.fillStyle = `rgba(${bgR}, ${bgG}, 30, 0.85)`;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, W - 4, H - 4);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 78px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(alpha.toFixed(2), W / 2, H / 2);

      const fmt = pc.PIXELFORMAT_SRGBA8 ?? pc.PIXELFORMAT_RGBA8;
      const tex = new pc.Texture(app.graphicsDevice, {
        width: W, height: H, format: fmt,
        mipmaps: false,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE,
        addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        magFilter: pc.FILTER_LINEAR,
        minFilter: pc.FILTER_LINEAR,
        name: 'alphaLabel',
      });
      // canvas → texture
      if (typeof tex.setSource === 'function') {
        tex.setSource(canvas);
      } else {
        const lvl = tex.lock();
        const imgData = ctx.getImageData(0, 0, W, H);
        lvl.set(imgData.data);
        tex.unlock();
      }
      return tex;
    };

    // dir(=면 normal의 반대, 방 안쪽) 방향이 quad의 +Z (앞면)을 향하도록 회전.
    // PlayCanvas plane primitive: XZ 평면, normal=+Y. 우리는 XY 평면+normal=+Z 가 필요.
    // 대신 자체 quad mesh를 만들어 normal을 +Z 로 두고 dir에 맞게 rotate.
    const makeLabelEntity = (
      world: [number, number, number],
      dirInward: [number, number, number],
      uAxis: [number, number, number],
      vAxis: [number, number, number],
      alpha: number,
      name: string,
    ): any => {
      const tex = makeLabelTex(alpha);
      const mat = new pc.StandardMaterial();
      mat.useLighting = false;
      mat.diffuse.set(0, 0, 0);
      mat.emissive.set(1, 1, 1);
      mat.emissiveMap = tex;
      mat.cull = pc.CULLFACE_NONE;
      mat.update();

      // quad: TL, TR, BR, BL  in (uAxis, vAxis) 평면
      const hw = LABEL_W / 2, hh = LABEL_H / 2;
      const positions = [
        -hw * uAxis[0] + hh * vAxis[0], -hw * uAxis[1] + hh * vAxis[1], -hw * uAxis[2] + hh * vAxis[2],
         hw * uAxis[0] + hh * vAxis[0],  hw * uAxis[1] + hh * vAxis[1],  hw * uAxis[2] + hh * vAxis[2],
         hw * uAxis[0] - hh * vAxis[0],  hw * uAxis[1] - hh * vAxis[1],  hw * uAxis[2] - hh * vAxis[2],
        -hw * uAxis[0] - hh * vAxis[0], -hw * uAxis[1] - hh * vAxis[1], -hw * uAxis[2] - hh * vAxis[2],
      ];
      const uvs = [0, 1,  1, 1,  1, 0,  0, 0];
      const normals = [
        dirInward[0], dirInward[1], dirInward[2],
        dirInward[0], dirInward[1], dirInward[2],
        dirInward[0], dirInward[1], dirInward[2],
        dirInward[0], dirInward[1], dirInward[2],
      ];
      const indices = [0, 1, 2, 0, 2, 3];

      const mesh = new pc.Mesh(app.graphicsDevice);
      mesh.setPositions(positions);
      mesh.setUvs(0, uvs);
      mesh.setNormals(normals);
      mesh.setIndices(indices);
      mesh.update();

      const meshInst = new pc.MeshInstance(mesh, mat);
      const ent = new pc.Entity(name);
      ent.addComponent('render', { meshInstances: [meshInst] });
      ent.setLocalPosition(world[0], world[1], world[2]);
      return ent;
    };

    bakes.forEach((bake, surfaceId) => {
      const inp = bake.input;
      const tpm = bake.width / (inp.uMax - inp.uMin);
      // 라벨이 표면에 너무 붙어 z-fighting 나지 않도록 살짝 안쪽으로 띄움
      const LIFT = 0.02;
      // 면 normal 의 반대 = 방 안쪽 방향 (라벨 정면이 이쪽을 향함)
      const inward: [number, number, number] = [-inp.normal[0], -inp.normal[1], -inp.normal[2]];

      // u, v 그리드 — bake 범위 내 SPACING 간격
      const us: number[] = [];
      for (let u = inp.uMin; u <= inp.uMax + 1e-6; u += SPACING) us.push(u);
      const vs: number[] = [];
      for (let v = inp.vMin; v <= inp.vMax + 1e-6; v += SPACING) vs.push(v);

      for (const u of us) {
        for (const v of vs) {
          const tx = Math.floor((u - inp.uMin) * tpm);
          const ty = Math.floor((inp.vMax - v) * tpm);
          if (tx < 0 || tx >= bake.width || ty < 0 || ty >= bake.height) continue;

          const idx = (ty * bake.width + tx) * 4;
          const rB = bake.rgba[idx], gB = bake.rgba[idx + 1], bB = bake.rgba[idx + 2], aB = bake.rgba[idx + 3];
          const alpha = aB / 255;

          const wx = inp.origin[0] + u * inp.uAxis[0] + v * inp.vAxis[0] + LIFT * inward[0];
          const wy = inp.origin[1] + u * inp.uAxis[1] + v * inp.vAxis[1] + LIFT * inward[1];
          const wz = inp.origin[2] + u * inp.uAxis[2] + v * inp.vAxis[2] + LIFT * inward[2];

          const ent = makeLabelEntity(
            [wx, wy, wz],
            inward,
            [inp.uAxis[0], inp.uAxis[1], inp.uAxis[2]],
            [inp.vAxis[0], inp.vAxis[1], inp.vAxis[2]],
            alpha,
            `lbl_${surfaceId}_${u.toFixed(2)}_${v.toFixed(2)}`,
          );
          parent.addChild(ent);

          rows.push({
            surface: surfaceId,
            u: u.toFixed(3),
            v: v.toFixed(3),
            r: rB, g: gB, b: bB, a: aB,
          });
        }
      }
    });

    app.root.addChild(parent);
    alphaGridEntityRef.current = parent;
    setAlphaGridActive(true);

    console.log(`[alphaGrid] sampled ${rows.length} grid points across ${bakes.size} surfaces (50cm spacing)`);
    console.table(rows);
    // 알파 분포 요약
    const aVals = rows.map(r => r.a / 255);
    const nZero = aVals.filter(a => a < 0.05).length;
    const nFull = aVals.filter(a => a > 0.95).length;
    const aMean = aVals.reduce((s, a) => s + a, 0) / Math.max(1, aVals.length);
    console.log(`[alphaGrid] alpha summary: mean=${aMean.toFixed(3)}, α<0.05: ${nZero}/${aVals.length}, α>0.95: ${nFull}/${aVals.length}`);
  }, [alphaGridActive, coreRef]);

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

  // Brush intersect: stroke 시작 시점 sel snapshot + 스트로크 동안 페인트된 splat 마스크.
  // 교집합 모드에서 sel = strokeBaseSel ∩ strokeMask 로 매 프레임 재계산.
  const strokeBaseSelRef = useRef<Uint8Array | null>(null);
  const strokeMaskRef = useRef<Uint8Array | null>(null);

  // 가우시안 선택/삭제 그룹의 마지막 서브모드 — 상위 탭(가우시안 선택/삭제) 클릭 시 복귀할 값.
  const lastSelectSubModeRef = useRef<SelectSubMode>('brush');

  // Rect (직사각형) tool: 화면 직사각형 드래그 → 영역 안에 투영되는 모든 splat 선택.
  const rectPreviewRef = useRef<HTMLDivElement | null>(null);

  // ── Transparent paint state (wall mesh 텍스처에 alpha=0 페인트 — 출입구/통로 등) ──
  const [transBrushMeters, setTransBrushMeters] = useState(0.1);
  const transBrushMetersRef = useRef(0.1);
  useEffect(() => { transBrushMetersRef.current = transBrushMeters; }, [transBrushMeters]);
  // 도형: 원형 브러시 (드래그 페인트) | 직사각형 (mousedown→up 으로 영역 지정)
  type TransShape = 'circle' | 'rect';
  const [transShape, setTransShape] = useState<TransShape>('circle');
  const transShapeRef = useRef<TransShape>('circle');
  useEffect(() => { transShapeRef.current = transShape; }, [transShape]);
  const transRectPreviewRef = useRef<HTMLDivElement | null>(null);

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

  // URL 변경 시 stale splatDataRef를 즉시 비워 destroyed 텍스처 참조를 막는다
  // (reloadWithUrl 후 SplatViewerCore는 unmount → 새 PLY 로드 전까지 ref가 무효)
  useEffect(() => {
    splatDataRef.current = null;
    setSplatLoaded(false);
  }, [options?.currentUrl]);

  // ── localStorage 복원: uploadId 진입 시 1회 ──
  const loadedUploadIdRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = options?.uploadId;
    if (!uid || loadedUploadIdRef.current === uid) return;
    const saved = loadRefineState(uid);
    if (!saved) { loadedUploadIdRef.current = uid; return; }

    restoringRef.current = true;
    // 천장/바닥 + pendingRotation
    if (saved.cfConfirmed) {
      setCeilingY(saved.ceilingY); setFloorY(saved.floorY);
      ceilingYRef.current = saved.ceilingY; floorYRef.current = saved.floorY;
      setCfMode('confirmed'); cfModeRef.current = 'confirmed';
      const rot = { rotX: saved.rotX ?? 0, rotZ: saved.rotZ ?? 0 };
      setPendingRotation(rot); pendingRotationRef.current = rot;
      // entity 회전도 즉시 동기화 (다음 마운트 시 splatData 가 준비되면 자동 호출되지만 안전 차원).
    }
    // 벽면
    if (saved.wallConfirmed && saved.wallAngle !== null && saved.wallDistances) {
      setWallAngle(saved.wallAngle); wallAngleRef.current = saved.wallAngle;
      setWallDistances(saved.wallDistances); wallDistancesRef.current = saved.wallDistances;
      setWallMode('confirmed'); wallModeRef.current = 'confirmed';
    }
    // 경계면 선택
    setSelectedSurfaces(new Set(saved.selectedSurfaces as Surface[]));
    setGlobalOffset(saved.globalOffset);
    setGlobalOffsetText(saved.globalOffsetText);
    // PLY 자체는 메모리에서만 다루므로 세션 간 복원 안 함. 항상 원본부터 시작.

    loadedUploadIdRef.current = uid;
    // 한 틱 뒤 복원 플래그 해제
    setTimeout(() => { restoringRef.current = false; }, 0);
  }, [options?.uploadId]);

  // ── localStorage 저장: 관련 state 변경 시마다 ──
  // uploadId 가 없는 로컬 파일도 저장 (빈 문자열 키). 문 설정 단계가 같은 키로 읽어 평면 정보 복원 가능.
  // restoringRef 가 true 인 동안 (서버 파일 로드 중) 만 skip.
  useEffect(() => {
    if (restoringRef.current) return;
    const uid = options?.uploadId ?? '';
    saveRefineState(uid, {
      cfConfirmed: cfMode === 'confirmed',
      ceilingY, floorY,
      rotX: pendingRotation.rotX, rotZ: pendingRotation.rotZ,
      wallConfirmed: wallMode === 'confirmed',
      wallAngle, wallDistances,
      selectedSurfaces: Array.from(selectedSurfaces),
      globalOffset, globalOffsetText,
    });
  }, [
    options?.uploadId, undoDepth,
    cfMode, ceilingY, floorY,
    pendingRotation.rotX, pendingRotation.rotZ,
    wallMode, wallAngle, wallDistances,
    selectedSurfaces, globalOffset, globalOffsetText,
  ]);

  const syncPlanes = useCallback(() => setPlanes([...planesRef.current]), []);

  // ── Highlight: planes ──
  const recomputePlanes = useCallback(() => {
    const data = splatDataRef.current; const core = coreRef.current;
    if (!data || !core || planesRef.current.length === 0) {
      setOutsideCount(0); setClosed(false);
      // origColorData 로 단순 복원하면 flatten 마스크 (alpha=0) 가 사라져 외부 가우시안이 다시 보임.
      // paintFlattenMask 는 base 색 + flatten 상태를 함께 복원.
      paintFlattenMask();
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
  }, [coreRef, paintFlattenMask]);

  // ── Highlight: brush/bbox selection → red ──
  // flatten 마스크가 활성이면 alpha=0 유지해서 모듈 외부 제거 효과 보존.
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
    // flatten 적용 마스크 — refreshSelection이 origColorData로 alpha 복원하면서 사라지지 않게 보존
    const previewMask = flattenPreviewActiveRef.current ? flattenPreviewMaskRef.current : null;
    const appliedMask = (flattenActiveRef.current && flattenVisibleRef.current) ? flattenMaskRef.current : null;
    const zeroAlpha = f2h(0);
    const redR = f2h(1.0), redG = f2h(0.0), redB = f2h(0.0);
    for (let i = 0; i < data.numSplats; i++) {
      const idx = i * 4;
      if (previewMask && previewMask[i]) {
        // flatten preview: 삭제될 가우시안 빨강 + alpha 유지
        td[idx] = redR; td[idx+1] = redG; td[idx+2] = redB;
        td[idx+3] = orig[idx+3];
      } else if (sel[i]) {
        // brush/bbox 선택: 빨강 톤 mix + alpha 보존 (flatten applied면 0으로 override)
        const r = h2f(orig[idx]), g = h2f(orig[idx+1]), b = h2f(orig[idx+2]);
        td[idx] = f2h(r*0.3+1.0*0.7); td[idx+1] = f2h(g*0.3+0.1*0.7); td[idx+2] = f2h(b*0.3+0.1*0.7);
        td[idx+3] = (appliedMask && appliedMask[i]) ? zeroAlpha : orig[idx+3];
      } else {
        td[idx]=orig[idx]; td[idx+1]=orig[idx+1]; td[idx+2]=orig[idx+2];
        td[idx+3] = (appliedMask && appliedMask[i]) ? zeroAlpha : orig[idx+3];
      }
    }
    try { data.colorTexture.unlock(); } catch {}
  }, [coreRef]);

  // ── Unified surface highlight: tint gaussians near selected surfaces ──
  // 컨벤션 주의: PLY 프레임 'ceiling' = 시각적 바닥, 'floor' = 시각적 천장 (180Z 회전 영향)
  // 따라서 색도 시각 의미에 맞게 swap: ceiling(=바닥)=밤색, floor(=천장)=하늘색
  const SURFACE_COLORS: Record<string, [number, number, number]> = {
    ceiling: [0.573, 0.251, 0.055], // #92400e 밤색 (시각적 바닥)
    floor:   [0.133, 0.827, 0.933], // #22d3ee 하늘색 (시각적 천장)
    w1a:     [0.063, 0.725, 0.506], // #10b981 emerald
    w1b:     [0.231, 0.510, 0.965], // #3b82f6 blue
    w2a:     [0.545, 0.361, 0.965], // #8b5cf6 violet
    w2b:     [0.518, 0.800, 0.086], // #84cc16 lime
  };
  const applySurfaceHighlight = useCallback(() => {
    const data = splatDataRef.current; const core = coreRef.current;
    if (!data?.colorTexture || !data?.origColorData || !core) return;
    const sel = selectedSurfacesRef.current;

    let td: Uint16Array | null = null;
    try { td = data.colorTexture.lock(); } catch { return; }
    if (!td) return;
    const orig = data.origColorData;
    const f2h = core.float2Half, h2f = core.half2Float;
    // flatten 마스크 — surface highlight가 alpha를 origColorData로 복원할 때 함께 보존
    const previewMask = flattenPreviewActiveRef.current ? flattenPreviewMaskRef.current : null;
    const appliedMask = (flattenActiveRef.current && flattenVisibleRef.current) ? flattenMaskRef.current : null;
    const zeroAlpha = f2h(0);
    const redR = f2h(1.0), redG = f2h(0.0), redB = f2h(0.0);
    if (sel.size === 0) {
      // 선택 없음 → 기본 (orig + flatten)
      for (let i = 0; i < data.numSplats; i++) {
        const idx = i * 4;
        if (previewMask && previewMask[i]) {
          td[idx]=redR; td[idx+1]=redG; td[idx+2]=redB; td[idx+3]=orig[idx+3];
        } else {
          td[idx]=orig[idx]; td[idx+1]=orig[idx+1]; td[idx+2]=orig[idx+2];
          td[idx+3] = (appliedMask && appliedMask[i]) ? zeroAlpha : orig[idx+3];
        }
      }
      try { data.colorTexture.unlock(); } catch {}
      return;
    }
    const mixT = 0.75;

    const cy = ceilingYRef.current, fy = floorYRef.current;
    // 색칠 밴드 = 평면 ±1cm. 시각 가이드 only — 후속 처리는 평면(sd=0) 자체를 strict 기준으로 사용.
    const bandCf = 0.01;
    const yLo = Math.min(cy, fy), yHi = Math.max(cy, fy);

    let c1 = 0, s1 = 0, c2 = 0, s2 = 0, a1 = 0, b1 = 0, a2 = 0, b2 = 0, bandWall = 0;
    const ang = wallAngleRef.current, walls = wallDistancesRef.current;
    const wallsReady = ang !== null && walls !== null;
    if (wallsReady) {
      const rad = (ang as number) * Math.PI / 180;
      c1 = Math.cos(rad); s1 = Math.sin(rad);
      c2 = Math.cos(rad + Math.PI / 2); s2 = Math.sin(rad + Math.PI / 2);
      [a1, b1, a2, b2] = walls as [number, number, number, number];
      bandWall = 0.01;
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

      // flatten preview 우선 (빨강) > surface highlight (혼합) > 기본 + flatten alpha
      if (previewMask && previewMask[i]) {
        td[idx] = redR; td[idx+1] = redG; td[idx+2] = redB; td[idx+3] = orig[idx+3];
      } else if (bestSurf) {
        const [cr, cg, cb] = SURFACE_COLORS[bestSurf];
        const r = h2f(orig[idx]), g = h2f(orig[idx+1]), b = h2f(orig[idx+2]);
        td[idx] = f2h(r*(1-mixT)+cr*mixT); td[idx+1] = f2h(g*(1-mixT)+cg*mixT); td[idx+2] = f2h(b*(1-mixT)+cb*mixT);
        td[idx+3] = (appliedMask && appliedMask[i]) ? zeroAlpha : orig[idx+3];
      } else {
        td[idx]=orig[idx]; td[idx+1]=orig[idx+1]; td[idx+2]=orig[idx+2];
        td[idx+3] = (appliedMask && appliedMask[i]) ? zeroAlpha : orig[idx+3];
      }
    }
    try { data.colorTexture.unlock(); } catch {}
  }, [coreRef, globalOffset]);

  // Sync ref + re-tint whenever selection / 안전거리 / 회전 / 평면 변할 때
  useEffect(() => {
    selectedSurfacesRef.current = selectedSurfaces;
    applySurfaceHighlight();
  }, [selectedSurfaces, applySurfaceHighlight, globalOffset, ceilingY, floorY, wallAngle, wallDistances]);

  // ── Restore original colors (mode switch) ──
  // 단순히 origColorData로 덮어쓰면 flatten 마스크(alpha=0)가 사라지므로,
  // paintFlattenMask로 base 색 + flatten 상태를 함께 복원.
  const clearHighlight = useCallback(() => {
    paintFlattenMask();
  }, [paintFlattenMask]);

  // ── Mode switch handler ──
  const switchMode = useCallback((mode: RefineMode) => {
    clearHighlight();
    setRefineMode(mode);
    refineModeRef.current = mode;
    if (isSelectMode(mode)) lastSelectSubModeRef.current = mode;
    // Reset plane gizmo state
    setToolMode('none'); toolModeRef.current = 'none'; dragRef.current = null;
    setPickingNormal(false); pickingNormalRef.current = false; normalDisplayRef.current = null; clearDepth();
    if (isSelectMode(mode)) {
      // 가우시안 선택/삭제 sub-tab — selection preview 표시.
      setTimeout(() => refreshSelection(), 0);
    } else {
      // plane / transparent — selection 클리어 후 빨간 페인트 제거.
      // 사용자 의도: 다른 탭으로 전환 시 (브러시/BBox/직사각형 선택) 빨간 페인트 풀어주기.
      if (selectionRef.current) selectionRef.current.fill(0);
      setSelectionCount(0);
      setTimeout(() => refreshSelection(), 0); // 페인트 갱신 (빨간색 제거).
      if (mode === 'plane') setTimeout(() => recomputePlanes(), 0);
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

  // ── 다듬기 완료 버튼 — 서버 통신 없음, 문 설정 단계로 transition 만. ──
  // 모든 서버 영속은 문 설정 완료 시점에 한 번에 (commitRefinedToServer + persistDoors + register-local).
  const saveRefined = useCallback(async () => {
    setSaved(true);
    options?.onSwitchToAlign?.();
  }, [options]);

  // 문 설정 완료 시점에 호출됨 — refined PLY + mesh.json + tex_*.png 일괄 업로드 + SceneOutput 등록.
  // 반환값:
  //   rotX/rotZ/wallAngleRad — PLY 에 베이크된 회전값. 호출자가 doors corners 등 다른 좌표를
  //     같은 프레임으로 정렬할 때 사용.
  //   plyKey — refined PLY 의 MinIO object key. SAM3 dispatch 호출 (`/uploads/{id}/sam3/start`) 의
  //     refined_ply_key 인자로 전달됨.
  const commitRefinedToServer = useCallback(async (activeUploadId: string): Promise<{
    rotX: number; rotZ: number; wallAngleRad: number; plyKey: string;
  }> => {
    setSaving(true);
    setUploadProgressOpen(true);
    setUploadProgressMessage('정제된 PLY 준비 중...');
    try {
      const { serializePly, filterScene } = await import('@/lib/ply');
      const { api } = await import('@/lib/api');

      const original = await ensureOriginalScene();
      const N = original.numSplats;
      const data = splatDataRef.current;
      const core = coreRef.current;

      // 1) 통합 keep 마스크 빌드: 브러시 삭제(origColorData alpha=0) ∪ flatten 마스크
      const keep = new Uint8Array(N).fill(1);
      let brushDeleted = 0;
      if (data?.origColorData && core) {
        const h2f = core.half2Float;
        for (let i = 0; i < N; i++) {
          const a = h2f(data.origColorData[i * 4 + 3]);
          if (a < 1e-3) { keep[i] = 0; brushDeleted++; }
        }
      }
      let flattenDeleted = 0;
      if (flattenMaskRef.current) {
        for (let i = 0; i < N; i++) {
          if (flattenMaskRef.current[i] && keep[i]) { keep[i] = 0; flattenDeleted++; }
        }
      } else if (flattenActiveRef.current === false && !data?.origColorData) {
        console.warn('[Save] flatten 마스크가 없습니다 — 모듈 외부 복원 상태이거나 적용 안 함.');
      }
      let floaterDeleted = 0;
      if (floaterActiveRef.current && floaterMaskRef.current) {
        for (let i = 0; i < N; i++) {
          if (floaterMaskRef.current[i] && keep[i]) { keep[i] = 0; floaterDeleted++; }
        }
      }

      // 2) 필터링 + 회전 베이크 (원본 → 회전 적용 + 살릴 가우시안만)
      // SPEC 변경: 다듬기 단계의 정렬 회전 (pendingRotation rotX/rotZ + wallAngle Y) 을 PLY 에 베이크.
      //   사용자가 천장/바닥/벽면 모달로 잡은 정렬 상태가 그대로 final.ply 에 들어감 →
      //   재진입 시 splatEntity 에 default Z-180 만 적용해도 정렬된 상태로 보임.
      //   mesh.json corners 도 같은 A'+Y 프레임 (planeBakeInputForSurface 가 wallAngle 반영) 이므로 일치.
      const wallAngleDeg = wallAngleRef.current ?? 0;
      const wallAngleRad = (wallAngleDeg * Math.PI) / 180;
      const { rotX, rotZ } = pendingRotationRef.current;

      const { rotateSceneY } = await import('@/lib/gs');
      // original 은 reference 라 destructive rotateScene 호출 전에 cloned scene 사용.
      let toRotate = original;
      if (rotX !== 0 || rotZ !== 0 || wallAngleRad !== 0) {
        toRotate = await buildRotatedScene(original);    // pendingRotation rotX/rotZ
        if (wallAngleRad !== 0) rotateSceneY(toRotate, wallAngleRad);
      }
      const baked = filterScene(toRotate, keep);

      console.log(`[Save] N=${N}, brush삭제=${brushDeleted}, flatten삭제=${flattenDeleted}, floater삭제=${floaterDeleted}, 살아남음=${baked.numSplats}. 베이크 회전 rotX=${rotX.toFixed(3)}, rotZ=${rotZ.toFixed(3)}, wallY=${wallAngleDeg.toFixed(2)}°.`);
      console.log(`[Save] flattenActive=${flattenActiveRef.current}, flattenMask 존재=${!!flattenMaskRef.current}`);

      const bytes = serializePly(baked);
      console.log(`[Save] PLY 크기 (정제 후): ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB`);

      // session_id: 한 번의 저장에서 PLY + mesh.json + tex_*.png 가 같은 디렉토리로 가도록.
      const sessionId = `s${Date.now()}`;

      // 저장 PLY 파일명: refined_<원본basename>.ply.
      // originalFilename 은 page.tsx 에서 'refined_' prefix 가 이미 붙은 채 내려올 수 있으니 한 번 벗겨서 재부착.
      const stripPrefix = (s: string) => s.startsWith('refined_') ? s.slice('refined_'.length) : s;
      const baseName = (() => {
        const raw = options?.originalFilename ? stripPrefix(options.originalFilename) : 'scene.ply';
        const dot = raw.lastIndexOf('.');
        const stem = dot >= 0 ? raw.slice(0, dot) : raw;
        return `refined_${stem}.ply`;
      })();

      // 3.1) PLY 업로드
      setUploadProgressMessage('파일 업로드 중...');
      const plyUrl = await api.post<{ put_url: string; key: string }>(
        '/refine/refined-upload-url',
        { upload_id: activeUploadId, filename: baseName, session_id: sessionId },
      );
      const plyResp = await fetch(plyUrl.put_url, {
        method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!plyResp.ok) throw new Error(`PLY PUT failed: ${plyResp.status}`);

      // 3.2) Wall mesh + 텍스처 영속화 (베이크된 면이 있을 때만)
      const meshSurfaces: Array<{
        surfaceId: string;
        corners: number[][];
        uvs: number[][];
        normalInward: [number, number, number];
        textureFilename: string;
        textureWidth: number;
        textureHeight: number;
      }> = [];

      if (lastBakesRef.current.size > 0) {
        // RGBA → PNG Blob (Canvas 거쳐서 toBlob)
        const rgbaToPng = async (rgba: Uint8ClampedArray, w: number, h: number): Promise<Blob> => {
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('canvas 2d ctx failed');
          ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
          return await new Promise<Blob>((res, rej) => {
            canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/png');
          });
        };

        for (const [surfaceId, bake] of Array.from(lastBakesRef.current.entries())) {
          const texFilename = `tex_${surfaceId}.png`;
          const texUrl = await api.post<{ put_url: string; key: string }>(
            '/refine/refined-upload-url',
            { upload_id: activeUploadId, filename: texFilename, session_id: sessionId },
          );
          const pngBlob = await rgbaToPng(bake.rgba, bake.width, bake.height);
          const texResp = await fetch(texUrl.put_url, {
            method: 'PUT', body: pngBlob, headers: { 'Content-Type': 'image/png' },
          });
          if (!texResp.ok) throw new Error(`tex PUT failed (${surfaceId}): ${texResp.status}`);

          // 메시 메타: 코너(4×3) + UV(4×2) + 안쪽 normal(방 안쪽 향함, wallMesh 와 동일 규약).
          // SPEC: PLY 를 A'+Y 프레임 (pendingRotation + wallAngle Y) 으로 베이크하므로
          //   mesh corners 도 같은 프레임으로 변환해 저장. bake corners 는 본래 A' 프레임 (pendingRotation 만 반영) 이라
          //   wallAngle Y 회전만 추가 적용. normal 도 동일 변환.
          const cy = Math.cos(wallAngleRad), sy = Math.sin(wallAngleRad);
          const rotateY = (v: [number, number, number]): [number, number, number] => [
            cy * v[0] + sy * v[2],
            v[1],
            -sy * v[0] + cy * v[2],
          ];
          const inwardRaw: [number, number, number] = [
            -bake.input.normal[0], -bake.input.normal[1], -bake.input.normal[2],
          ];
          const inward = rotateY(inwardRaw);
          const cornersOut = bake.corners.map(
            c => rotateY([c[0], c[1], c[2]]),
          );
          meshSurfaces.push({
            surfaceId,
            corners: cornersOut,
            uvs: bake.uvs.map(u => [u[0], u[1]]),
            normalInward: inward,
            textureFilename: texFilename,
            textureWidth: bake.width,
            textureHeight: bake.height,
          });
        }

        // 3.3) mesh.json 업로드
        const meshMeta = {
          version: 1,
          sessionId,
          surfaces: meshSurfaces,
        };
        const meshJson = JSON.stringify(meshMeta);
        const metaUrl = await api.post<{ put_url: string; key: string }>(
          '/refine/refined-upload-url',
          { upload_id: activeUploadId, filename: 'mesh.json', session_id: sessionId },
        );
        const metaResp = await fetch(metaUrl.put_url, {
          method: 'PUT', body: meshJson, headers: { 'Content-Type': 'application/json' },
        });
        if (!metaResp.ok) throw new Error(`mesh.json PUT failed: ${metaResp.status}`);

        console.log(`[Save] mesh sidecar uploaded — ${meshSurfaces.length} surfaces, session=${sessionId}`);
      } else {
        console.log(`[Save] no wall mesh baked — skipping mesh sidecar`);
      }

      // 3.4) 백엔드에 SceneOutput 등록 (레거시 호환)
      const saveResp = await api.post<{ scene_id: string; message: string }>('/refine/save', {
        upload_id: activeUploadId,
        source_key: plyUrl.key,
      });
      console.log(`[Save] SceneOutput 생성됨 — scene_id=${saveResp.scene_id}, ply_path=${plyUrl.key}`);

      // commit 완료 — 호출자(문 설정 완료) 가 다음 단계 (정합) 진입을 처리함.
      // 호출자가 doors corners 등을 같은 프레임으로 변환할 수 있도록 베이크된 회전값 + plyKey 반환.
      return { rotX, rotZ, wallAngleRad, plyKey: plyUrl.key };
    } catch (e: any) {
      alert(`서버 저장 실패: ${e.message || e}`);
      throw e;
    } finally {
      setSaving(false);
      setUploadProgressOpen(false);
    }
  }, [options, ensureOriginalScene, coreRef, buildRotatedScene]);

  // ── Brush/BBox: delete selected (repeatable) ──
  const deleteSelected = useCallback(() => {
    const data = splatDataRef.current; const core = coreRef.current; const sel = selectionRef.current;
    if (!data || !core || !sel || !data.colorTexture || !data.origColorData) return;
    const td = data.colorTexture.lock(); if (!td) return;
    const f2h = core.float2Half;
    const zeroH = f2h(0);
    // flatten mask 보존: origColorData 에는 flatten 결과가 commit 되어있지 않으므로
    // non-selected splat 의 alpha 를 origColorData 그대로 쓰면 flatten 으로 가려둔 외부 가우시안이 복원됨.
    // → fmask 가 1 인 splat 은 GPU alpha=0 유지. origColorData 에는 selected splat 의 alpha=0 만 commit.
    const fmask = flattenMaskRef.current;
    const flattenVisible = flattenVisibleRef.current;
    const fmaskActive = fmask !== null && flattenActiveRef.current && flattenVisible;
    for (let i = 0; i < data.numSplats; i++) {
      const idx = i * 4;
      if (sel[i]) {
        td[idx+3] = zeroH;
        // 영구 commit: brush 삭제 누적
        data.origColorData[idx+3] = zeroH;
      } else {
        td[idx]   = data.origColorData[idx];
        td[idx+1] = data.origColorData[idx+1];
        td[idx+2] = data.origColorData[idx+2];
        td[idx+3] = (fmaskActive && fmask![i]) ? zeroH : data.origColorData[idx+3];
      }
    }
    data.colorTexture.unlock();
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
    // 1) GPU 색 텍스처 복원 (in-place)
    const data = splatDataRef.current; const pristine = pristineRef.current;
    if (data && pristine && data.colorTexture) {
      data.origColorData = new Uint16Array(pristine);
      const td = data.colorTexture.lock(); if (td) { td.set(pristine); data.colorTexture.unlock(); }
    }
    // 2) 평면/선택 상태
    planesRef.current = []; setPlanes([]); setSelectedPlane(-1); selectedPlaneRef.current = -1; setOutsideCount(0); setClosed(false);
    if (selectionRef.current) selectionRef.current.fill(0); setSelectionCount(0);
    // 3) 천장/바닥
    setCfMode('none'); cfModeRef.current = 'none';
    setCeilingY(0); setFloorY(0); ceilingYRef.current = 0; floorYRef.current = 0;
    setCfModalOpen(false);
    // 4) 벽면
    setWallMode('none'); wallModeRef.current = 'none';
    setWallAngle(null); setWallDistances(null);
    wallAngleRef.current = null; wallDistancesRef.current = null;
    setWallModalOpen(false);
    // 5) 경계면 선택 + 안전거리
    setSelectedSurfaces(new Set()); selectedSurfacesRef.current = new Set();
    setGlobalOffset(0.3);
    setGlobalOffsetText('0.3');
    // 6) 정제 의도 초기화
    pendingRotationRef.current = { rotX: 0, rotZ: 0 };
    setPendingRotation({ rotX: 0, rotZ: 0 });
    flattenMaskRef.current = null;
    flattenActiveRef.current = false; setFlattenActive(false);
    flattenVisibleRef.current = true; setFlattenVisible(true);
    floaterMaskRef.current = null;
    floaterActiveRef.current = false; setFloaterActive(false);
    // 7) 메인 entity transform 베이스 회전(180Z)으로 복귀
    applyEntityRotation();
    // 8) undo + dirty
    opHistoryRef.current = [];
    setUndoDepth(0);
    dirtyRef.current = false;
    setDirty(false);
    setSaved(false);
    if (options?.uploadId) clearRefineState(options.uploadId);
    // 9) 추가 안전장치: 원본 PLY로 강제 reload — in-place 정리에서 놓친 부분이 있어도 깨끗한 상태 보장
    if (options?.uploadId && options?.reloadWithUrl) {
      try {
        const { api } = await import('@/lib/api');
        const res = await api.get<{ url: string }>(`/uploads/${options.uploadId}/presigned-url`);
        options.reloadWithUrl(res.url);
      } catch (e) {
        console.error('원본 PLY reload 실패', e);
      }
    }
  }, [options, applyEntityRotation]);

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
    } else if (rec.type === 'floater') {
      floaterMaskRef.current = rec.prevMask;
      floaterActiveRef.current = rec.prevActive; setFloaterActive(rec.prevActive);
      paintFlattenMask();
    } else if (rec.type === 'clipping') {
      // clipping 토글 OFF — 현재 활성이면 snapshot 으로 복원.
      if (clippingActiveRef.current) {
        try { await applyClipping(); } catch {}
      }
      // 이전 스냅샷이 있었던 경우 (= clipping 이 ON 이었음) 그 상태로 복원하진 않음. 단순히 OFF 만.
    } else if (rec.type === 'wallMesh') {
      // 막 제거 — 현재 entity 들 destroy.
      for (const e of wallMeshEntitiesRef.current) { try { e.destroy(); } catch {} }
      wallMeshEntitiesRef.current = [];
      setWallMeshActive(false);
    }

    const stillDirty = opHistoryRef.current.length > 0
      || pendingRotationRef.current.rotX !== 0
      || pendingRotationRef.current.rotZ !== 0
      || flattenActiveRef.current
      || floaterActiveRef.current;
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
      if (floaterActiveRef.current && floaterMaskRef.current) {
        if (floaterMaskRef.current.length === data.numSplats) {
          paintFlattenMask();
        } else {
          floaterMaskRef.current = null;
          floaterActiveRef.current = false; setFloaterActive(false);
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
    let transPainting = false;
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
    // - union: 브러시 내부 → 1.
    // - diff:  브러시 내부 → 0.
    // - intersect: 스트로크 동안 누적된 strokeMask 와 stroke 시작 시점 sel(=strokeBaseSel) 의 교집합.
    //   매 프레임 sel = strokeBaseSel ∩ strokeMask 로 갱신.
    const applyBrush = (mouseX: number, mouseY: number) => {
      const sd = splatDataRef.current; const sel = selectionRef.current;
      const cam = cameraEntity.camera; const pc = pcRef.current;
      if (!sd || !sel || !cam || !pc) return;
      const vpMat = new pc.Mat4(); vpMat.mul2(cam.projectionMatrix, cam.viewMatrix);
      const mvpMat = new pc.Mat4(); mvpMat.mul2(vpMat, sd.splatEntity.getWorldTransform());
      const m = mvpMat.data; const w = canvas.clientWidth, h = canvas.clientHeight;
      const r2 = brushSizeRef.current**2;
      const pmode = paintModeRef.current;
      if (pmode === 'intersect') {
        const baseSel = strokeBaseSelRef.current;
        const strokeMask = strokeMaskRef.current;
        if (!baseSel || !strokeMask) { refreshSelection(); return; }
        for (let i = 0; i < sd.numSplats; i++) {
          const px=sd.posX[i], py=sd.posY[i], pz=sd.posZ[i];
          const cw = m[3]*px+m[7]*py+m[11]*pz+m[15]; if (cw<=0.01) continue;
          const inv = 1/cw;
          const sx = ((m[0]*px+m[4]*py+m[8]*pz+m[12])*inv+1)*0.5*w;
          const sy = (1-(m[1]*px+m[5]*py+m[9]*pz+m[13])*inv)*0.5*h;
          const dx = sx-mouseX, dy = sy-mouseY;
          if (dx*dx+dy*dy < r2) strokeMask[i] = 1;
        }
        for (let i = 0; i < sd.numSplats; i++) sel[i] = (baseSel[i] && strokeMask[i]) ? 1 : 0;
        refreshSelection();
        return;
      }
      const setVal = pmode === 'union' ? 1 : 0;
      for (let i = 0; i < sd.numSplats; i++) {
        const px=sd.posX[i], py=sd.posY[i], pz=sd.posZ[i];
        const cw = m[3]*px+m[7]*py+m[11]*pz+m[15]; if (cw<=0.01) continue;
        const inv = 1/cw;
        const sx = ((m[0]*px+m[4]*py+m[8]*pz+m[12])*inv+1)*0.5*w;
        const sy = (1-(m[1]*px+m[5]*py+m[9]*pz+m[13])*inv)*0.5*h;
        const dx = sx-mouseX, dy = sy-mouseY;
        if (dx*dx+dy*dy < r2) sel[i] = setVal;
      }
      refreshSelection();
    };

    // ── Rect select: 화면 직사각형 안에 투영되는 모든 splat 을 선택. 깊이 무한대.
    // 현재 sel 과 paintMode (union/intersect/diff) 에 따라 합성.
    const applyRectSelect = (sx0: number, sy0: number, sx1: number, sy1: number) => {
      const sd = splatDataRef.current; const sel = selectionRef.current;
      const cam = cameraEntity.camera; const pc = pcRef.current;
      if (!sd || !sel || !cam || !pc) return;
      const xMin = Math.min(sx0, sx1), xMax = Math.max(sx0, sx1);
      const yMin = Math.min(sy0, sy1), yMax = Math.max(sy0, sy1);
      if (xMax - xMin < 2 || yMax - yMin < 2) return;
      const vpMat = new pc.Mat4(); vpMat.mul2(cam.projectionMatrix, cam.viewMatrix);
      const mvpMat = new pc.Mat4(); mvpMat.mul2(vpMat, sd.splatEntity.getWorldTransform());
      const m = mvpMat.data; const w = canvas.clientWidth, h = canvas.clientHeight;
      const pmode = paintModeRef.current;
      pushHistory();
      for (let i = 0; i < sd.numSplats; i++) {
        const px=sd.posX[i], py=sd.posY[i], pz=sd.posZ[i];
        const cw = m[3]*px+m[7]*py+m[11]*pz+m[15];
        let inRect = 0;
        if (cw > 0.01) {
          const inv = 1/cw;
          const sx = ((m[0]*px+m[4]*py+m[8]*pz+m[12])*inv+1)*0.5*w;
          const sy = (1-(m[1]*px+m[5]*py+m[9]*pz+m[13])*inv)*0.5*h;
          if (sx >= xMin && sx <= xMax && sy >= yMin && sy <= yMax) inRect = 1;
        }
        if (pmode === 'union') sel[i] = sel[i] || inRect ? 1 : 0;
        else if (pmode === 'intersect') sel[i] = sel[i] && inRect ? 1 : 0;
        else sel[i] = sel[i] && !inRect ? 1 : 0;
      }
      refreshSelection();
    };

    // ── Transparent paint: 마우스 위치에서 ray → wallMesh 충돌 → UV → 텍스처 alpha=0 ──
    // 각 wallMesh entity 의 corners (TL,TR,BR,BL, raw+pendingRotation 프레임) 를 worldTransform 으로 변환,
    // ray-quad 교차하여 가장 가까운 hit 찾음. 평면 내 (s,t) ∈ [0,1]² 파라미터 (s: TL→TR, t: TL→BL) 반환.
    type WallHit = { ent: any; surfaceId: string; s: number; t: number; e1L: number; e2L: number; world: Vec3 };
    const rayHitWallMesh = (mouseX: number, mouseY: number): WallHit | null => {
      const cam = cameraEntity.camera; const pc = pcRef.current;
      if (!cam || !pc) return null;
      const ents = wallMeshEntitiesRef.current;
      if (ents.length === 0) return null;

      const near = new pc.Vec3(), far = new pc.Vec3();
      cam.screenToWorld(mouseX, mouseY, cam.nearClip, near);
      cam.screenToWorld(mouseX, mouseY, cam.farClip, far);
      const ro: Vec3 = [near.x, near.y, near.z];
      const rdRaw: Vec3 = [far.x - near.x, far.y - near.y, far.z - near.z];
      const rdLen = Math.hypot(rdRaw[0], rdRaw[1], rdRaw[2]);
      if (rdLen < 1e-8) return null;
      const rd: Vec3 = [rdRaw[0] / rdLen, rdRaw[1] / rdLen, rdRaw[2] / rdLen];

      let best: (WallHit & { tHit: number }) | null = null;
      const tmp = new pc.Vec3();
      for (const ent of ents) {
        const name: string = ent.name || '';
        const surfaceId = name.startsWith('wallMesh_') ? name.slice('wallMesh_'.length) : '';
        const bake = lastBakesRef.current.get(surfaceId);
        if (!bake) continue;
        const wtm = ent.getWorldTransform();
        const wc: Vec3[] = [];
        for (const c of bake.corners) {
          tmp.set(c[0], c[1], c[2]); wtm.transformPoint(tmp, tmp);
          wc.push([tmp.x, tmp.y, tmp.z]);
        }
        const TL = wc[0], TR = wc[1], BL = wc[3];
        const e1: Vec3 = [TR[0]-TL[0], TR[1]-TL[1], TR[2]-TL[2]];
        const e2: Vec3 = [BL[0]-TL[0], BL[1]-TL[1], BL[2]-TL[2]];
        const n = cross3(e1, e2);
        const denom = dot3(rd, n);
        if (Math.abs(denom) < 1e-8) continue;
        const tHit = dot3([TL[0]-ro[0], TL[1]-ro[1], TL[2]-ro[2]], n) / denom;
        if (tHit < 0) continue;
        const P: Vec3 = [ro[0]+rd[0]*tHit, ro[1]+rd[1]*tHit, ro[2]+rd[2]*tHit];
        const v: Vec3 = [P[0]-TL[0], P[1]-TL[1], P[2]-TL[2]];
        const e1l2 = dot3(e1, e1), e2l2 = dot3(e2, e2);
        if (e1l2 < 1e-8 || e2l2 < 1e-8) continue;
        const s = dot3(v, e1) / e1l2;
        const t = dot3(v, e2) / e2l2;
        if (s < 0 || s > 1 || t < 0 || t > 1) continue;
        if (!best || tHit < best.tHit) best = {
          ent, surfaceId, s, t, tHit,
          e1L: Math.sqrt(e1l2), e2L: Math.sqrt(e2l2),
          world: P,
        };
      }
      if (!best) return null;
      return { ent: best.ent, surfaceId: best.surfaceId, s: best.s, t: best.t, e1L: best.e1L, e2L: best.e2L, world: best.world };
    };

    // (s,t) ∈ [0,1]² → 텍스처 픽셀 좌표
    const stToPixel = (surfaceId: string, s: number, t: number): { px: number; py: number } | null => {
      const bake = lastBakesRef.current.get(surfaceId); if (!bake) return null;
      const U = bake.uvs;
      const a00 = U[0], a10 = U[1], a11 = U[2], a01 = U[3];
      const omS = 1 - s, omT = 1 - t;
      const uvU = omS*omT*a00[0] + s*omT*a10[0] + s*t*a11[0] + omS*t*a01[0];
      const uvV = omS*omT*a00[1] + s*omT*a10[1] + s*t*a11[1] + omS*t*a01[1];
      return {
        px: Math.max(0, Math.min(bake.width  - 1, Math.floor(uvU * bake.width))),
        py: Math.max(0, Math.min(bake.height - 1, Math.floor(uvV * bake.height))),
      };
    };

    // 텍스처 GPU 업로드 + dirty 마킹
    const flushWallTexture = (hit: WallHit, rgba: Uint8ClampedArray) => {
      const meshInst = hit.ent.render?.meshInstances?.[0];
      const tex = meshInst?.material?.emissiveMap;
      if (tex) {
        const lvl = tex.lock();
        lvl.set(rgba);
        tex.unlock();
      }
      dirtyRef.current = true; setDirty(true);
      setSaved(false);
    };

    // 원형 브러시 paint (월드 미터 반경 → 텍스처 픽셀 타원)
    const paintTransparentAt = (mouseX: number, mouseY: number): boolean => {
      const hit = rayHitWallMesh(mouseX, mouseY); if (!hit) return false;
      const bake = lastBakesRef.current.get(hit.surfaceId)!;
      const W = bake.width, H = bake.height;
      const center = stToPixel(hit.surfaceId, hit.s, hit.t); if (!center) return false;
      const cx = center.px, cy = center.py;
      const U = bake.uvs;
      const duU = Math.abs(U[1][0] - U[0][0]) * W;
      const dvV = Math.abs(U[3][1] - U[0][1]) * H;
      const pxPerMU = hit.e1L > 1e-8 ? duU / hit.e1L : 0;
      const pxPerMV = hit.e2L > 1e-8 ? dvV / hit.e2L : 0;
      const r = transBrushMetersRef.current;
      const rU = r * pxPerMU, rV = r * pxPerMV;
      if (rU < 0.5 && rV < 0.5) return false;

      const xMin = Math.max(0, Math.floor(cx - rU));
      const xMax = Math.min(W - 1, Math.ceil(cx + rU));
      const yMin = Math.max(0, Math.floor(cy - rV));
      const yMax = Math.min(H - 1, Math.ceil(cy + rV));
      const rU2 = rU * rU, rV2 = rV * rV;
      const rgba = bake.rgba;
      let touched = 0;
      for (let py = yMin; py <= yMax; py++) {
        const dy = py - cy; const dy2 = dy * dy;
        for (let px = xMin; px <= xMax; px++) {
          const dx = px - cx;
          if ((dx*dx)/rU2 + dy2/rV2 > 1) continue;
          const idx = (py * W + px) * 4 + 3;
          if (rgba[idx] === 0) continue;
          rgba[idx] = 0;
          touched++;
        }
      }
      if (touched === 0) return false;
      flushWallTexture(hit, rgba);
      return true;
    };

    // 직사각형 paint: 두 (s,t) 점을 잇는 텍스처 픽셀 축정렬 사각 영역 alpha=0
    // 직사각형 paint (화면 공간): 화면 직사각형 (xMin..xMax, yMin..yMax) 안에 투영되는
    // 모든 wall mesh 텍셀의 alpha 를 0 으로 만든다. wall 평면 위 anchor 가 아니라 단순히
    // 사용자가 화면에 그린 영역 그대로 처리 → 어느 면 위에 있든 시점 기준 직관적.
    // Row 단위 incremental 투영 (clip 좌표가 s 에 affine → per-pixel +delta 누적) 으로 빠르게.
    const paintRectScreenSpace = (sx0: number, sy0: number, sx1: number, sy1: number): boolean => {
      const cam = cameraEntity.camera; const pc = pcRef.current;
      if (!cam || !pc) return false;
      const xMin = Math.min(sx0, sx1), xMax = Math.max(sx0, sx1);
      const yMin = Math.min(sy0, sy1), yMax = Math.max(sy0, sy1);
      if (xMax - xMin < 2 || yMax - yMin < 2) return false;

      const ents = wallMeshEntitiesRef.current;
      if (ents.length === 0) return false;

      const cW = canvas.clientWidth, cH = canvas.clientHeight;
      const vp = new pc.Mat4(); vp.mul2(cam.projectionMatrix, cam.viewMatrix);
      const m = vp.data;

      let touchedAny = false;
      const tmp = new pc.Vec3();

      for (const ent of ents) {
        const name: string = ent.name || '';
        const surfaceId = name.startsWith('wallMesh_') ? name.slice('wallMesh_'.length) : '';
        const bake = lastBakesRef.current.get(surfaceId);
        if (!bake) continue;

        // bake.corners → world
        const wtm = ent.getWorldTransform();
        const wc: Vec3[] = [];
        for (const c of bake.corners) {
          tmp.set(c[0], c[1], c[2]); wtm.transformPoint(tmp, tmp);
          wc.push([tmp.x, tmp.y, tmp.z]);
        }
        const TL = wc[0], TR = wc[1], BR = wc[2], BL = wc[3];

        // 빠른 cull: 코너 투영 bbox 가 rect 와 안 겹치면 skip
        let qxMin = Infinity, qxMax = -Infinity, qyMin = Infinity, qyMax = -Infinity;
        let anyVisible = false;
        for (const c of wc) {
          const cw_ = m[3]*c[0] + m[7]*c[1] + m[11]*c[2] + m[15];
          if (cw_ <= 0.01) continue;
          anyVisible = true;
          const inv = 1/cw_;
          const px = ((m[0]*c[0]+m[4]*c[1]+m[8]*c[2]+m[12])*inv + 1) * 0.5 * cW;
          const py = (1 - (m[1]*c[0]+m[5]*c[1]+m[9]*c[2]+m[13])*inv) * 0.5 * cH;
          if (px < qxMin) qxMin = px; if (px > qxMax) qxMax = px;
          if (py < qyMin) qyMin = py; if (py > qyMax) qyMax = py;
        }
        if (!anyVisible) continue;
        if (qxMax < xMin || qxMin > xMax || qyMax < yMin || qyMin > yMax) continue;

        const W = bake.width, H = bake.height;
        const rgba = bake.rgba;
        let touched = 0;
        const ds = 1 / W;
        const s0 = 0.5 / W;

        for (let py = 0; py < H; py++) {
          const t_ = (py + 0.5) / H;
          const omT = 1 - t_;
          // row 위 양 끝 world (s=0, s=1)
          const Ax = omT*TL[0] + t_*BL[0];
          const Ay = omT*TL[1] + t_*BL[1];
          const Az = omT*TL[2] + t_*BL[2];
          const Bx = omT*TR[0] + t_*BR[0];
          const By = omT*TR[1] + t_*BR[1];
          const Bz = omT*TR[2] + t_*BR[2];
          const dWx = (Bx - Ax) * ds;
          const dWy = (By - Ay) * ds;
          const dWz = (Bz - Az) * ds;
          // px=0 시작 world (s = s0)
          let wx = Ax + s0*(Bx - Ax);
          let wy = Ay + s0*(By - Ay);
          let wz = Az + s0*(Bz - Az);
          let cX = m[0]*wx + m[4]*wy + m[8]*wz + m[12];
          let cY = m[1]*wx + m[5]*wy + m[9]*wz + m[13];
          let cWv = m[3]*wx + m[7]*wy + m[11]*wz + m[15];
          const dCX = m[0]*dWx + m[4]*dWy + m[8]*dWz;
          const dCY = m[1]*dWx + m[5]*dWy + m[9]*dWz;
          const dCW = m[3]*dWx + m[7]*dWy + m[11]*dWz;

          const rowBase = py * W * 4 + 3;
          for (let px = 0; px < W; px++) {
            if (cWv > 0.01) {
              const inv = 1/cWv;
              const sxPx = (cX*inv + 1) * 0.5 * cW;
              const syPx = (1 - cY*inv) * 0.5 * cH;
              if (sxPx >= xMin && sxPx <= xMax && syPx >= yMin && syPx <= yMax) {
                const idx = rowBase + px*4;
                if (rgba[idx] !== 0) { rgba[idx] = 0; touched++; }
              }
            }
            cX += dCX; cY += dCY; cWv += dCW;
          }
        }

        if (touched > 0) {
          flushWallTexture({ ent, surfaceId, s: 0, t: 0, e1L: 0, e2L: 0, world: [0,0,0] }, rgba);
          touchedAny = true;
        }
      }

      return touchedAny;
    };

    // 직사각형 드래그 시작 화면 좌표 (mousedown 시 기록)
    let transRectStartScreen: { x: number; y: number } | null = null;
    // 가우시안 선택용 rect 모드의 드래그 시작 좌표
    let rectStartScreen: { x: number; y: number } | null = null;

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
      if (isSelectMode(mode) && e.code === 'Delete') {
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
      if (mode === 'brush') {
        painting = true;
        pushHistory();
        // intersect: stroke 시작 시점 sel snapshot + 빈 strokeMask 할당.
        if (paintModeRef.current === 'intersect' && selectionRef.current) {
          strokeBaseSelRef.current = new Uint8Array(selectionRef.current);
          strokeMaskRef.current = new Uint8Array(selectionRef.current.length);
        }
        applyBrush(mx, my);
        return;
      }

      // ── RECT MODE (직사각형 영역 선택) ──
      if (mode === 'rect') {
        e.preventDefault();
        rectStartScreen = { x: mx, y: my };
        if (rectPreviewRef.current) {
          const d = rectPreviewRef.current;
          d.style.display = 'block';
          d.style.left = `${mx}px`; d.style.top = `${my}px`;
          d.style.width = '0px'; d.style.height = '0px';
        }
        return;
      }

      // ── TRANSPARENT PAINT MODE ──
      if (mode === 'transparent') {
        e.preventDefault();
        if (transShapeRef.current === 'circle') {
          transPainting = true;
          paintTransparentAt(mx, my);
        } else {
          // rect: 화면 시작 좌표만 기록 (wall hit 검사 불필요 — 화면 전체 영역 기준)
          if (wallMeshEntitiesRef.current.length === 0) return;
          transRectStartScreen = { x: mx, y: my };
          if (transRectPreviewRef.current) {
            const d = transRectPreviewRef.current;
            d.style.display = 'block';
            d.style.left = `${mx}px`; d.style.top = `${my}px`;
            d.style.width = '0px'; d.style.height = '0px';
          }
        }
        return;
      }

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

      // ── RECT (가우시안 선택): preview rect 갱신 ──
      if (mode === 'rect') {
        if (brushCursorRef.current) brushCursorRef.current.style.display = 'none';
        if (rectStartScreen && rectPreviewRef.current) {
          const rect = canvas.getBoundingClientRect();
          const x = e.clientX - rect.left, y = e.clientY - rect.top;
          const left = Math.min(rectStartScreen.x, x), top = Math.min(rectStartScreen.y, y);
          const w = Math.abs(x - rectStartScreen.x), h = Math.abs(y - rectStartScreen.y);
          const d = rectPreviewRef.current;
          d.style.display = 'block';
          d.style.left = `${left}px`; d.style.top = `${top}px`;
          d.style.width = `${w}px`; d.style.height = `${h}px`;
        }
        return;
      }

      // ── TRANSPARENT: cursor + paint ──
      if (mode === 'transparent') {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        if (transShapeRef.current === 'circle') {
          if (brushCursorRef.current) {
            // 실제 paint 와 일치: ray hit 의 월드 좌표에서 brush radius 만큼 떨어진 점을
            // 화면에 투영해 화면 픽셀 반경 계산. wall hit 없으면 cursor 숨김.
            const r = transBrushMetersRef.current;
            const cam = cameraEntity.camera;
            const pc = pcRef.current;
            const hit = (cam && pc) ? rayHitWallMesh(x, y) : null;
            if (hit && cam && pc) {
              const right = cameraEntity.right;
              const c0 = new pc.Vec3(); const c1 = new pc.Vec3();
              cam.worldToScreen(new pc.Vec3(hit.world[0], hit.world[1], hit.world[2]), c0);
              cam.worldToScreen(new pc.Vec3(hit.world[0] + right.x*r, hit.world[1] + right.y*r, hit.world[2] + right.z*r), c1);
              const screenR = Math.hypot(c1.x - c0.x, c1.y - c0.y);
              const sz = Math.max(2, screenR * 2);
              brushCursorRef.current.style.display = 'block';
              brushCursorRef.current.style.left = `${c0.x - sz / 2}px`;
              brushCursorRef.current.style.top = `${c0.y - sz / 2}px`;
              brushCursorRef.current.style.width = `${sz}px`;
              brushCursorRef.current.style.height = `${sz}px`;
            } else {
              brushCursorRef.current.style.display = 'none';
            }
          }
          if (transRectPreviewRef.current) transRectPreviewRef.current.style.display = 'none';
          if (transPainting) paintTransparentAt(x, y);
        } else {
          // rect mode: brush cursor 숨기고, anchor 가 있으면 화면 preview 사각 갱신
          if (brushCursorRef.current) brushCursorRef.current.style.display = 'none';
          if (transRectStartScreen && transRectPreviewRef.current) {
            const sx0 = transRectStartScreen.x, sy0 = transRectStartScreen.y;
            const left = Math.min(sx0, x), top = Math.min(sy0, y);
            const w = Math.abs(x - sx0), h = Math.abs(y - sy0);
            const d = transRectPreviewRef.current;
            d.style.display = 'block';
            d.style.left = `${left}px`; d.style.top = `${top}px`;
            d.style.width = `${w}px`; d.style.height = `${h}px`;
          }
        }
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
      // 직사각형 커밋: 화면 시작점 ↔ 현재점 사이 영역 안의 모든 wall 텍셀 alpha=0
      if (refineModeRef.current === 'transparent' && transShapeRef.current === 'rect' && transRectStartScreen) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        paintRectScreenSpace(transRectStartScreen.x, transRectStartScreen.y, mx, my);
      }
      // 가우시안 선택 rect 커밋
      if (refineModeRef.current === 'rect' && rectStartScreen) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        applyRectSelect(rectStartScreen.x, rectStartScreen.y, mx, my);
      }
      transRectStartScreen = null;
      rectStartScreen = null;
      if (transRectPreviewRef.current) transRectPreviewRef.current.style.display = 'none';
      if (rectPreviewRef.current) rectPreviewRef.current.style.display = 'none';
      // brush intersect: stroke 종료 시 임시 마스크 해제
      strokeBaseSelRef.current = null;
      strokeMaskRef.current = null;
      dragRef.current = null; painting = false; transPainting = false; bboxDragAxis = -1;
    };
    const onMouseLeave = () => {
      if (brushCursorRef.current) brushCursorRef.current.style.display = 'none';
      // rect preview 는 mouseup 까지 표시 (캔버스 밖 드래그 허용 → 표시는 유지)
    };

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
        const csRaw: Vec3[] = [[mn[0],mn[1],mn[2]],[mx[0],mn[1],mn[2]],[mx[0],mx[1],mn[2]],[mn[0],mx[1],mn[2]],[mn[0],mn[1],mx[2]],[mx[0],mn[1],mx[2]],[mx[0],mx[1],mx[2]],[mn[0],mx[1],mx[2]]];
        // bbox 코너는 raw PLY 프레임 — splatEntity 의 world transform (Z-180 + pendingRotation) 적용해서
        // 실제 splat 들이 보이는 world 위치와 정렬. 적용 안 하면 mirror 위치에 그려져 카메라 따라 움직이는 듯한 시각 버그.
        const data = splatDataRef.current;
        const ent = data?.splatEntity;
        const wm = ent?.getWorldTransform();
        const pc = pcRef.current;
        const cs: Vec3[] = csRaw.map(c => {
          if (wm && pc) {
            const v = new pc.Vec3(c[0], c[1], c[2]);
            const out = new pc.Vec3();
            wm.transformPoint(v, out);
            return [out.x, out.y, out.z];
          }
          return c;
        });
        const es: [number,number][] = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
        // 빨간 BBox + 드래그 중인 변은 노랑 강조.
        const bc: Color4=[1,0.2,0.2,1], bh: Color4=[1,1,0,1];
        // 두께 시뮬레이션 — PC drawLine 은 1px 고정. 여러 평행 라인을 짧게 오프셋해 굵게 보이게.
        const sizeRef = bboxSizeRef.current;
        const t = Math.max(sizeRef * 0.0015, 0.005); // 두께 오프셋 (월드 단위, ~ 0.5cm).
        const offsets: Vec3[] = [[0,0,0],[t,0,0],[-t,0,0],[0,t,0],[0,-t,0],[0,0,t],[0,0,-t]];
        for (const [a,b] of es) {
          let col=bc;
          if(bboxDragAxis>=0){const dv=bboxDragIsMax?selBboxMaxRef.current[bboxDragAxis]:selBboxMinRef.current[bboxDragAxis];if(Math.abs(csRaw[a][bboxDragAxis]-dv)<0.001&&Math.abs(csRaw[b][bboxDragAxis]-dv)<0.001)col=bh;}
          for (const o of offsets) {
            core.drawLine(
              [cs[a][0]+o[0], cs[a][1]+o[1], cs[a][2]+o[2]],
              [cs[b][0]+o[0], cs[b][1]+o[1], cs[b][2]+o[2]],
              col, false,
            );
          }
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
  // overlay: brush cursor / rect previews / modals — 캔버스 위 레이어에 둠
  // panel: 도구 패널 본체 — 외부에서 컬럼 안에 배치
  const overlay = splatLoaded ? (
    <>
      {/* Brush cursor */}
      <div ref={brushCursorRef} className="absolute pointer-events-none rounded-full border border-red-400/60" style={{display:'none',boxShadow:'0 0 4px rgba(255,100,100,0.3)'}} />
      <div ref={transRectPreviewRef} className="absolute pointer-events-none border-2 border-dashed border-pink-400 bg-pink-400/10" style={{display:'none'}} />
      <div ref={rectPreviewRef} className="absolute pointer-events-none border-2 border-dashed border-blue-400 bg-blue-400/10" style={{display:'none'}} />
    </>
  ) : null;

  const panel = splatLoaded ? (
    <>
      <div className="bg-black/70 backdrop-blur-sm border border-white/10 text-gray-300 text-xs rounded-lg shadow-lg p-3 flex flex-col gap-2 select-none w-72 max-h-[calc(100vh-200px)] overflow-y-auto">
        <div className="text-white font-bold text-sm mb-1">다듬기</div>

        {/* 상위 모드 탭: 경계면 처리 / 가우시안 선택/삭제 / 투명영역 */}
        <div className="flex gap-1">
          <button
            onClick={() => switchMode('plane')}
            className={`px-2 py-1 rounded cursor-pointer text-xs ${refineMode==='plane'?'bg-blue-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>
            경계면 처리
          </button>
          <button
            onClick={() => switchMode(lastSelectSubModeRef.current)}
            className={`px-2 py-1 rounded cursor-pointer text-xs ${isSelectMode(refineMode)?'bg-blue-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>
            가우시안 선택/삭제
          </button>
          <button
            onClick={() => switchMode('transparent')}
            className={`px-2 py-1 rounded cursor-pointer text-xs ${refineMode==='transparent'?'bg-blue-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>
            투명영역
          </button>
        </div>

        {/* 가우시안 선택/삭제 하위 도구 탭 */}
        {isSelectMode(refineMode) && (
          <div className="flex gap-1 border border-gray-700 rounded p-1">
            {([['brush','브러쉬'],['bbox','BBox'],['rect','직사각형']] as const).map(([key, label]) => (
              <button key={key} onClick={() => switchMode(key as RefineMode)}
                className={`flex-1 px-2 py-0.5 rounded cursor-pointer text-[11px] ${refineMode===key?'bg-indigo-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* ── Plane controls ── */}
        {refineMode === 'plane' && (
          <>
            {/* Ceiling/Floor — 한 줄 */}
            <div className="border border-gray-600 rounded p-2 flex items-center gap-2">
              <div className="text-gray-400 text-[11px] font-bold flex-1">
                천장 / 바닥
                {cfMode === 'confirmed' && <span className="ml-1 text-green-400">✓</span>}
              </div>
              <button onClick={() => setCfModalOpen(true)}
                className={`px-3 py-1 rounded cursor-pointer text-xs ${
                  cfMode === 'confirmed'
                    ? 'bg-gray-600 hover:bg-gray-500 text-white'
                    : 'bg-teal-600 hover:bg-teal-500 text-white'
                }`}>
                {cfMode === 'confirmed' ? '다시 수정' : '설정'}
              </button>
            </div>

            {/* 벽면 — 한 줄 */}
            <div className="border border-gray-600 rounded p-2 flex items-center gap-2">
              <div className="text-gray-400 text-[11px] font-bold flex-1">
                벽면 (X/Z)
                {wallMode === 'confirmed' && (
                  <span className="ml-1 text-green-400">✓ {wallAngle?.toFixed(1)}°</span>
                )}
              </div>
              <button onClick={() => setWallModalOpen(true)}
                disabled={cfMode !== 'confirmed'}
                title={cfMode !== 'confirmed' ? '천장/바닥 먼저 확정' : ''}
                className={`px-3 py-1 rounded cursor-pointer text-xs disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed ${
                  wallMode === 'confirmed'
                    ? 'bg-gray-600 hover:bg-gray-500 text-white'
                    : 'bg-teal-600 hover:bg-teal-500 text-white'
                }`}>
                {wallMode === 'confirmed' ? '다시 수정' : '설정'}
              </button>
            </div>

            {/* 경계면 선택 후 바깥 가우시안 제거 (Shell 제거) — 체크박스는 해당 설정이 확정되어야 활성화 */}
            <div className="border border-gray-600 rounded p-2 flex flex-col gap-1.5">
              <div className="text-gray-400 text-[10px] font-bold">경계면 처리</div>
              {(() => {
                // 주의: PLY 좌표계에 Z-180 회전이 렌더링에 적용돼서 코드의 'ceiling' surfaceId 가
                //  시각적으로 바닥 위치에 그려지고, 'floor' 가 시각적으로 천장 위치에 그려진다.
                //  사용자에게는 시각적 위치 기준으로 라벨 표시.
                const labels: Record<Surface, { name: string; color: string }> = {
                  ceiling: { name: '바닥', color: '#92400e' },  // 시각적 바닥 (PLY frame ceiling) — 밤색
                  floor:   { name: '천장', color: '#22d3ee' },  // 시각적 천장 (PLY frame floor) — 하늘색
                  w1a:     { name: '벽1', color: '#10b981' },
                  w1b:     { name: '벽2', color: '#3b82f6' },
                  w2a:     { name: '벽3', color: '#8b5cf6' },
                  w2b:     { name: '벽4', color: '#84cc16' },
                };
                const isDisabled = (s: Surface) =>
                  CF_SURFACES.includes(s) ? cfMode !== 'confirmed' : wallMode !== 'confirmed';
                return (
                  <>
                    <div className="grid grid-cols-3 gap-x-2 gap-y-1">
                      {ALL_SURFACES.map(s => {
                        const disabled = isDisabled(s);
                        return (
                          <label key={s} className={`flex items-center gap-1 text-[11px] ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                            <input type="checkbox" checked={selectedSurfaces.has(s)} disabled={disabled}
                              onChange={() => toggleSurface(s)}
                              className="accent-blue-500" />
                            <span style={{ color: labels[s].color }}>{labels[s].name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
              <button onClick={toggleAllSurfaces}
                disabled={cfMode !== 'confirmed' && wallMode !== 'confirmed'}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:opacity-50 text-gray-200 rounded cursor-pointer disabled:cursor-not-allowed text-[11px]">
                전체 선택/해제
              </button>
              {(() => {
                const notAllConfirmed = cfMode !== 'confirmed' || wallMode !== 'confirmed';
                const previewDisabled = !flattenPreviewActive && notAllConfirmed;
                const applyDisabled = flattening || (!flattenActive && (notAllConfirmed || selectedSurfaces.size === 0));
                const gateTitle = notAllConfirmed ? '천장/바닥과 벽면을 모두 설정하세요.' : '';
                return (
                  <>
                    <button
                      onClick={() => setFlattenPreviewActive(v => !v)}
                      disabled={previewDisabled}
                      title={previewDisabled ? gateTitle : ''}
                      className={`px-2 py-1 rounded text-[10px] font-bold disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed ${flattenPreviewActive ? 'bg-red-600 hover:bg-red-500 text-white cursor-pointer' : 'bg-gray-700 hover:bg-gray-600 text-gray-300 cursor-pointer'}`}>
                      {flattenPreviewActive ? '삭제될 가우시안 숨기기' : '삭제될 가우시안 확인'}
                    </button>
                    <button onClick={() => applyFlatten()}
                      disabled={applyDisabled}
                      title={!flattenActive && notAllConfirmed ? gateTitle : ''}
                      className={`w-full px-2 py-1.5 rounded cursor-pointer text-xs font-bold disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed ${
                        flattenActive
                          ? 'bg-amber-600 hover:bg-amber-500 text-white'
                          : 'bg-red-600 hover:bg-red-500 text-white'
                      }`}>
                      {flattening ? '처리 중...' : (flattenActive ? '외부 가우시안 복원' : '외부 가우시안 제거')}
                    </button>
                  </>
                );
              })()}

              {/* 막 생성하기 — 외부 가우시안 제거 활성 후 사용 가능 (의존성: flatten 적용 후 막 생성 의미). */}
              <div className={`border-t border-gray-700 pt-2 mt-1 space-y-1.5 ${flattenActive ? '' : 'opacity-50 pointer-events-none'}`}>
                {!wallMeshActive ? (
                  <button onClick={() => bakeWallMeshTest()}
                    disabled={!flattenActive || wallMeshBaking || selectedSurfaces.size === 0 || wallMode !== 'confirmed' || cfMode !== 'confirmed'}
                    title={
                      !flattenActive ? '먼저 외부 가우시안 제거를 적용하세요.'
                      : cfMode !== 'confirmed' ? '천장/바닥 설정을 먼저 확정하세요.'
                      : wallMode !== 'confirmed' ? '벽면 (X/Z) 설정을 먼저 확정하세요.'
                      : selectedSurfaces.size === 0 ? '면을 하나 이상 선택하세요.'
                      : ''
                    }
                    className="w-full px-2 py-1.5 rounded text-xs font-bold disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer">
                    {wallMeshBaking ? '생성 중...' : '막 생성하기'}
                  </button>
                ) : (
                  // 막 활성 상태: [막만 보기 토글] [막 제거]. 재생성은 막 제거 → 막 생성으로 가능.
                  <div className="flex gap-1">
                    <button
                      onClick={() => setSplatHidden(v => !v)}
                      className={`flex-1 px-2 py-1.5 rounded cursor-pointer text-xs font-bold ${
                        splatHidden
                          ? 'bg-emerald-700 hover:bg-emerald-600 text-white'
                          : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      }`}>
                      {splatHidden ? '막만 보기 해제' : '막만 보기'}
                    </button>
                    <button
                      onClick={() => {
                        for (const e of wallMeshEntitiesRef.current) { try { e.destroy(); } catch {} }
                        wallMeshEntitiesRef.current = [];
                        setWallMeshActive(false);
                      }}
                      className="flex-1 px-2 py-1.5 rounded cursor-pointer text-xs font-bold bg-amber-600 hover:bg-amber-500 text-white">
                      막 제거
                    </button>
                  </div>
                )}
              </div>

              {/* 경계면 가우시안 다듬기 — 막 생성 후 사용 가능. */}
              <div className={`border-t border-gray-700 pt-2 mt-1 space-y-1.5 ${wallMeshActive ? '' : 'opacity-50 pointer-events-none'}`}>
                <div className="text-[10px] text-gray-400 font-bold">경계면 가우시안 다듬기</div>
                <div className="flex items-center gap-1.5 text-[10px]"
                  title={`가우시안이 경계면에서 ${(clippingEpsilon * 1000).toFixed(1)}mm 여유를 가지고 다듬어집니다. 여유를 너무 줄이면 가우시안 줄무늬가 나타날 수 있습니다.`}>
                  <span className="text-gray-400 w-14">다듬기 여유</span>
                  <input type="range" min={0} max={0.05} step={0.0005}
                    value={clippingEpsilon}
                    disabled={clippingActive}
                    onChange={(e) => setClippingEpsilon(parseFloat(e.target.value))}
                    className="flex-1 accent-cyan-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50" />
                  <span className="text-white font-mono w-14 text-right">
                    {(clippingEpsilon * 1000).toFixed(1)}mm
                  </span>
                </div>
                <button onClick={() => applyClipping()}
                  disabled={!wallMeshActive || clipping}
                  title={!wallMeshActive ? '먼저 막을 생성하세요.' : ''}
                  className={`w-full px-2 py-1.5 rounded cursor-pointer text-xs font-bold disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed ${
                    clippingActive
                      ? 'bg-amber-600 hover:bg-amber-500 text-white'
                      : 'bg-cyan-600 hover:bg-cyan-500 text-white'
                  }`}>
                  {clipping ? '처리 중...' : (clippingActive ? '경계면 다듬기 취소' : '경계면 다듬기')}
                </button>
              </div>
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
              <button onClick={()=>setPaintMode('intersect')} className={`px-2 py-0.5 rounded cursor-pointer ${paintMode==='intersect'?'bg-yellow-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>∩ 교집합</button>
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
            {/* 내부 가우시안 표시 — 현재 BBox 안의 splat 들을 빨갛게 highlight. */}
            <button
              onClick={() => applyBboxSel(selBboxMinRef.current, selBboxMaxRef.current)}
              className="w-full px-2 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded cursor-pointer text-xs font-bold">
              내부 가우시안 표시
            </button>
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

        {/* ── Rect (직사각형 영역) controls ── */}
        {refineMode === 'rect' && (
          <>
            <div className="flex gap-1">
              <button onClick={()=>setPaintMode('union')} className={`px-2 py-0.5 rounded cursor-pointer ${paintMode==='union'?'bg-green-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>+ 합집합</button>
              <button onClick={()=>setPaintMode('intersect')} className={`px-2 py-0.5 rounded cursor-pointer ${paintMode==='intersect'?'bg-yellow-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>∩ 교집합</button>
              <button onClick={()=>setPaintMode('diff')} className={`px-2 py-0.5 rounded cursor-pointer ${paintMode==='diff'?'bg-red-600 text-white':'bg-gray-700 hover:bg-gray-600'}`}>- 차집합</button>
            </div>
            <div className="text-[10px] text-gray-500 leading-relaxed">
              좌클릭 + 드래그로 화면에 직사각형 그리기 → 영역 안에 투영되는 모든 가우시안 선택 (깊이 무한대).
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

        {/* ── Transparent paint controls (wall mesh 텍스처 alpha=0 페인트) ── */}
        {refineMode === 'transparent' && (
          <>
            <div className="text-[10px] text-gray-400">
              막 텍스처의 투명영역(출입구/통로 등) 지정.
              {wallMeshEntitiesRef.current.length === 0 && (
                <div className="mt-1 text-amber-400">먼저 "막 생성하기"로 막을 만들어야 합니다.</div>
              )}
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setTransShape('circle')}
                className={`flex-1 px-2 py-1 rounded cursor-pointer text-[10px] font-bold ${transShape === 'circle' ? 'bg-pink-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
                원형 브러시
              </button>
              <button
                onClick={() => setTransShape('rect')}
                className={`flex-1 px-2 py-1 rounded cursor-pointer text-[10px] font-bold ${transShape === 'rect' ? 'bg-pink-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
                직사각형
              </button>
            </div>
            {transShape === 'circle' ? (
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="text-gray-400 w-14">브러시</span>
                <input type="range" min={0.02} max={0.5} step={0.01}
                  value={transBrushMeters}
                  onChange={(e) => setTransBrushMeters(parseFloat(e.target.value))}
                  className="flex-1 accent-pink-500 cursor-pointer" />
                <span className="text-white font-mono w-12 text-right">
                  {(transBrushMeters * 100).toFixed(0)}cm
                </span>
              </div>
            ) : (
              <div className="text-[10px] text-gray-500">
                좌클릭 + 드래그로 화면에 직사각형 그리기 → 영역 안의 모든 막 텍셀 투명
              </div>
            )}
          </>
        )}

        {/* Undo / Reset (공통) */}
        <div className="mt-1 flex gap-1">
          <button
            onClick={undoLast}
            disabled={undoDepth === 0}
            className="flex-1 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded cursor-pointer disabled:cursor-not-allowed text-xs"
            title="마지막 파괴적 작업(회전/모듈 외부 제거/막 생성) 되돌리기"
          >
            되돌리기 {undoDepth > 0 ? `(${undoDepth})` : ''}
          </button>
          <button onClick={resetAll} className="flex-1 px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded cursor-pointer text-xs">
            전체 리셋
          </button>
        </div>

        {/* 다듬기 완료 — 모든 sub-tab 공통 가장 하단. 서버 통신 없이 문 설정 단계로 transition.
            register-local + 모든 영속화는 다음 단계(문 설정 완료) 에서 일괄 처리. */}
        {saved ? (
          <div className="mt-2 px-3 py-2 bg-green-800/50 text-green-300 rounded text-xs text-center font-bold">
            저장 완료
          </div>
        ) : (
          <button
            onClick={saveRefined}
            disabled={saving || !wallMeshActive}
            title={!wallMeshActive ? '막 생성 후 다음 단계로 진입할 수 있습니다.' : '다음 단계인 문 설정으로 진입합니다.'}
            className="mt-2 w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed text-white rounded cursor-pointer font-bold text-xs"
          >
            {saving ? '저장 중...' : '다듬기 완료'}
          </button>
        )}
      </div>
    </>
  ) : null;

  const modals = splatLoaded ? (
    <>
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

              if (rotChanged) {
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

      {/* SPEC: 로딩 화면 — "파일 업로드 중..." → "SAM3 작동 중..." */}
      {uploadProgressOpen && (
        <div className="absolute inset-0 z-[101] bg-black/70 flex items-center justify-center">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-8 min-w-[360px] shadow-2xl flex flex-col items-center">
            <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
            <div className="text-white font-bold text-sm mb-1">{uploadProgressMessage || '진행 중...'}</div>
            <div className="text-gray-400 text-[11px] mt-3 text-center">
              브라우저를 닫아도 백그라운드에서 계속 진행됩니다.<br />
              완료 후 대시보드의 [정합하기] 버튼으로 다시 들어올 수 있습니다.
            </div>
          </div>
        </div>
      )}
    </>
  ) : null;

  // 현재 keep mask 반환 — flatten/floater/brush 삭제 모두 반영. 문 설정 단계에서 cachedScene 에 적용해
  // refined 상태와 동기화된 가우시안 집합으로 도어 추출 작업 수행하도록 사용.
  const getCurrentKeepMask = useCallback((): Uint8Array | null => {
    const data = splatDataRef.current;
    const core = coreRef.current;
    if (!data || !core) return null;
    const N = data.numSplats;
    const keep = new Uint8Array(N).fill(1);
    if (data.origColorData) {
      const h2f = core.half2Float;
      for (let i = 0; i < N; i++) {
        const a = h2f(data.origColorData[i * 4 + 3]);
        if (a < 1e-3) keep[i] = 0;
      }
    }
    if (flattenMaskRef.current) {
      for (let i = 0; i < N; i++) {
        if (flattenMaskRef.current[i] && keep[i]) keep[i] = 0;
      }
    }
    if (floaterActiveRef.current && floaterMaskRef.current) {
      for (let i = 0; i < N; i++) {
        if (floaterMaskRef.current[i] && keep[i]) keep[i] = 0;
      }
    }
    return keep;
  }, [coreRef]);

  // 문 설정 단계의 alpha-punch 가 lastBakesRef CPU rgba 까지 반영되도록 외부에서 접근 가능하게 노출.
  // (DoorAlignModal 이 GPU colorTexture 만 punch 하는 한, 같은 punch 를 여기서도 호출해 서버 PNG 와 일관 유지.)
  const getBakeRgba = useCallback((surfaceId: string): { rgba: Uint8ClampedArray; width: number; height: number } | null => {
    const b = lastBakesRef.current.get(surfaceId);
    if (!b) return null;
    return { rgba: b.rgba, width: b.width, height: b.height };
  }, []);

  // commitRefinedToServer 가 서버 업로드 완료 후 반환하던 베이크 회전값을, 업로드 기다리지 않고
  // 동기적으로 얻어와서 doors corners 변환 등에 즉시 사용할 수 있게 한다.
  // (메모리 직주입 후 백그라운드 저장으로 흐름이 바뀌어 await 가 부담스러워졌기 때문.)
  const getCurrentBakedRotation = useCallback((): { rotX: number; rotZ: number; wallAngleRad: number } => {
    const { rotX, rotZ } = pendingRotationRef.current;
    const wallAngleDeg = wallAngleRef.current ?? 0;
    return { rotX, rotZ, wallAngleRad: (wallAngleDeg * Math.PI) / 180 };
  }, []);

  return { overlay, panel, modals, onSplatLoaded, planes, saveRefined, commitRefinedToServer, getCurrentKeepMask, getBakeRgba, getCurrentBakedRotation };
}
