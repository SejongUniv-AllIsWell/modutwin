'use client';

import { useRef, useEffect, useState, useMemo, useCallback } from 'react';

interface Props {
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  numSplats: number;
  ceilingY: number;
  floorY: number;
  initialAngle: number | null;
  initialWalls: [number, number, number, number] | null;
  onConfirm: (angleDeg: number, walls: [number, number, number, number]) => void;
  onClose: () => void;
}

const CW = 540;
const CH = 540;
const PAD = 25;
const BINS = 120;
const SUB_BINS = 20;           // 벽면 방향 sub-bin (spread 측정)
const NEIGHBOR_HALF = 2;       // ±2 bin 묶어서 측정 (가구 앞 가려진 벽도 살림)
const SPREAD_WEIGHT = 0.3;     // score = count × (0.7 + 0.3 · non_empty)

// Compute 2 wall peaks for a given angle (top peak in bottom 25% + top 25%)
// score = count × (0.7 + 0.3 · non_empty_ratio) — 가구 덩어리(한 구석 몰림) 페널티
function peaksAtAngle(
  pts: Float32Array, n: number, angleRad: number,
): { a: number; b: number; scoreA: number; scoreB: number; minD: number; maxD: number } {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  let mnD = Infinity, mxD = -Infinity, mnT = Infinity, mxT = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = pts[i * 2] * c + pts[i * 2 + 1] * s;
    const t = -pts[i * 2] * s + pts[i * 2 + 1] * c;
    if (d < mnD) mnD = d; if (d > mxD) mxD = d;
    if (t < mnT) mnT = t; if (t > mxT) mxT = t;
  }
  const bw = (mxD - mnD) / BINS;
  const tw = (mxT - mnT) / SUB_BINS;
  // 2D histogram: [d_bin][t_sub_bin]
  const grid = new Uint8Array(BINS * SUB_BINS); // occupancy flag
  const counts = new Int32Array(BINS);
  for (let i = 0; i < n; i++) {
    const d = pts[i * 2] * c + pts[i * 2 + 1] * s;
    const t = -pts[i * 2] * s + pts[i * 2 + 1] * c;
    const di = Math.min(BINS - 1, Math.floor((d - mnD) / bw));
    const ti = Math.min(SUB_BINS - 1, Math.floor((t - mnT) / tw));
    counts[di]++;
    grid[di * SUB_BINS + ti] = 1;
  }
  // neighbor-merged score: ±NEIGHBOR_HALF bins 묶어 count 합 + occupancy 합
  const scores = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    let mergedCount = 0;
    const occ = new Uint8Array(SUB_BINS);
    for (let k = -NEIGHBOR_HALF; k <= NEIGHBOR_HALF; k++) {
      const j = i + k;
      if (j < 0 || j >= BINS) continue;
      mergedCount += counts[j];
      for (let t = 0; t < SUB_BINS; t++) if (grid[j * SUB_BINS + t]) occ[t] = 1;
    }
    let nonEmpty = 0;
    for (let t = 0; t < SUB_BINS; t++) if (occ[t]) nonEmpty++;
    const ratio = nonEmpty / SUB_BINS;
    scores[i] = mergedCount * (1 - SPREAD_WEIGHT + SPREAD_WEIGHT * ratio);
  }
  const q1 = Math.floor(BINS * 0.25);
  const q3 = Math.floor(BINS * 0.75);
  let peakA = 0, peakB = q3;
  for (let i = 0; i < q1; i++) if (scores[i] > scores[peakA]) peakA = i;
  for (let i = q3; i < BINS; i++) if (scores[i] > scores[peakB]) peakB = i;
  return {
    a: mnD + (peakA + 0.5) * bw,
    b: mnD + (peakB + 0.5) * bw,
    scoreA: scores[peakA],
    scoreB: scores[peakB],
    minD: mnD,
    maxD: mxD,
  };
}

