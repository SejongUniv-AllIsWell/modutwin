'use client';

import { useRef, useEffect, useState, useMemo, useCallback } from 'react';

export type PathPoint = { x: number; z: number };

interface Props {
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  numSplats: number;
  ceilingY: number;
  floorY: number;
  /**
   * 확인 클릭 시 호출. polygon 은 cycle 순서의 N개 점 (마지막→첫 점 자동 연결).
   * angleDeg 는 폴리곤 PCA eigenvector 기반 베이크용 Y 회전 (도).
   *
   * Phase 1 임시: cycle 강제 미적용 — edge 에 쓰인 점들을 path 순서대로 polygon 으로 반환.
   * 4점 직사각 polygon 이면 기존 4벽 시절과 동등 동작.
   * Phase 2 에서 cycle 감지 + 확인 활성 조건 추가 예정.
   */
  onConfirm: (angleDeg: number, polygon: PathPoint[]) => void;
  onClose: () => void;
}

const CW = 540;
const CH = 540;
const PAD = 25;
const PATH_POINT_RADIUS = 5;
const PATH_POINT_HOVER_RADIUS = 6.5;
const PATH_POINT_HIT_RADIUS = 14;
type PathEdge = { from: number; to: number };
type PathAction =
  | { type: 'point'; pointIdx: number; edge: PathEdge | null; prevSelected: number }
  | { type: 'edge'; edge: PathEdge; prevSelected: number }
  | { type: 'move'; pointIdx: number; prev: PathPoint }
  | { type: 'parallel'; prevPoints: PathPoint[] };

type CanvasMode = 'draw' | 'parallel';

function normalizeAngle90(deg: number): number {
  let d = ((deg % 180) + 180) % 180;
  if (d >= 90) d -= 90;
  return d;
}

/**
 * 점 분포의 주축(eigenvector)에서 베이크용 Y 회전각 (도) 산출.
 *
 * 사용처: PLY 저장 시 wallAngle Y 회전을 베이크해 재진입 시에도 사용자가 보기 좋은 정렬 상태 유지.
 *
 * 정책 (Phase 4 확정): **PCA 자동 갱신**.
 *   - polygon 모양이 변할 때마다 (점 추가/이동/평행화 적용) 즉시 재계산.
 *   - normalizeAngle90 으로 0~90° 매핑 — 회전 모호성(±90°/180°) 제거.
 *   - 비-직사각 polygon 에서는 PCA 주축이 모양에 따라 약간 변동될 수 있으나, 사용자가
 *     의도적으로 평행화 적용해 직사각/L 자 등으로 정리하면 자연스럽게 수렴.
 */
function angleFromPolygon(points: PathPoint[]): number {
  if (points.length < 2) return 0;
  let cx = 0, cz = 0;
  for (const p of points) { cx += p.x; cz += p.z; }
  cx /= points.length; cz /= points.length;
  let sxx = 0, sxz = 0, szz = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dz = p.z - cz;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
  }
  const trace = sxx + szz;
  const det = sxx * szz - sxz * sxz;
  const disc = Math.max(0, trace * trace * 0.25 - det);
  const l1 = trace * 0.5 + Math.sqrt(disc);
  let vx = sxz;
  let vz = l1 - sxx;
  if (Math.abs(vx) + Math.abs(vz) < 1e-9) { vx = 1; vz = 0; }
  const vn = Math.hypot(vx, vz) || 1;
  vx /= vn; vz /= vn;
  const rawDeg = (Math.atan2(vz, vx) * 180) / Math.PI;
  return normalizeAngle90(rawDeg);
}

/**
 * 벽면 설정 모달 — 사용자가 캔버스 위 가우시안 top-down view 에 점/선으로 N각형 폴리곤을 그리고
 * 닫힌 cycle 이 형성되면 그 폴리곤을 N벽 정의로 사용 (`surfacePlanesFromPolygon`).
 * 베이크용 Y 회전각 (wallAngle) 은 폴리곤 PCA 주축에서 산출.
 *
 * 조작 (draw 모드):
 *  - 좌클릭 빈 공간 → 새 점 추가. 직전 선택점이 있으면 자동으로 edge 연결.
 *  - 좌클릭 기존 점 → 그 점 선택 (다음 빈 공간 클릭 시 그 점으로부터 edge).
 *  - 기존 점 드래그 → 점 이동.
 *  - 우클릭 → 마지막 조작 1단계 undo (점/edge 추가, 점 이동, 평행화 적용).
 *
 * 평행화 모드 (cycle 형성 후 진입 가능):
 *  - 좌클릭 선분 → 선택 토글. 첫 선택이 기준, 나머지가 그 각도에 평행해지도록 회전 (적용 시).
 *  - 인접 선분끼리는 공유 점을 통해 chain reaction.
 */
