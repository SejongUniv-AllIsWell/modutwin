'use client';

import { useRef, useEffect, useState, useMemo, useCallback } from 'react';

interface Props {
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  numSplats: number;
  ceilingY: number;
  floorY: number;
  /** 정합 결과로 산출되는 4벽 (axis-aligned, 회전각 + [a1,b1,a2,b2]). 폴리곤에서 derive 됨. */
  onConfirm: (angleDeg: number, walls: [number, number, number, number]) => void;
  onClose: () => void;
}

const CW = 540;
const CH = 540;
const PAD = 25;
const PATH_POINT_RADIUS = 5;
const PATH_POINT_HOVER_RADIUS = 6.5;
const PATH_POINT_HIT_RADIUS = 14;

type PathPoint = { x: number; z: number };
type PathEdge = { from: number; to: number };
type PathAction =
  | { type: 'point'; pointIdx: number; edge: PathEdge | null; prevSelected: number }
  | { type: 'edge'; edge: PathEdge; prevSelected: number }
  | { type: 'move'; pointIdx: number; prev: PathPoint };

function normalizeAngle90(deg: number): number {
  let d = ((deg % 180) + 180) % 180;
  if (d >= 90) d -= 90;
  return d;
}

/**
 * 폴리곤 점들로부터 axis-aligned 4벽 산출.
 *  - 점 분포의 주축 (eigenvector) 으로 angle 결정.
 *  - 그 frame 의 min/max 두 축 → 4벽 [a1, b1, a2, b2].
 *
 * 현재 4벽 출력은 임시 — 추후 N-벽 (TODO: surfacePlanesFromPolygon 와 연계) 으로 확장 예정.
 */
function wallsFromPath(points: PathPoint[]): { angleDeg: number; walls: [number, number, number, number] } | null {
  if (points.length < 2) return null;
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
  const angleDeg = normalizeAngle90(rawDeg);
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  let minD1 = Infinity, maxD1 = -Infinity, minD2 = Infinity, maxD2 = -Infinity;
  for (const p of points) {
    const d1 = p.x * c + p.z * s;
    const d2 = -p.x * s + p.z * c;
    if (d1 < minD1) minD1 = d1;
    if (d1 > maxD1) maxD1 = d1;
    if (d2 < minD2) minD2 = d2;
    if (d2 > maxD2) maxD2 = d2;
  }
  return { angleDeg, walls: [minD1, maxD1, minD2, maxD2] };
}

/**
 * 벽면 설정 모달 — 사용자가 캔버스 위 가우시안 top-down view 에 점/선으로 폴리곤을 그리면
 * eigenvector 기반으로 회전 + 4벽을 derive 한다.
 *
 * 조작:
 *  - 좌클릭 빈 공간 → 새 점 추가. 직전 선택점이 있으면 자동으로 edge 연결.
 *  - 좌클릭 기존 점 → 그 점 선택 (다음 빈 공간 클릭 시 그 점으로부터 edge).
 *  - 기존 점 드래그 → 점 이동 (캔버스 밖으로 나가도 추적; document mouseup 시 종료).
 *  - 우클릭 → 마지막 조작 1단계 undo (점 추가 / edge 추가 / 점 이동).
 *
 * 향후 (TODO): N-벽 자유 (현재는 가장 큰 axis-aligned bbox 만 derive). 폴리곤 그대로 텍스처 베이크.
 */