export default function WallModal({
  posX, posY, posZ, numSplats,
  ceilingY, floorY, initialAngle, initialWalls,
  onConfirm, onClose,
}: Props) {
  const xzRef = useRef<HTMLCanvasElement>(null);

  // Filter gaussians between ceiling and floor, trim XZ outliers via percentiles, sample
  const { pts, n } = useMemo(() => {
    const yLo = Math.min(ceilingY, floorY);
    const yHi = Math.max(ceilingY, floorY);
    const valid: number[] = [];
    for (let i = 0; i < numSplats; i++) {
      if (posY[i] >= yLo && posY[i] <= yHi) valid.push(i);
    }
    // Percentile trim (2% / 98%) on X & Z to drop distant outliers
    const xs = new Float32Array(valid.length);
    const zs = new Float32Array(valid.length);
    for (let i = 0; i < valid.length; i++) { xs[i] = posX[valid[i]]; zs[i] = posZ[valid[i]]; }
    const sortedX = Float32Array.from(xs).sort();
    const sortedZ = Float32Array.from(zs).sort();
    const p = 0.02;
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

  // Score each angle 0..90 in 0.5 steps
  const scores = useMemo(() => {
    const arr = new Float32Array(181); // 0, 0.5, ..., 90
    for (let i = 0; i < 181; i++) {
      const deg = i * 0.5;
      const rad = (deg * Math.PI) / 180;
      const p1 = peaksAtAngle(pts, n, rad);
      const p2 = peaksAtAngle(pts, n, rad + Math.PI / 2);
      arr[i] = p1.scoreA + p1.scoreB + p2.scoreA + p2.scoreB;
    }
    return arr;
  }, [pts, n]);

  const bestIdx = useMemo(() => {
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    return best;
  }, [scores]);

  const [angle, setAngle] = useState(() => initialAngle ?? bestIdx * 0.5);
  // 슬라이더 드래그가 끝났을 때만 갱신되는 angle (자동 벽 재검출 트리거용)
  const [committedAngle, setCommittedAngle] = useState(() => initialAngle ?? bestIdx * 0.5);

  // rAF throttle: 슬라이더 input 이벤트를 frame당 1회로 묶음
  const angleRef = useRef(angle);
  useEffect(() => { angleRef.current = angle; }, [angle]);
  const pendingAngle = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const flushAngle = useCallback(() => {
    rafRef.current = null;
    if (pendingAngle.current !== null) { setAngle(pendingAngle.current); pendingAngle.current = null; }
  }, []);
  const scheduleFlush = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushAngle);
  }, [flushAngle]);
  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  // 캔버스 backing 크기는 mount 시 한 번만 설정 (draw마다 재할당 비용 제거)
  useEffect(() => {
    if (xzRef.current) { xzRef.current.width = CW; xzRef.current.height = CH; }
  }, []);

  // 드래그 끝나면 호출: 마지막 angle을 확정해 자동 벽 재검출 트리거
  const commitAngle = useCallback(() => {
    let v = angleRef.current;
    if (pendingAngle.current !== null) {
      v = pendingAngle.current;
      pendingAngle.current = null;
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      setAngle(v);
    }
    setCommittedAngle(v);
  }, []);

  // 자동 검출 벽 — committedAngle 변경시에만 재계산 (드래그 중엔 stable)
  const autoWalls = useMemo(() => {
    const rad = (committedAngle * Math.PI) / 180;
    const p1 = peaksAtAngle(pts, n, rad);
    const p2 = peaksAtAngle(pts, n, rad + Math.PI / 2);
    return { dir1: p1, dir2: p2 };
  }, [pts, n, committedAngle]);

  // Editable wall values [a1, b1, a2, b2] — init from initialWalls, reset on angle change (not on mount)
  const [wallVals, setWallVals] = useState<[number, number, number, number]>(
    () => initialWalls ?? [autoWalls.dir1.a, autoWalls.dir1.b, autoWalls.dir2.a, autoWalls.dir2.b]
  );
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    setWallVals([autoWalls.dir1.a, autoWalls.dir1.b, autoWalls.dir2.a, autoWalls.dir2.b]);
  }, [autoWalls]);

  // Rotated-frame bounds (for canvas render + mouse→rot)
  const viewBounds = useMemo(() => {
    const rad = (angle * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    let mnR = Infinity, mxR = -Infinity, mnT = Infinity, mxT = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      const rx = x * c + z * s, rz = -x * s + z * c;
      if (rx < mnR) mnR = rx; if (rx > mxR) mxR = rx;
      if (rz < mnT) mnT = rz; if (rz > mxT) mxT = rz;
    }
    const mx = (mxR - mnR) * 0.05, mz = (mxT - mnT) * 0.05;
    mnR -= mx; mxR += mx; mnT -= mz; mxT += mz;
    const rangeMax = Math.max(mxR - mnR, mxT - mnT);
    const cR = (mnR + mxR) / 2, cT = (mnT + mxT) / 2;
    return {
      mnR: cR - rangeMax / 2, mxR: cR + rangeMax / 2,
      mnT: cT - rangeMax / 2, mxT: cT + rangeMax / 2,
    };
  }, [pts, n, angle]);

  const [draggingLine, setDraggingLine] = useState<number | null>(null);

  // viewer의 SURFACE_COLORS와 일치: 벽1=emerald, 벽2=blue, 벽3=violet, 벽4=lime
  const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#84cc16'];

  // Draw canvas — rotate point cloud by -angle; walls become axis-aligned lines
  const draw = useCallback(() => {
    const canvas = xzRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rad = (angle * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const { mnR, mxR, mnT, mxT } = viewBounds;
    const plotW = CW - PAD * 2;
    const plotH = CH - PAD * 2;
    const scR = plotW / (mxR - mnR || 1);
    const scT = plotH / (mxT - mnT || 1);
    const toX = (rx: number) => PAD + (rx - mnR) * scR;
    const toY = (rz: number) => PAD + (rz - mnT) * scT;

    // 배경 + 포인트를 픽셀 버퍼에 한 번에 누적해 putImageData 1회로 처리
    // (점마다 fillRect 부르던 수만 번의 콜을 제거)
    const img = ctx.createImageData(CW, CH);
    const data = img.data;
    for (let i = 0; i < CW * CH; i++) {
      const o = i * 4;
      data[o] = 17; data[o + 1] = 24; data[o + 2] = 39; data[o + 3] = 255;
    }
    const ALPHA = 0.22;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      const rx = x * c + z * s;
      const rz = -x * s + z * c;
      const px = (PAD + (rx - mnR) * scR) | 0;
      const py = (PAD + (rz - mnT) * scT) | 0;
      if (px < 0 || px >= CW || py < 0 || py >= CH) continue;
      const o = (py * CW + px) * 4;
      data[o]     += (180 - data[o])     * ALPHA;
      data[o + 1] += (210 - data[o + 1]) * ALPHA;
      data[o + 2] += (255 - data[o + 2]) * ALPHA;
    }
    ctx.putImageData(img, 0, 0);

    const drawVLine = (v: number, color: string, bold: boolean) => {
      ctx.strokeStyle = color; ctx.lineWidth = bold ? 3 : 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(toX(v), PAD); ctx.lineTo(toX(v), CH - PAD); ctx.stroke();
    };
    const drawHLine = (v: number, color: string, bold: boolean) => {
      ctx.strokeStyle = color; ctx.lineWidth = bold ? 3 : 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(PAD, toY(v)); ctx.lineTo(CW - PAD, toY(v)); ctx.stroke();
    };
    drawVLine(wallVals[0], COLORS[0], draggingLine === 0);
    drawVLine(wallVals[1], COLORS[1], draggingLine === 1);
    drawHLine(wallVals[2], COLORS[2], draggingLine === 2);
    drawHLine(wallVals[3], COLORS[3], draggingLine === 3);

    ctx.setLineDash([]);
    ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
    ctx.strokeRect(PAD, PAD, plotW, plotH);
    ctx.fillStyle = '#888'; ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('X′', CW / 2, CH - 4);
    ctx.save();
    ctx.translate(10, CH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Z′', 0, 0);
    ctx.restore();
  }, [pts, n, angle, viewBounds, wallVals, draggingLine]);

  useEffect(() => { draw(); }, [draw]);

  // Mouse → rotated coords
  const mouseToRot = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (CW / rect.width);
    const my = (e.clientY - rect.top) * (CH / rect.height);
    const { mnR, mxR, mnT, mxT } = viewBounds;
    const plotW = CW - PAD * 2, plotH = CH - PAD * 2;
    const rx = mnR + (mx - PAD) * (mxR - mnR) / plotW;
    const rz = mnT + (my - PAD) * (mxT - mnT) / plotH;
    return { rx, rz };
  }, [viewBounds]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { rx, rz } = mouseToRot(e);
    const thr = (viewBounds.mxR - viewBounds.mnR) * 0.03;
    const ds = [
      Math.abs(rx - wallVals[0]),
      Math.abs(rx - wallVals[1]),
      Math.abs(rz - wallVals[2]),
      Math.abs(rz - wallVals[3]),
    ];
    let best = -1, bestD = thr;
    for (let i = 0; i < 4; i++) if (ds[i] < bestD) { bestD = ds[i]; best = i; }
    if (best >= 0) setDraggingLine(best);
  }, [mouseToRot, wallVals, viewBounds]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggingLine === null) return;
    const { rx, rz } = mouseToRot(e);
    setWallVals(prev => {
      const v = [...prev] as [number, number, number, number];
      v[draggingLine] = draggingLine < 2 ? rx : rz;
      return v;
    });
  }, [draggingLine, mouseToRot]);

  const handleMouseUp = useCallback(() => setDraggingLine(null), []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="text-white font-bold text-sm mb-1">벽면 설정</div>
        <div className="text-gray-400 text-xs mb-3">
          슬라이더로 회전, 각 선(<span style={{color:'#10b981'}}>벽1</span>/<span style={{color:'#3b82f6'}}>벽2</span>/<span style={{color:'#8b5cf6'}}>벽3</span>/<span style={{color:'#84cc16'}}>벽4</span>)은 드래그해서 평행이동.
        </div>
        <div>
          <div className="text-gray-500 text-[10px] mb-1 text-center">Top-down (XZ)</div>
          <canvas ref={xzRef} style={{ width: CW, height: CH }}
            className="border border-gray-700 rounded cursor-crosshair"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="text-gray-400 text-xs w-14">회전각</span>
          <input type="range" min="0" max="90" step="0.5" value={angle}
            onChange={(e) => { pendingAngle.current = parseFloat(e.target.value); scheduleFlush(); }}
            onMouseUp={commitAngle}
            onTouchEnd={commitAngle}
            className="flex-1 h-1 accent-blue-500 cursor-pointer" />
          <span className="text-white font-mono text-xs w-14 text-right">{angle.toFixed(1)}°</span>
          <button onClick={() => { setAngle(bestIdx * 0.5); setCommittedAngle(bestIdx * 0.5); }}
            className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded cursor-pointer text-xs">
            자동 ({(bestIdx * 0.5).toFixed(1)}°)
          </button>
        </div>
        <div className="flex items-center justify-between mt-3">
          <div className="text-gray-500 text-xs font-mono">
            <span style={{color:'#10b981'}}>벽1</span>: {wallVals[0].toFixed(2)}{' '}
            <span style={{color:'#3b82f6'}}>벽2</span>: {wallVals[1].toFixed(2)}{' '}
            <span style={{color:'#8b5cf6'}}>벽3</span>: {wallVals[2].toFixed(2)}{' '}
            <span style={{color:'#84cc16'}}>벽4</span>: {wallVals[3].toFixed(2)}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-sm cursor-pointer">취소</button>
            <button onClick={() => onConfirm(angle, wallVals)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm cursor-pointer font-bold">확인</button>
          </div>
        </div>
      </div>
    </div>
  );
}