export default function WallModal({
  posX, posY, posZ, numSplats,
  ceilingY, floorY,
  onConfirm, onClose,
}: Props) {
  const xzRef = useRef<HTMLCanvasElement>(null);

  // 천장/바닥 사이 가우시안만 필터 + 샘플링 (60k 상한).
  // pts: 전체 점 (zoomout 시 outlier 도 보이게).
  // bboxTrimmed: 초기 viewBounds 계산용 0.5%/99.5% percentile 박스 (멀리 떨어진 노이즈는 fit에서 배제).
  const { pts, n, bboxTrimmed } = useMemo(() => {
    const yLo = Math.min(ceilingY, floorY);
    const yHi = Math.max(ceilingY, floorY);
    const valid: number[] = [];
    for (let i = 0; i < numSplats; i++) {
      if (posY[i] >= yLo && posY[i] <= yHi) valid.push(i);
    }
    // 초기 fit 용 percentile bbox 만 계산 (drawing 은 전체 점).
    const xs = new Float32Array(valid.length);
    const zs = new Float32Array(valid.length);
    for (let i = 0; i < valid.length; i++) { xs[i] = posX[valid[i]]; zs[i] = posZ[valid[i]]; }
    const sortedX = Float32Array.from(xs).sort();
    const sortedZ = Float32Array.from(zs).sort();
    const p = 0.005;
    const xLo = sortedX[Math.floor(valid.length * p)];
    const xHi = sortedX[Math.floor(valid.length * (1 - p))];
    const zLo = sortedZ[Math.floor(valid.length * p)];
    const zHi = sortedZ[Math.floor(valid.length * (1 - p))];
    const max = 60000;
    const stride = valid.length > max ? valid.length / max : 1;
    const count = Math.min(valid.length, max);
    const out = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const idx = valid[Math.floor(i * stride)];
      out[i * 2] = posX[idx];
      out[i * 2 + 1] = posZ[idx];
    }
    return { pts: out, n: count, bboxTrimmed: { xLo, xHi, zLo, zHi } };
  }, [posX, posY, posZ, numSplats, ceilingY, floorY]);

  // 캔버스 backing 크기 — mount 시 한 번만.
  useEffect(() => {
    if (xzRef.current) { xzRef.current.width = CW; xzRef.current.height = CH; }
  }, []);

  // 캔버스 표시 영역 — trimmed bbox(0.5%/99.5% percentile) + 5% 여백, 정사각 비율 유지.
  // 전체 점 기준이면 멀리 떨어진 노이즈 1~2개로 화면이 휑해지므로 trim 사용. 줌아웃하면 전체 점 보임.
  const dataBounds = useMemo(() => {
    let mnX = bboxTrimmed.xLo, mxX = bboxTrimmed.xHi, mnZ = bboxTrimmed.zLo, mxZ = bboxTrimmed.zHi;
    const mx = (mxX - mnX) * 0.05, mz = (mxZ - mnZ) * 0.05;
    mnX -= mx; mxX += mx; mnZ -= mz; mxZ += mz;
    const rangeMax = Math.max(mxX - mnX, mxZ - mnZ);
    const cX = (mnX + mxX) / 2, cZ = (mnZ + mxZ) / 2;
    // 데이터 가장자리에 찍은 path point/라벨이 frame 안쪽에 온전히 들어오도록
    // 픽셀 기준 여유분(라벨 반경 11 + 여유 3)만큼 월드 단위로 추가 inset.
    const plotPx = CW - PAD * 2;
    const edgePx = 14;
    const extra = (rangeMax * edgePx) / Math.max(1, plotPx - 2 * edgePx);
    const half = rangeMax / 2 + extra;
    return {
      mnR: cX - half, mxR: cX + half,
      mnT: cZ - half, mxT: cZ + half,
    };
  }, [bboxTrimmed]);

  // 휠 줌/팬용 viewport — 초기엔 dataBounds, 사용자 휠로 변경 가능.
  const [viewport, setViewport] = useState<typeof dataBounds | null>(null);
  // pts 가 바뀌면 (모달 첫 마운트) viewport 초기화.
  useEffect(() => { setViewport(null); }, [dataBounds]);
  const viewBounds = viewport ?? dataBounds;
  // viewBounds 의 최신값을 ref 로도 보관 — 패닝 시작 시점의 스냅샷을 안전하게 읽기 위함.
  const viewBoundsRef = useRef(viewBounds);
  viewBoundsRef.current = viewBounds;

  // 패닝 — 우클릭은 이미 (parallel 선분이동 / draw undo) 점유되어 있어 충돌 회피.
  // 기본 패닝 수단: 중간버튼(휠클릭) 드래그, + 스페이스바 누른 상태 좌드래그.
  const spaceHeldRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.code === 'Space') {
        spaceHeldRef.current = true;
        // 캔버스에 포커스가 없어도 스페이스 스크롤 등 기본동작 방지.
        const tag = (ev.target as HTMLElement | null)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') ev.preventDefault();
      }
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.code === 'Space') spaceHeldRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // 패닝 시작 — 시작 클라이언트 px + 시작 viewBounds 스냅샷을 잡고 document 리스너로 추적.
  // px 이동량을 데이터 좌표 스케일로 환산해 setViewport 로 평행 이동 (드래그한 만큼 그림이 따라옴).
  const startPan = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const rectW = rect.width, rectH = rect.height;
    const startVp = { ...viewBoundsRef.current };
    const startClientX = e.clientX, startClientY = e.clientY;
    const plotW = CW - PAD * 2, plotH = CH - PAD * 2;
    const onMove = (ev: MouseEvent) => {
      const dxData = ((ev.clientX - startClientX) * (CW / rectW)) * (startVp.mxR - startVp.mnR) / plotW;
      const dzData = ((ev.clientY - startClientY) * (CH / rectH)) * (startVp.mxT - startVp.mnT) / plotH;
      setViewport({
        mnR: startVp.mnR - dxData, mxR: startVp.mxR - dxData,
        mnT: startVp.mnT - dzData, mxT: startVp.mxT - dzData,
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const [pathPoints, setPathPoints] = useState<PathPoint[]>([]);
  const [pathEdges, setPathEdges] = useState<PathEdge[]>([]);
  const [hoverPointIdx, setHoverPointIdx] = useState<number>(-1);
  const [selectedPointIdx, setSelectedPointIdx] = useState<number>(-1);
  const pathPointsRef = useRef<PathPoint[]>([]);
  const pathEdgesRef = useRef<PathEdge[]>([]);
  const pathActionsRef = useRef<PathAction[]>([]);
  const selectedPointIdxRef = useRef<number>(-1);

  // 평행화 모드 — cycle 형성 시에만 진입 가능.
  // mode='parallel' 동안에는 점 추가/이동/edge 그리기 비활성. 캔버스 클릭 = segment 선택.
  // 선택 순서대로 parallelSelected 에 cycle order 의 segment idx 가 push.
  // 첫 선택 segment 가 기준 각도 — 본인은 그대로, 나머지가 그 각도에 평행해지도록 회전.
  const [mode, setMode] = useState<CanvasMode>('draw');
  const modeRef = useRef<CanvasMode>('draw');
  const [parallelSelected, setParallelSelected] = useState<number[]>([]);
  const parallelSelectedRef = useRef<number[]>([]);
  const [hoverEdgeIdx, setHoverEdgeIdx] = useState<number>(-1);

  // TDZ 우회 — draw/handleMouseDown/handleMouseMove (이 위에 선언) 가 아래 정의된
  // derivedPolygon / findEdgeHit 을 참조해야 함. ref 로 한 단계 indirect 해서 hoisting 회피.
  type DerivedPolygon = { angleDeg: number; polygon: PathPoint[]; cycleOrder: number[] };
  const derivedPolygonRef = useRef<DerivedPolygon | null>(null);
  const findEdgeHitRef = useRef<(rx: number, rz: number) => number>(() => -1);

  const selectPathPoint = useCallback((idx: number) => {
    selectedPointIdxRef.current = idx;
    setSelectedPointIdx(idx);
  }, []);

  const addPathEdge = useCallback((from: number, to: number): PathEdge | null => {
    if (from === to) return null;
    const prev = pathEdgesRef.current;
    const exists = prev.some(edge =>
      (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from)
    );
    if (exists) return null;
    const edge = { from, to };
    const next = [...prev, edge];
    pathEdgesRef.current = next;
    setPathEdges(next);
    return edge;
  }, []);

  const pathHitThreshold = useMemo(() => {
    const plotW = CW - PAD * 2;
    return ((viewBounds.mxR - viewBounds.mnR) / plotW) * PATH_POINT_HIT_RADIUS;
  }, [viewBounds]);

  const findPathPointHit = useCallback((rx: number, rz: number) => {
    const points = pathPointsRef.current;
    let hit = -1;
    let best = pathHitThreshold;
    for (let i = 0; i < points.length; i++) {
      const d = Math.hypot(points[i].x - rx, points[i].z - rz);
      if (d < best) { best = d; hit = i; }
    }
    return hit;
  }, [pathHitThreshold]);

  // 캔버스 그리기 — pts top-down + 폴리곤 (점 + 연결선) overlay.
  const draw = useCallback(() => {
    const canvas = xzRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { mnR, mxR, mnT, mxT } = viewBounds;
    const plotW = CW - PAD * 2;
    const plotH = CH - PAD * 2;
    const scR = plotW / (mxR - mnR || 1);
    const scT = plotH / (mxT - mnT || 1);
    const toX = (rx: number) => PAD + (rx - mnR) * scR;
    const toY = (rz: number) => PAD + (rz - mnT) * scT;

    // 점군 누적 — fillRect 수만 번 대신 ImageData 1회.
    const img = ctx.createImageData(CW, CH);
    const data = img.data;
    for (let i = 0; i < CW * CH; i++) {
      const o = i * 4;
      data[o] = 17; data[o + 1] = 24; data[o + 2] = 39; data[o + 3] = 255;
    }
    const ALPHA = 0.22;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      const px = (PAD + (x - mnR) * scR) | 0;
      const py = (PAD + (z - mnT) * scT) | 0;
      if (px < 0 || px >= CW || py < 0 || py >= CH) continue;
      const o = (py * CW + px) * 4;
      data[o]     += (180 - data[o])     * ALPHA;
      data[o + 1] += (210 - data[o + 1]) * ALPHA;
      data[o + 2] += (255 - data[o + 2]) * ALPHA;
    }
    ctx.putImageData(img, 0, 0);

    // 폴리곤 edge — draw 모드: 단일 색. parallel 모드: 기본은 회색 base, hover/선택 색 분기.
    if (pathEdges.length > 0) {
      ctx.setLineDash([]);
      if (mode === 'parallel') {
        // base edges
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (const edge of pathEdges) {
          const from = pathPoints[edge.from];
          const to = pathPoints[edge.to];
          if (!from || !to) continue;
          ctx.moveTo(toX(from.x), toY(from.z));
          ctx.lineTo(toX(to.x), toY(to.z));
        }
        ctx.stroke();
      } else {
        ctx.strokeStyle = '#60a5fa';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        let hasEdge = false;
        for (const edge of pathEdges) {
          const from = pathPoints[edge.from];
          const to = pathPoints[edge.to];
          if (!from || !to) continue;
          ctx.moveTo(toX(from.x), toY(from.z));
          ctx.lineTo(toX(to.x), toY(to.z));
          hasEdge = true;
        }
        if (hasEdge) ctx.stroke();
      }
    }

    // 평행화 모드 — 선택/hover segment overlay + 번호 라벨.
    const dpForDraw = derivedPolygonRef.current;
    if (mode === 'parallel' && dpForDraw) {
      const { polygon } = dpForDraw;
      const N = polygon.length;
      // hover edge (선택 안 된 것에만)
      if (hoverEdgeIdx >= 0 && parallelSelected.indexOf(hoverEdgeIdx) < 0) {
        const a = polygon[hoverEdgeIdx];
        const b = polygon[(hoverEdgeIdx + 1) % N];
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(toX(a.x), toY(a.z));
        ctx.lineTo(toX(b.x), toY(b.z));
        ctx.stroke();
      }
      // 선택 edge — 첫 선택 = 기준선 (밝은 시안, 두꺼움, "기준" 라벨), 나머지 = 평행화 대상 (주황, 번호).
      for (let k = 0; k < parallelSelected.length; k++) {
        const segIdx = parallelSelected[k];
        if (segIdx < 0 || segIdx >= N) continue;
        const a = polygon[segIdx];
        const b = polygon[(segIdx + 1) % N];
        const isBase = k === 0;
        ctx.strokeStyle = isBase ? '#22d3ee' : '#f59e0b';
        ctx.lineWidth = isBase ? 7 : 5;
        ctx.beginPath();
        ctx.moveTo(toX(a.x), toY(a.z));
        ctx.lineTo(toX(b.x), toY(b.z));
        ctx.stroke();
        // 라벨 (변 중점) — 기준은 별 모양 + "기준", 대상은 원 + 번호.
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const lx = toX(mx), ly = toY(mz);
        if (isBase) {
          // 기준선 — 큰 사각형 배경 + "기준" 텍스트.
          ctx.fillStyle = '#22d3ee';
          ctx.fillRect(lx - 18, ly - 10, 36, 20);
          ctx.fillStyle = '#0f172a';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('기준', lx, ly);
        } else {
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.arc(lx, ly, 11, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#0f172a';
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(k), lx, ly);  // k=1,2,3... (기준이 0 이라 대상은 1부터)
        }
      }
    }

    // 폴리곤 점.
    for (let i = 0; i < pathPoints.length; i++) {
      const p = pathPoints[i];
      const px = toX(p.x);
      const py = toY(p.z);
      const isHover = i === hoverPointIdx;
      const isSelected = i === selectedPointIdx;
      const radius = isHover ? PATH_POINT_HOVER_RADIUS : PATH_POINT_RADIUS;
      // 평행화 모드에서는 점 강조 약화 (선분 선택이 주이므로).
      if (mode === 'parallel') {
        ctx.fillStyle = '#64748b';
      } else {
        ctx.fillStyle = isSelected ? '#f59e0b' : '#22d3ee';
      }
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 외곽 + 축 라벨.
    ctx.setLineDash([]);
    ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
    ctx.strokeRect(PAD, PAD, plotW, plotH);
    ctx.fillStyle = '#888'; ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('X', CW / 2, CH - 4);
    ctx.save();
    ctx.translate(10, CH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Z', 0, 0);
    ctx.restore();
  }, [pts, n, viewBounds, pathPoints, pathEdges, hoverPointIdx, selectedPointIdx, mode, hoverEdgeIdx, parallelSelected]);

  useEffect(() => { draw(); }, [draw]);

  // 픽셀 좌표 → 월드 XZ (React MouseEvent).
  const mouseToWorld = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (CW / rect.width);
    const my = (e.clientY - rect.top) * (CH / rect.height);
    const { mnR, mxR, mnT, mxT } = viewBounds;
    const plotW = CW - PAD * 2, plotH = CH - PAD * 2;
    const rx = mnR + (mx - PAD) * (mxR - mnR) / plotW;
    const rz = mnT + (my - PAD) * (mxT - mnT) / plotH;
    return { rx, rz };
  }, [viewBounds]);

  // 픽셀 좌표 → 월드 XZ (native DOM MouseEvent — document listener 가 받음).
  const nativeToWorld = useCallback((ev: MouseEvent) => {
    const el = xzRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * (CW / rect.width);
    const my = (ev.clientY - rect.top) * (CH / rect.height);
    const { mnR, mxR, mnT, mxT } = viewBounds;
    const plotW = CW - PAD * 2, plotH = CH - PAD * 2;
    const rx = mnR + (mx - PAD) * (mxR - mnR) / plotW;
    const rz = mnT + (my - PAD) * (mxT - mnT) / plotH;
    return { rx, rz };
  }, [viewBounds]);

  // 좌클릭 — 기존 점 hit 면 선택/드래그, 빈 공간이면 새 점 추가 + 직전 선택점과 edge.
  // 점 드래그는 document mousemove/mouseup 으로 추적 — 캔버스 밖으로 나가도 끊기지 않음.
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    // 패닝 — 중간버튼(휠클릭) 드래그, 또는 스페이스바 누른 상태 좌드래그.
    // 우클릭은 기존 동작(parallel 선분이동 / draw undo)으로 점유되어 충돌 회피 위해 좌/중간버튼만 사용.
    if (e.button === 1 || (e.button === 0 && spaceHeldRef.current)) {
      e.preventDefault();
      startPan(e);
      return;
    }
    // 우클릭 — 평행화 모드에서 선분 수직(normal) 평행이동 드래그.
    // (draw 모드 우클릭은 onContextMenu 의 undo 가 처리하므로 여기선 무시.)
    if (e.button === 2) {
      if (modeRef.current !== 'parallel') return;
      const dp = derivedPolygonRef.current;
      if (!dp) return;
      e.preventDefault();
      const { rx, rz } = mouseToWorld(e);
      const segHit = findEdgeHitRef.current(rx, rz);
      if (segHit < 0) return;
      const { polygon, cycleOrder } = dp;
      const N = polygon.length;
      const a = polygon[segHit];
      const b = polygon[(segHit + 1) % N];
      const ex = b.x - a.x, ez = b.z - a.z;
      const elen = Math.hypot(ex, ez) || 1;
      // 선분 기울기의 수직 (XZ) 단위벡터. 부호는 무관 — 마우스 이동 투영이 양/음 결정.
      const nx = ez / elen, nz = -ex / elen;
      const aIdx = cycleOrder[segHit];
      const bIdx = cycleOrder[(segHit + 1) % N];
      const startSnapshot = pathPointsRef.current.map(p => ({ ...p }));
      const startA = { ...startSnapshot[aIdx] };
      const startB = { ...startSnapshot[bIdx] };
      const startWx = rx, startWz = rz;
      let moved = false;

      const onMove = (ev: MouseEvent) => {
        const r = nativeToWorld(ev);
        if (!r) return;
        // 마우스 이동량을 선분 normal 에 투영 → 그만큼만 수직 평행이동.
        const proj = (r.rx - startWx) * nx + (r.rz - startWz) * nz;
        if (!moved && Math.abs(proj) < 1e-4) return;
        moved = true;
        const next = pathPointsRef.current.map((p, i) => {
          if (i === aIdx) return { x: startA.x + proj * nx, z: startA.z + proj * nz };
          if (i === bIdx) return { x: startB.x + proj * nx, z: startB.z + proj * nz };
          return p;
        });
        pathPointsRef.current = next;
        setPathPoints(next);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // 실제 이동했을 때만 undo 스냅샷 기록 (parallel 액션과 동일 형식).
        if (moved) pathActionsRef.current.push({ type: 'parallel', prevPoints: startSnapshot });
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      return;
    }

    if (e.button !== 0) return;
    e.preventDefault();
    const { rx, rz } = mouseToWorld(e);

    // 평행화 모드 — segment 선택 토글.
    if (modeRef.current === 'parallel') {
      const segHit = findEdgeHitRef.current(rx, rz);
      if (segHit < 0) return;
      const cur = parallelSelectedRef.current;
      const exists = cur.indexOf(segHit);
      const next = exists >= 0 ? cur.filter(s => s !== segHit) : [...cur, segHit];
      parallelSelectedRef.current = next;
      setParallelSelected(next);
      return;
    }

    const hit = findPathPointHit(rx, rz);
    const points = pathPointsRef.current;
    const selected = selectedPointIdxRef.current;

    if (hit >= 0) {
      // 기존 점 — 드래그 또는 단순 클릭(edge 연결). 3px 이상 움직였을 때만 drag.
      const startPoint = { ...points[hit] };
      const startClientX = e.clientX;
      const startClientY = e.clientY;
      let moved = false;

      const onMove = (ev: MouseEvent) => {
        if (!moved) {
          const dxp = ev.clientX - startClientX;
          const dyp = ev.clientY - startClientY;
          if (Math.hypot(dxp, dyp) < 3) return;
          moved = true;
        }
        const r = nativeToWorld(ev);
        if (!r) return;
        const next = pathPointsRef.current.map((p, i) => i === hit ? { x: r.rx, z: r.rz } : p);
        pathPointsRef.current = next;
        setPathPoints(next);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (moved) {
          pathActionsRef.current.push({ type: 'move', pointIdx: hit, prev: startPoint });
          selectPathPoint(hit);
        } else {
          const curSelected = selectedPointIdxRef.current;
          if (curSelected >= 0 && curSelected < pathPointsRef.current.length && curSelected !== hit) {
            const edge = addPathEdge(curSelected, hit);
            if (edge) pathActionsRef.current.push({ type: 'edge', edge, prevSelected: curSelected });
          }
          selectPathPoint(hit);
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      return;
    }

    // 빈 공간 — 새 점 + 직전 선택점과 edge 자동 연결.
    const nextIdx = points.length;
    const fromIdx = selected >= 0 && selected < points.length ? selected : points.length - 1;
    const next = [...points, { x: rx, z: rz }];
    pathPointsRef.current = next;
    setPathPoints(next);
    const edge = fromIdx >= 0 ? addPathEdge(fromIdx, nextIdx) : null;
    pathActionsRef.current.push({ type: 'point', pointIdx: nextIdx, edge, prevSelected: selected });
    selectPathPoint(nextIdx);
  }, [addPathEdge, findPathPointHit, mouseToWorld, nativeToWorld, selectPathPoint, startPan]);

  // hover 표시만 — 드래그는 document listener 가 담당.
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { rx, rz } = mouseToWorld(e);
    if (modeRef.current === 'parallel') {
      setHoverPointIdx(-1);
      setHoverEdgeIdx(findEdgeHitRef.current(rx, rz));
    } else {
      setHoverEdgeIdx(-1);
      setHoverPointIdx(findPathPointHit(rx, rz));
    }
  }, [mouseToWorld, findPathPointHit]);

  // 휠 줌 — 커서 위치 월드좌표 고정. 더블클릭으로 fit-to-data 복귀.
  useEffect(() => {
    const el = xzRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = (ev.clientX - rect.left) * (CW / rect.width);
      const my = (ev.clientY - rect.top) * (CH / rect.height);
      const plotW = CW - PAD * 2, plotH = CH - PAD * 2;
      const b = viewport ?? dataBounds;
      const wx = b.mnR + (mx - PAD) * (b.mxR - b.mnR) / plotW;
      const wz = b.mnT + (my - PAD) * (b.mxT - b.mnT) / plotH;
      const factor = ev.deltaY < 0 ? 0.85 : 1 / 0.85;
      // 최소/최대 half-range clamp (5cm ~ dataBounds × 5).
      const dataHalf = (dataBounds.mxR - dataBounds.mnR) / 2;
      const curHalf = (b.mxR - b.mnR) / 2;
      const nextHalf = Math.max(0.05, Math.min(dataHalf * 50, curHalf * factor));
      const usedFactor = nextHalf / curHalf;
      const halfX = (b.mxR - b.mnR) / 2 * usedFactor;
      const halfZ = (b.mxT - b.mnT) / 2 * usedFactor;
      const px = (mx - PAD) / plotW;
      const py = (my - PAD) / plotH;
      const newMnR = wx - halfX * 2 * px;
      const newMnT = wz - halfZ * 2 * py;
      setViewport({
        mnR: newMnR, mxR: newMnR + halfX * 2,
        mnT: newMnT, mxT: newMnT + halfZ * 2,
      });
    };
    const onDblClick = () => setViewport(null);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDblClick);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDblClick);
    };
  }, [viewport, dataBounds]);

  // 우클릭 — draw 모드: 마지막 조작 1단계 undo. parallel 모드: 선분 수직 이동(handleMouseDown 처리)
  // 이므로 컨텍스트 메뉴만 차단하고 undo 는 하지 않음 (이동 undo 는 draw 모드 복귀 후 우클릭).
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (modeRef.current === 'parallel') return;
    const action = pathActionsRef.current.pop();
    if (!action) return;

    if (action.type === 'parallel') {
      pathPointsRef.current = action.prevPoints.map(p => ({ ...p }));
      setPathPoints(pathPointsRef.current);
      // 모드는 그대로 둠 (사용자가 적용 직후 되돌리려는 케이스가 자연).
      parallelSelectedRef.current = [];
      setParallelSelected([]);
      return;
    }

    if (action.type === 'move') {
      const next = pathPointsRef.current.map((p, i) => i === action.pointIdx ? action.prev : p);
      pathPointsRef.current = next;
      setPathPoints(next);
      return;
    }

    if (action.type === 'point') {
      const nextPoints = pathPointsRef.current.filter((_, idx) => idx !== action.pointIdx);
      const nextEdges = pathEdgesRef.current.filter(edge =>
        edge.from !== action.pointIdx && edge.to !== action.pointIdx
      );
      pathPointsRef.current = nextPoints;
      pathEdgesRef.current = nextEdges;
      setPathPoints(nextPoints);
      setPathEdges(nextEdges);
      const nextSelected = action.prevSelected >= 0 && action.prevSelected < nextPoints.length
        ? action.prevSelected
        : nextPoints.length - 1;
      selectPathPoint(nextSelected);
      return;
    }

    const nextEdges = pathEdgesRef.current.filter(edge =>
      !((edge.from === action.edge.from && edge.to === action.edge.to) ||
        (edge.from === action.edge.to && edge.to === action.edge.from))
    );
    pathEdgesRef.current = nextEdges;
    setPathEdges(nextEdges);
    selectPathPoint(action.prevSelected);
  }, [selectPathPoint]);

  // edge 그래프에서 **단일 cycle** 추출. cycle 미형성 시 null.
  //
  // cycle 인정 조건 (보수적 — 모호한 입력 차단):
  //   1. 모든 점이 정확히 2개의 edge 에 속한다 (각 노드 degree = 2).
  //   2. 단일 connected component.
  //   3. 점 ≥ 3.
  //
  // 반환: cycle 순서대로 pathPoints 의 원본 인덱스 배열.
  // 분기 (degree ≥ 3), 고립점 (degree = 0), 끝점 (degree = 1) 이 하나라도 있으면 cycle 아님.
  function extractCycleOrder(
    points: PathPoint[],
    edges: PathEdge[],
  ): number[] | null {
    if (points.length < 3 || edges.length < 3) return null;
    const N = points.length;
    const adj = new Map<number, number[]>();
    for (let i = 0; i < N; i++) adj.set(i, []);
    for (const e of edges) {
      if (!points[e.from] || !points[e.to]) continue;
      adj.get(e.from)!.push(e.to);
      adj.get(e.to)!.push(e.from);
    }
    const active: number[] = [];
    adj.forEach((nbrs, idx) => { if (nbrs.length > 0) active.push(idx); });
    if (active.length < 3) return null;
    for (const idx of active) {
      if (adj.get(idx)!.length !== 2) return null;
    }
    const start = active[0];
    const visited = new Set<number>();
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const n of adj.get(node)!) {
        if (!visited.has(n)) stack.push(n);
      }
    }
    if (visited.size !== active.length) return null;
    const order: number[] = [start];
    let prev = -1;
    let cur = start;
    while (true) {
      const nbrs = adj.get(cur)!;
      const next = nbrs[0] !== prev ? nbrs[0] : nbrs[1];
      if (next === start) break;
      if (order.length > active.length) return null;
      order.push(next);
      prev = cur;
      cur = next;
    }
    if (order.length !== active.length) return null;
    return order;
  }

  /**
   * 확정 후보 polygon — cycle 형성될 때만 산출. open polyline / 분기 / 고립점 상태에선 null.
   *
   * cycleOrder: cycle 순서대로 pathPoints 의 원본 인덱스. polygon[i] = pathPoints[cycleOrder[i]].
   * → 평행화 적용 시 cycleOrder 로 pathPoints 의 어느 idx 를 갱신해야 할지 매핑.
   */
  const derivedPolygon = useMemo<DerivedPolygon | null>(() => {
    const cycleOrder = extractCycleOrder(pathPoints, pathEdges);
    if (!cycleOrder) return null;
    const polygon = cycleOrder.map(i => pathPoints[i]);
    const angleDeg = angleFromPolygon(polygon);
    return { angleDeg, polygon, cycleOrder };
  }, [pathPoints, pathEdges]);

  // ref 갱신 — draw / handleMouseDown 이 위에서 ref 통해 read.
  useEffect(() => { derivedPolygonRef.current = derivedPolygon; }, [derivedPolygon]);

  // 사용자 가이드 — cycle 형성 진행 상황.
  const cycleStatus = useMemo<string>(() => {
    if (derivedPolygon) return `cycle 형성 ✓ (${derivedPolygon.polygon.length}각형, 각도 ${derivedPolygon.angleDeg.toFixed(1)}°)`;
    if (pathPoints.length === 0) return '점을 찍어 시작하세요.';
    if (pathPoints.length < 3) return '닫힌 다각형이 되려면 최소 3점 필요.';
    if (pathEdges.length < pathPoints.length) return '아직 닫히지 않았습니다 — 마지막 점을 첫 점과 연결하세요.';
    // edges >= points 이지만 cycle 아닌 경우 (분기 등).
    return '닫힌 단일 cycle 이 아닙니다 (분기 / 중복 edge / 고립점 확인).';
  }, [derivedPolygon, pathPoints.length, pathEdges.length]);

  // cycle 이 깨지면 평행화 모드 강제 해제 + 선택 초기화.
  useEffect(() => {
    if (!derivedPolygon && modeRef.current === 'parallel') {
      modeRef.current = 'draw';
      setMode('draw');
      parallelSelectedRef.current = [];
      setParallelSelected([]);
    }
  }, [derivedPolygon]);

  // 점-선 거리 (segment ab 위의 perpendicular projection, segment 범위 밖이면 끝점까지 거리).
  function segmentDistance(p: PathPoint, a: PathPoint, b: PathPoint): number {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.z - a.z);
    let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + t * dx;
    const qz = a.z + t * dz;
    return Math.hypot(p.x - qx, p.z - qz);
  }

  // polygon cycle 의 i번째 변 = (polygon[i], polygon[(i+1)%N]). 마우스점에 가장 가까운 변 idx 반환.
  const findEdgeHit = useCallback((rx: number, rz: number): number => {
    if (!derivedPolygon) return -1;
    const { polygon } = derivedPolygon;
    const N = polygon.length;
    let best = pathHitThreshold;
    let hit = -1;
    for (let i = 0; i < N; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % N];
      const d = segmentDistance({ x: rx, z: rz }, a, b);
      if (d < best) { best = d; hit = i; }
    }
    return hit;
  }, [derivedPolygon, pathHitThreshold]);

  // ref 갱신 — handleMouseDown/Move 가 위에서 ref 통해 read.
  useEffect(() => { findEdgeHitRef.current = findEdgeHit; }, [findEdgeHit]);

  // 평행화 모드 토글.
  const toggleParallelMode = useCallback(() => {
    if (!derivedPolygon && modeRef.current === 'draw') return; // cycle 없으면 진입 불가
    const next: CanvasMode = modeRef.current === 'parallel' ? 'draw' : 'parallel';
    modeRef.current = next;
    setMode(next);
    parallelSelectedRef.current = [];
    setParallelSelected([]);
  }, [derivedPolygon]);

  // 평행화 적용 — 선택 ≥ 2 일 때만. 첫 선택 segment = 기준 각도, 나머지 segment 들의 뒷 점을 회전.
  // chain reaction 은 자연: 인접 segment 가 공유 점을 통해 자동 propagation.
  const applyParallel = useCallback(() => {
    if (!derivedPolygon) return;
    const sel = parallelSelectedRef.current;
    if (sel.length < 2) return;
    const { polygon, cycleOrder } = derivedPolygon;
    const N = polygon.length;

    // 기준 각도 — 첫 선택 segment 의 (a→b) 방향. polygon 의 그 시점 좌표 사용.
    const ref = sel[0];
    const ra = polygon[ref];
    const rb = polygon[(ref + 1) % N];
    const theta = Math.atan2(rb.z - ra.z, rb.x - ra.x);
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // pathPoints 의 변경될 좌표를 별도 배열로 누적.
    const nextPoints = pathPointsRef.current.map(p => ({ ...p }));
    // chain reaction 위해 매 segment 마다 nextPoints 의 cycle order 점을 즉시 read.
    const get = (cycleIdx: number) => nextPoints[cycleOrder[cycleIdx]];

    for (let k = 1; k < sel.length; k++) {
      const segIdx = sel[k];
      const aIdx = segIdx;
      const bIdx = (segIdx + 1) % N;
      const a = get(aIdx); // 그 시점 polygon 의 앞 점 (이전 변환 결과 반영)
      const b = get(bIdx);
      const dxOrig = b.x - a.x;
      const dzOrig = b.z - a.z;
      const len = Math.hypot(dxOrig, dzOrig);
      if (len < 1e-9) continue;
      // "평행" = 같은 방향 또는 반대 방향 둘 다 OK. 원래 방향과 기준 방향의 내적 부호로
      // 더 가까운 쪽 선택 — 작은 회전만 적용 (180° 점프 방지).
      const dot = dxOrig * cosT + dzOrig * sinT;
      const sign = dot >= 0 ? 1 : -1;
      const newBx = a.x + sign * len * cosT;
      const newBz = a.z + sign * len * sinT;
      nextPoints[cycleOrder[bIdx]] = { x: newBx, z: newBz };
    }

    // undo 기록 — 전체 좌표 스냅샷.
    pathActionsRef.current.push({
      type: 'parallel',
      prevPoints: pathPointsRef.current.map(p => ({ ...p })),
    });

    pathPointsRef.current = nextPoints;
    setPathPoints(nextPoints);
    // 적용 후 선택 초기화 (모드는 유지 — 사용자가 추가 선택 가능).
    parallelSelectedRef.current = [];
    setParallelSelected([]);
  }, [derivedPolygon]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-[var(--paper)] border border-[var(--rule)] rounded-lg p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="text-[var(--ink)] font-bold text-sm mb-1">벽면 설정</div>
        <div className="text-[var(--muted)] text-xs mb-3">
          {mode === 'parallel' ? (
            <>
              ① 좌클릭으로 <span style={{color:'#22d3ee', fontWeight:'bold'}}>기준 선분</span> 선택 → ② <span style={{color:'#f59e0b', fontWeight:'bold'}}>대상 선분</span>들을 순서대로 클릭으로 평행화.
              <br />
              우클릭 드래그로 선분 수직 평행이동 (되돌리기는 모드 해제 후 우클릭). 휠클릭(또는 스페이스+좌)드래그로 화면 이동.
            </>
          ) : (
            <>
              좌클릭으로 점과 선을 추가, 기존 점은 드래그로 이동. 점을 클릭하면 직전에 선택한 점과 연결되고, 우클릭은 마지막 조작을 되돌립니다.
              <br />
              모든 점이 닫힌 cycle 로 연결되어야 확인이 활성화됩니다. 마우스 휠로 줌, 휠클릭(또는 스페이스+좌)드래그로 화면 이동, 더블클릭으로 초기화.
            </>
          )}
        </div>
        <div>
          <div className="text-[var(--muted)] text-[10px] mb-1 text-center">Top-down (XZ)</div>
          <canvas ref={xzRef} style={{ width: CW, height: CH, userSelect: 'none' }}
            className={`border border-[var(--rule)] rounded ${mode === 'parallel' ? 'cursor-pointer' : 'cursor-crosshair'}`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onContextMenu={handleContextMenu} />
        </div>
        <div className="flex items-center justify-between mt-3 gap-3">
          <div className="text-xs font-mono flex-1 min-w-0">
            <div className="text-[var(--muted)]">{`점 ${pathPoints.length}개, 선 ${pathEdges.length}개`}</div>
            <div className={`truncate ${derivedPolygon ? 'text-green-400' : 'text-amber-400'}`}>
              {cycleStatus}
            </div>
            {mode === 'parallel' && (
              <div className="text-cyan-400 truncate">
                {parallelSelected.length === 0
                  ? '선분을 클릭해 기준을 선택하세요.'
                  : parallelSelected.length === 1
                    ? `기준 선분 선택됨. 평행하게 만들 선분을 추가 선택.`
                    : `${parallelSelected.length}개 선택 (기준 1개 + 대상 ${parallelSelected.length - 1}개)`}
              </div>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            {mode === 'parallel' ? (
              <>
                <button
                  onClick={() => { parallelSelectedRef.current = []; setParallelSelected([]); }}
                  disabled={parallelSelected.length === 0}
                  className="px-3 py-2 bg-[var(--bg-soft)] hover:bg-[var(--rule)] disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] disabled:cursor-not-allowed text-[var(--ink-2)] rounded text-xs cursor-pointer">
                  선택 초기화
                </button>
                <button
                  onClick={() => applyParallel()}
                  disabled={parallelSelected.length < 2}
                  title={parallelSelected.length < 2 ? '기준 + 대상 선분 2개 이상 선택 필요' : ''}
                  className="px-3 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] disabled:cursor-not-allowed text-[var(--ink)] rounded text-xs cursor-pointer font-bold">
                  적용
                </button>
                <button
                  onClick={() => toggleParallelMode()}
                  className="px-3 py-2 bg-amber-600 hover:bg-amber-500 text-[var(--ink)] rounded text-xs cursor-pointer">
                  모드 해제
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => toggleParallelMode()}
                  disabled={!derivedPolygon}
                  title={derivedPolygon ? '' : 'cycle 형성 후 사용 가능'}
                  className="px-3 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] disabled:cursor-not-allowed text-[var(--ink)] rounded text-xs cursor-pointer">
                  평행하게 만들기
                </button>
                <button onClick={onClose}
                  className="px-4 py-2 bg-[var(--bg-soft)] hover:bg-[var(--rule)] text-[var(--ink-2)] rounded text-sm cursor-pointer">취소</button>
                <button onClick={() => {
                  if (!derivedPolygon) return;
                  onConfirm(derivedPolygon.angleDeg, derivedPolygon.polygon);
                }}
                  disabled={!derivedPolygon}
                  title={derivedPolygon ? '' : cycleStatus}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] disabled:cursor-not-allowed text-[var(--ink)] rounded text-sm cursor-pointer font-bold">확인</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