export default function WallModal({
  posX, posY, posZ, numSplats,
  ceilingY, floorY,
  onConfirm, onClose,
}: Props) {
  const xzRef = useRef<HTMLCanvasElement>(null);

  // 천장/바닥 사이 가우시안만 필터 + XZ 가장자리 outlier 정리 + 샘플링 (60k 상한).
  const { pts, n } = useMemo(() => {
    const yLo = Math.min(ceilingY, floorY);
    const yHi = Math.max(ceilingY, floorY);
    const valid: number[] = [];
    for (let i = 0; i < numSplats; i++) {
      if (posY[i] >= yLo && posY[i] <= yHi) valid.push(i);
    }
    // 0.5%/99.5% percentile trim — 멀리 떨어진 노이즈만 제거 (방 경계는 보존).
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
    const trimmed: number[] = [];
    for (const idx of valid) {
      if (posX[idx] >= xLo && posX[idx] <= xHi && posZ[idx] >= zLo && posZ[idx] <= zHi) trimmed.push(idx);
    }
    const max = 60000;
    const stride = trimmed.length > max ? trimmed.length / max : 1;
    const count = Math.min(trimmed.length, max);
    const out = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const idx = trimmed[Math.floor(i * stride)];
      out[i * 2] = posX[idx];
      out[i * 2 + 1] = posZ[idx];
    }
    return { pts: out, n: count };
  }, [posX, posY, posZ, numSplats, ceilingY, floorY]);

  // 캔버스 backing 크기 — mount 시 한 번만.
  useEffect(() => {
    if (xzRef.current) { xzRef.current.width = CW; xzRef.current.height = CH; }
  }, []);

  // 캔버스 표시 영역 — pts XZ bbox + 5% 여백, 정사각 비율 유지.
  const viewBounds = useMemo(() => {
    let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      if (x < mnX) mnX = x; if (x > mxX) mxX = x;
      if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
    }
    const mx = (mxX - mnX) * 0.05, mz = (mxZ - mnZ) * 0.05;
    mnX -= mx; mxX += mx; mnZ -= mz; mxZ += mz;
    const rangeMax = Math.max(mxX - mnX, mxZ - mnZ);
    const cX = (mnX + mxX) / 2, cZ = (mnZ + mxZ) / 2;
    return {
      mnR: cX - rangeMax / 2, mxR: cX + rangeMax / 2,
      mnT: cZ - rangeMax / 2, mxT: cZ + rangeMax / 2,
    };
  }, [pts, n]);

  const [pathPoints, setPathPoints] = useState<PathPoint[]>([]);
  const [pathEdges, setPathEdges] = useState<PathEdge[]>([]);
  const [hoverPointIdx, setHoverPointIdx] = useState<number>(-1);
  const [selectedPointIdx, setSelectedPointIdx] = useState<number>(-1);
  const pathPointsRef = useRef<PathPoint[]>([]);
  const pathEdgesRef = useRef<PathEdge[]>([]);
  const pathActionsRef = useRef<PathAction[]>([]);
  const selectedPointIdxRef = useRef<number>(-1);

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

    // 폴리곤 edge.
    if (pathEdges.length > 0) {
      ctx.setLineDash([]);
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

    // 폴리곤 점.
    for (let i = 0; i < pathPoints.length; i++) {
      const p = pathPoints[i];
      const px = toX(p.x);
      const py = toY(p.z);
      const isHover = i === hoverPointIdx;
      const isSelected = i === selectedPointIdx;
      const radius = isHover ? PATH_POINT_HOVER_RADIUS : PATH_POINT_RADIUS;
      ctx.fillStyle = isSelected ? '#f59e0b' : '#22d3ee';
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
  }, [pts, n, viewBounds, pathPoints, pathEdges, hoverPointIdx, selectedPointIdx]);

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
    if (e.button !== 0) return;
    e.preventDefault();
    const { rx, rz } = mouseToWorld(e);
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
  }, [addPathEdge, findPathPointHit, mouseToWorld, nativeToWorld, selectPathPoint]);

  // hover 표시만 — 드래그는 document listener 가 담당.
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { rx, rz } = mouseToWorld(e);
    setHoverPointIdx(findPathPointHit(rx, rz));
  }, [mouseToWorld, findPathPointHit]);

  // 우클릭 — 마지막 조작 1단계 undo.
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const action = pathActionsRef.current.pop();
    if (!action) return;

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

  // edge 에 사용된 점들만 모아 wallsFromPath 로 4벽 derive.
  const derivedWalls = useMemo(() => {
    if (pathEdges.length === 0) return null;
    const used = new Set<number>();
    for (const edge of pathEdges) {
      if (pathPoints[edge.from] && pathPoints[edge.to]) {
        used.add(edge.from);
        used.add(edge.to);
      }
    }
    if (used.size < 2) return null;
    const worldPoints = Array.from(used, (idx) => pathPoints[idx]);
    return wallsFromPath(worldPoints);
  }, [pathPoints, pathEdges]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="text-white font-bold text-sm mb-1">벽면 설정</div>
        <div className="text-gray-400 text-xs mb-3">
          좌클릭으로 점과 선을 추가, 기존 점은 드래그로 이동. 점을 클릭하면 직전에 선택한 점과 연결되고, 우클릭은 마지막 조작을 되돌립니다.
        </div>
        <div>
          <div className="text-gray-500 text-[10px] mb-1 text-center">Top-down (XZ)</div>
          <canvas ref={xzRef} style={{ width: CW, height: CH, userSelect: 'none' }}
            className="border border-gray-700 rounded cursor-crosshair"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onContextMenu={handleContextMenu} />
        </div>
        <div className="flex items-center justify-between mt-3">
          <div className="text-gray-500 text-xs font-mono">
            {`점 ${pathPoints.length}개, 선 ${pathEdges.length}개${derivedWalls ? `, 각도 ${derivedWalls.angleDeg.toFixed(1)}°` : ''}`}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-sm cursor-pointer">취소</button>
            <button onClick={() => {
              if (!derivedWalls) return;
              onConfirm(derivedWalls.angleDeg, derivedWalls.walls);
            }}
              disabled={!derivedWalls}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white rounded text-sm cursor-pointer font-bold">확인</button>
          </div>
        </div>
      </div>
    </div>
  );
}
