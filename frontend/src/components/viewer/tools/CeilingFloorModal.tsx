'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';

interface Props {
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  numSplats: number;
  initialCeiling: number | null;
  initialFloor: number | null;
  initialRotX?: number;
  initialRotZ?: number;
  onConfirm: (ceilingY: number, floorY: number, rotX: number, rotZ: number) => void;
  onClose: () => void;
}

// ── Auto-detect ceiling/floor from Y histogram ──

// score = count × (0.7 + 0.3 · non_empty_ratio) — Y bin의 XZ 평면 분포 균일성 반영
// 가구(한 구석에 몰림)는 낮은 점수, 천장/바닥(XZ 전반에 퍼짐)은 높은 점수
function detectBoundaryPeaks(
  posX: Float32Array, posY: Float32Array, posZ: Float32Array, numSplats: number,
): [number, number] {
  const maxSamp = 100000;
  const step = Math.max(1, Math.floor(numSplats / maxSamp));
  const sx: number[] = [], sy: number[] = [], sz: number[] = [];
  for (let i = 0; i < numSplats; i += step) { sx.push(posX[i]); sy.push(posY[i]); sz.push(posZ[i]); }

  const sortedY = [...sy].sort((a, b) => a - b);
  const p3 = sortedY[Math.floor(sortedY.length * 0.03)];
  const p97 = sortedY[Math.floor(sortedY.length * 0.97)];
  const range = p97 - p3;
  const yLo = p3 - range * 0.05, yHi = p97 + range * 0.05;

  // XZ 범위 (outlier 영향 줄이려 percentile 사용)
  const sortedX = [...sx].sort((a, b) => a - b);
  const sortedZ = [...sz].sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => arr[Math.floor(arr.length * p)];
  const xLo = pct(sortedX, 0.02), xHi = pct(sortedX, 0.98);
  const zLo = pct(sortedZ, 0.02), zHi = pct(sortedZ, 0.98);

  const bins = 120;
  const subBins = 12;          // XZ 격자: 12×12
  const neighborHalf = 2;
  const spreadWeight = 0.3;

  const bw = (yHi - yLo) / bins;
  const xw = (xHi - xLo) / subBins;
  const zw = (zHi - zLo) / subBins;
  const cells = subBins * subBins;

  const counts = new Int32Array(bins);
  const grid = new Uint8Array(bins * cells);     // occupancy per (y_bin, x_sub, z_sub)

  for (let i = 0; i < sy.length; i++) {
    const y = sy[i], x = sx[i], z = sz[i];
    if (y < yLo || y > yHi) continue;
    const yi = Math.min(bins - 1, Math.max(0, Math.floor((y - yLo) / bw)));
    counts[yi]++;
    if (x < xLo || x > xHi || z < zLo || z > zHi) continue;
    const xi = Math.min(subBins - 1, Math.max(0, Math.floor((x - xLo) / xw)));
    const zi = Math.min(subBins - 1, Math.max(0, Math.floor((z - zLo) / zw)));
    grid[yi * cells + xi * subBins + zi] = 1;
  }

  const scores = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    let mergedCount = 0;
    const occ = new Uint8Array(cells);
    for (let k = -neighborHalf; k <= neighborHalf; k++) {
      const j = i + k;
      if (j < 0 || j >= bins) continue;
      mergedCount += counts[j];
      for (let c = 0; c < cells; c++) if (grid[j * cells + c]) occ[c] = 1;
    }
    let nonEmpty = 0;
    for (let c = 0; c < cells; c++) if (occ[c]) nonEmpty++;
    const ratio = nonEmpty / cells;
    scores[i] = mergedCount * (1 - spreadWeight + spreadWeight * ratio);
  }

  const q1 = Math.floor(bins * 0.25);
  const q3 = Math.floor(bins * 0.75);
  let peakA = 0, peakB = q3;
  for (let i = 0; i < q1; i++) if (scores[i] > scores[peakA]) peakA = i;
  for (let i = q3; i < bins; i++) if (scores[i] > scores[peakB]) peakB = i;

  return [yLo + (peakA + 0.5) * bw, yLo + (peakB + 0.5) * bw];
}

// ── Canvas drawing ──

const CW = 540;
const CH = 540;
const PAD = 25;

export default function CeilingFloorModal({
  posX, posY, posZ, numSplats,
  initialCeiling, initialFloor,
  initialRotX, initialRotZ,
  onConfirm, onClose,
}: Props) {
  const xyRef = useRef<HTMLCanvasElement>(null);
  const zyRef = useRef<HTMLCanvasElement>(null);

  // 회전 (rad): R = Rz(rotZ) · Rx(rotX) 를 전체 포인트 클라우드에 적용
  const [rotX, setRotX] = useState(initialRotX ?? 0);
  const [rotZ, setRotZ] = useState(initialRotZ ?? 0);

  // Auto-detect or use initial values
  const [peaks] = useState(() => {
    if (initialCeiling !== null && initialFloor !== null) return [initialCeiling, initialFloor] as [number, number];
    return detectBoundaryPeaks(posX, posY, posZ, numSplats);
  });
  const [lineA, setLineA] = useState(peaks[0]); // top line (likely ceiling)
  const [lineB, setLineB] = useState(peaks[1]); // bottom line (likely floor)
  const [dragging, setDragging] = useState<'A' | 'B' | null>(null);

  // Pre-compute sampled indices (outlier 필터링 + 샘플링, 원본 좌표 기준)
  const sampleIdx = useRef((() => {
    const pct = (arr: Float32Array, n: number, p: number) => {
      const sorted = new Float64Array(n);
      for (let i = 0; i < n; i++) sorted[i] = arr[i];
      sorted.sort();
      return [sorted[Math.floor(n * p)], sorted[Math.floor(n * (1 - p))]];
    };
    const [yLo, yHi] = pct(posY, numSplats, 0.02);
    const [xLo, xHi] = pct(posX, numSplats, 0.02);
    const [zLo, zHi] = pct(posZ, numSplats, 0.02);
    const mg = (a: number, b: number) => (b - a) * 0.1;

    const valid: number[] = [];
    for (let i = 0; i < numSplats; i++) {
      if (posY[i] >= yLo - mg(yLo, yHi) && posY[i] <= yHi + mg(yLo, yHi) &&
          posX[i] >= xLo - mg(xLo, xHi) && posX[i] <= xHi + mg(xLo, xHi) &&
          posZ[i] >= zLo - mg(zLo, zHi) && posZ[i] <= zHi + mg(zLo, zHi)) {
        valid.push(i);
      }
    }

    const max = 40000;
    if (valid.length > max) {
      const s = valid.length / max;
      const idx: number[] = [];
      for (let i = 0; i < max; i++) idx.push(valid[Math.floor(i * s)]);
      return idx;
    }
    return valid;
  })()).current;

  // 회전된 샘플 좌표 + 경계 (rotX/rotZ 바뀔 때마다 재계산)
  const { rotX_arr, rotY_arr, rotZ_arr, bounds } = useMemo(() => {
    const cx = Math.cos(rotX), sx = Math.sin(rotX);
    const cz = Math.cos(rotZ), sz = Math.sin(rotZ);
    const N = sampleIdx.length;
    const rx = new Float32Array(N), ry = new Float32Array(N), rz = new Float32Array(N);
    let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity, mnZ = Infinity, mxZ = -Infinity;
    for (let k = 0; k < N; k++) {
      const i = sampleIdx[k];
      const x = posX[i], y = posY[i], z = posZ[i];
      const nx = cz * x - sz * cx * y + sz * sx * z;
      const ny = sz * x + cz * cx * y - cz * sx * z;
      const nz = sx * y + cx * z;
      rx[k] = nx; ry[k] = ny; rz[k] = nz;
      if (nx < mnX) mnX = nx; if (nx > mxX) mxX = nx;
      if (ny < mnY) mnY = ny; if (ny > mxY) mxY = ny;
      if (nz < mnZ) mnZ = nz; if (nz > mxZ) mxZ = nz;
    }
    return { rotX_arr: rx, rotY_arr: ry, rotZ_arr: rz, bounds: { mnX, mxX, mnY, mxY, mnZ, mxZ } };
  }, [posX, posY, posZ, sampleIdx, rotX, rotZ]);

  // 회전된 샘플 기준으로 peaks 재감지
  const redetectPeaks = useCallback(() => {
    const N = rotX_arr.length;
    // 전체 씬에 접근 불가능하므로 회전된 샘플만으로 peak 찾기
    const tmpX = new Float32Array(N), tmpY = new Float32Array(N), tmpZ = new Float32Array(N);
    for (let i = 0; i < N; i++) { tmpX[i] = rotX_arr[i]; tmpY[i] = rotY_arr[i]; tmpZ[i] = rotZ_arr[i]; }
    const [a, b] = detectBoundaryPeaks(tmpX, tmpY, tmpZ, N);
    setLineA(a); setLineB(b);
  }, [rotX_arr, rotY_arr, rotZ_arr]);

  // Draw both canvases
  const draw = useCallback(() => {
    const { mnX, mxX, mnY, mxY, mnZ, mxZ } = bounds;

    const drawView = (
      canvas: HTMLCanvasElement | null,
      hArr: Float32Array,
      minH: number, maxH: number,
      hLabel: string,
    ) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = CW * dpr;
      canvas.height = CH * dpr;
      ctx.scale(dpr, dpr);

      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, CW, CH);

      const plotW = CW - PAD * 2;
      const plotH = CH - PAD * 2;
      const scH = plotW / (maxH - minH || 1);
      const scV = plotH / (mxY - mnY || 1);

      const toX = (h: number) => PAD + (h - minH) * scH;
      const toY = (v: number) => PAD + (v - mnY) * scV;

      // 회전된 포인트
      ctx.fillStyle = 'rgba(180, 210, 255, 0.12)';
      for (let k = 0; k < hArr.length; k++) {
        ctx.fillRect(toX(hArr[k]), toY(rotY_arr[k]), 1.5, 1.5);
      }

      // 수평선
      const drawLine = (baseY: number, color: string, labelAbove: boolean) => {
        const y = toY(baseY);
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(PAD, y); ctx.lineTo(CW - PAD, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color; ctx.font = 'bold 11px monospace';
        ctx.fillText(`Y=${baseY.toFixed(2)}`, PAD + 4, labelAbove ? y - 6 : y + 14);
      };
      drawLine(lineA, '#ef4444', true);
      drawLine(lineB, '#f97316', false);

      // Axes
      ctx.strokeStyle = '#444'; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.strokeRect(PAD, PAD, plotW, plotH);
      ctx.fillStyle = '#888'; ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(hLabel, CW / 2, CH - 4);
      ctx.save(); ctx.translate(10, CH / 2); ctx.rotate(-Math.PI / 2);
      ctx.fillText('Y', 0, 0); ctx.restore();
      ctx.textAlign = 'left';
    };

    drawView(xyRef.current, rotX_arr, mnX, mxX, 'X');
    drawView(zyRef.current, rotZ_arr, mnZ, mxZ, 'Z');
  }, [lineA, lineB, bounds, rotX_arr, rotY_arr, rotZ_arr]);

  useEffect(() => { draw(); }, [draw]);

  const canvasToY = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;
    const { mnY, mxY } = bounds;
    const plotH = CH - PAD * 2;
    const scV = plotH / (mxY - mnY || 1);
    return mnY + (mouseY - PAD) / scV;
  }, [bounds]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const yVal = canvasToY(e);
    const dA = Math.abs(yVal - lineA);
    const dB = Math.abs(yVal - lineB);
    const range = bounds.mxY - bounds.mnY;
    const thresh = range * 0.03;
    if (dA < thresh && dA < dB) setDragging('A');
    else if (dB < thresh) setDragging('B');
  }, [canvasToY, lineA, lineB, bounds]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragging) return;
    const yVal = canvasToY(e);
    const clamped = Math.max(bounds.mnY, Math.min(bounds.mxY, yVal));
    if (dragging === 'A') setLineA(clamped);
    else setLineB(clamped);
  }, [dragging, canvasToY, bounds]);

  const handleMouseUp = useCallback(() => setDragging(null), []);

  // Ensure lineA < lineB (A is the smaller Y value)
  const sorted = lineA <= lineB ? { lo: lineA, hi: lineB } : { lo: lineB, hi: lineA };

  const rad2deg = (r: number) => (r * 180) / Math.PI;
  const deg2rad = (d: number) => (d * Math.PI) / 180;
  const rotXDeg = rad2deg(rotX);
  const rotZDeg = rad2deg(rotZ);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="text-white font-bold text-sm mb-1">천장 / 바닥 설정</div>
        <div className="text-gray-400 text-xs mb-3">
          슬라이더로 포인트 클라우드를 회전해 천장/바닥이 수평이 되게 맞춘 뒤, <span className="text-red-400">빨간선</span>/<span className="text-orange-400">주황선</span>을 드래그하세요.
        </div>
        <div className="flex gap-3">
          <div>
            <div className="text-gray-500 text-[10px] mb-1 text-center">정면 (XY)</div>
            <canvas ref={xyRef} style={{ width: CW, height: CH }}
              className="border border-gray-700 rounded cursor-ns-resize"
              onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} />
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="text-gray-400 w-16">Z축 회전</span>
              <input type="range" min={-180} max={180} step={0.5} value={rotZDeg}
                onChange={(e) => setRotZ(deg2rad(parseFloat(e.target.value)))}
                className="flex-1" />
              <span className="text-white font-mono w-12 text-right">{rotZDeg.toFixed(1)}°</span>
              <button onClick={() => setRotZ(0)}
                className="text-gray-500 hover:text-white text-[10px]">리셋</button>
            </div>
          </div>
          <div>
            <div className="text-gray-500 text-[10px] mb-1 text-center">측면 (ZY)</div>
            <canvas ref={zyRef} style={{ width: CW, height: CH }}
              className="border border-gray-700 rounded cursor-ns-resize"
              onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} />
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="text-gray-400 w-16">X축 회전</span>
              <input type="range" min={-180} max={180} step={0.5} value={rotXDeg}
                onChange={(e) => setRotX(deg2rad(parseFloat(e.target.value)))}
                className="flex-1" />
              <span className="text-white font-mono w-12 text-right">{rotXDeg.toFixed(1)}°</span>
              <button onClick={() => setRotX(0)}
                className="text-gray-500 hover:text-white text-[10px]">리셋</button>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between mt-4">
          <div className="text-gray-500 text-xs">
            선1: <span className="text-red-400 font-mono">{sorted.lo.toFixed(2)}</span>
            {' '}선2: <span className="text-orange-400 font-mono">{sorted.hi.toFixed(2)}</span>
            {' '}간격: <span className="text-white font-mono">{(sorted.hi - sorted.lo).toFixed(2)}</span>
          </div>
          <div className="flex gap-2">
            <button onClick={redetectPeaks}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-xs cursor-pointer">
              자동감지 재실행
            </button>
            <button onClick={onClose}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-sm cursor-pointer">
              취소
            </button>
            <button onClick={() => onConfirm(sorted.lo, sorted.hi, rotX, rotZ)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm cursor-pointer font-bold">
              확인
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
