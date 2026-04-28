'use client';

import { useRef, useEffect, useState, useCallback } from 'react';

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

  const sortedX = [...sx].sort((a, b) => a - b);
  const sortedZ = [...sz].sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => arr[Math.floor(arr.length * p)];
  const xLo = pct(sortedX, 0.02), xHi = pct(sortedX, 0.98);
  const zLo = pct(sortedZ, 0.02), zHi = pct(sortedZ, 0.98);

  const bins = 120;
  const subBins = 12;
  const neighborHalf = 2;
  const spreadWeight = 0.3;

  const bw = (yHi - yLo) / bins;
  const xw = (xHi - xLo) / subBins;
  const zw = (zHi - zLo) / subBins;
  const cells = subBins * subBins;

  const counts = new Int32Array(bins);
  const grid = new Uint8Array(bins * cells);

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

// 배경색 RGBA32 (little-endian): R=17, G=24, B=39, A=255
// 0xFF | (39<<16) | (24<<8) | 17 = 0xFF271811
const BG_RGBA32 = (255 << 24) | (39 << 16) | (24 << 8) | 17;

export default function CeilingFloorModal({
  posX, posY, posZ, numSplats,
  initialCeiling, initialFloor,
  initialRotX, initialRotZ,
  onConfirm, onClose,
}: Props) {
  const xyRef = useRef<HTMLCanvasElement>(null);
  const zyRef = useRef<HTMLCanvasElement>(null);

  // 회전: ref + DOM 직접 조작으로 React 재렌더 우회 (슬라이더 드래그 시 0회 re-render)
  const rotXRef = useRef(initialRotX ?? 0);
  const rotZRef = useRef(initialRotZ ?? 0);
  // 슬라이더 / 라벨 DOM ref
  const rotXSliderRef = useRef<HTMLInputElement>(null);
  const rotZSliderRef = useRef<HTMLInputElement>(null);
  const rotXLabelRef = useRef<HTMLSpanElement>(null);
  const rotZLabelRef = useRef<HTMLSpanElement>(null);

  // Auto-detect or use initial values
  const [peaks] = useState(() => {
    if (initialCeiling !== null && initialFloor !== null) return [initialCeiling, initialFloor] as [number, number];
    return detectBoundaryPeaks(posX, posY, posZ, numSplats);
  });
  // 라인 값도 ref로 관리해 드래그 중 React 재렌더 0회.
  const lineARef = useRef(peaks[0]);
  const lineBRef = useRef(peaks[1]);
  const draggingRef = useRef<'A' | 'B' | null>(null);
  // 하단 정보 라벨용 DOM ref
  const floorLabelRef = useRef<HTMLSpanElement>(null);
  const ceilingLabelRef = useRef<HTMLSpanElement>(null);
  const gapLabelRef = useRef<HTMLSpanElement>(null);

  // Pre-compute sampled indices
  const sampleIdx = useRef<Int32Array>(((): Int32Array => {
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

    // Wall과 비슷한 수준으로 줄여 슬라이더 드래그 시 캔버스 2개 모두 빠르게 그릴 수 있게.
    const max = 15000;
    if (valid.length > max) {
      const out = new Int32Array(max);
      const s = valid.length / max;
      for (let i = 0; i < max; i++) out[i] = valid[Math.floor(i * s)];
      return out;
    }
    return Int32Array.from(valid);
  })()).current;

  // Pre-allocated rotation buffers (재사용, 매 프레임 할당 X)
  const N = sampleIdx.length;
  const rotBuffersRef = useRef({
    x: new Float32Array(N),
    y: new Float32Array(N),
    z: new Float32Array(N),
  });
  // Pre-allocated bounds (재사용)
  const boundsRef = useRef({ mnX: 0, mxX: 0, mnY: 0, mxY: 0, mnZ: 0, mxZ: 0 });

  // Pre-allocated ImageData buffers (재사용, putImageData마다 새로 만들지 않음)
  const xyImgRef = useRef<ImageData | null>(null);
  const zyImgRef = useRef<ImageData | null>(null);
  // Pre-built blank background (Uint8ClampedArray)
  const blankBufRef = useRef<Uint8ClampedArray | null>(null);

  // Mount: 캔버스 backing + ImageData 버퍼 1회 셋업
  useEffect(() => {
    if (xyRef.current) {
      xyRef.current.width = CW; xyRef.current.height = CH;
      const ctx = xyRef.current.getContext('2d');
      if (ctx) xyImgRef.current = ctx.createImageData(CW, CH);
    }
    if (zyRef.current) {
      zyRef.current.width = CW; zyRef.current.height = CH;
      const ctx = zyRef.current.getContext('2d');
      if (ctx) zyImgRef.current = ctx.createImageData(CW, CH);
    }
    // Blank: 한 번 만들어두고 매 프레임 .set()으로 빠르게 복사
    const blank = new Uint8ClampedArray(CW * CH * 4);
    const u32 = new Uint32Array(blank.buffer);
    u32.fill(BG_RGBA32);
    blankBufRef.current = blank;
  }, []);

  // 회전된 좌표 + bounds를 in-place 갱신 (할당 없음)
  const recomputeRotated = useCallback(() => {
    const rotX = rotXRef.current, rotZ = rotZRef.current;
    const cx = Math.cos(rotX), sx = Math.sin(rotX);
    const cz = Math.cos(rotZ), sz = Math.sin(rotZ);
    const buf = rotBuffersRef.current;
    const rx = buf.x, ry = buf.y, rz = buf.z;
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
    const b = boundsRef.current;
    b.mnX = mnX; b.mxX = mxX; b.mnY = mnY; b.mxY = mxY; b.mnZ = mnZ; b.mxZ = mxZ;
  }, [posX, posY, posZ, sampleIdx, N]);

  // 단일 캔버스 그리기. 회전된 좌표는 ref에서 읽음.
  const drawView = useCallback((
    canvas: HTMLCanvasElement | null,
    img: ImageData | null,
    hArr: Float32Array,
    minH: number, maxH: number,
    hLabel: string,
    laVal: number, lbVal: number,
  ) => {
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const b = boundsRef.current;
    const plotW = CW - PAD * 2;
    const plotH = CH - PAD * 2;
    const scH = plotW / (maxH - minH || 1);
    const scV = plotH / (b.mxY - b.mnY || 1);
    const toX = (h: number) => PAD + (h - minH) * scH;
    // Y축 반전: 큰 Y(천장)가 캔버스 위쪽, 작은 Y(바닥)가 아래쪽으로 보이게
    const toY = (v: number) => PAD + (b.mxY - v) * scV;

    // 1) 빠른 background 클리어 — pre-built blank을 .set()으로 memcpy
    const blank = blankBufRef.current;
    if (blank) img.data.set(blank);

    // 2) 점 alpha-blend
    const data = img.data;
    const ALPHA = 0.18;
    const rotY_arr = rotBuffersRef.current.y;
    for (let k = 0; k < hArr.length; k++) {
      const px = (toX(hArr[k])) | 0;
      const py = (toY(rotY_arr[k])) | 0;
      if (px < 0 || px >= CW || py < 0 || py >= CH) continue;
      const o = (py * CW + px) * 4;
      data[o]     += (180 - data[o])     * ALPHA;
      data[o + 1] += (210 - data[o + 1]) * ALPHA;
      data[o + 2] += (255 - data[o + 2]) * ALPHA;
    }
    ctx.putImageData(img, 0, 0);

    // 3) 라인 + 축 (저비용)
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
    // viewer의 surface 색과 일치: 천장=cyan(#22d3ee), 바닥=violet(#a855f7)
    // lineA = top line(보통 ceiling), lineB = bottom line(보통 floor)
    // sorted.lo/hi로 비교해 위쪽이 ceiling, 아래쪽이 floor (Y 큰 쪽이 ceiling 가정)
    const isAceiling = laVal >= lbVal;
    const colorA = isAceiling ? '#22d3ee' : '#a855f7';
    const colorB = isAceiling ? '#a855f7' : '#22d3ee';
    drawLine(laVal, colorA, true);
    drawLine(lbVal, colorB, false);

    ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
    ctx.strokeRect(PAD, PAD, plotW, plotH);
    ctx.fillStyle = '#888'; ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(hLabel, CW / 2, CH - 4);
    ctx.save(); ctx.translate(10, CH / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('Y', 0, 0); ctx.restore();
    ctx.textAlign = 'left';
  }, []);

  // 두 캔버스 그리기 — 회전·라인 모두 ref에서 읽음 (재렌더 의존 X)
  const drawAll = useCallback(() => {
    recomputeRotated();
    const buf = rotBuffersRef.current;
    const b = boundsRef.current;
    const la = lineARef.current, lb = lineBRef.current;
    drawView(xyRef.current, xyImgRef.current, buf.x, b.mnX, b.mxX, 'X', la, lb);
    drawView(zyRef.current, zyImgRef.current, buf.z, b.mnZ, b.mxZ, 'Z', la, lb);
  }, [drawView, recomputeRotated]);

  // rAF 스케줄 (슬라이더 / 라인 변경 시)
  const rafRef = useRef<number | null>(null);
  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      drawAll();
    });
  }, [drawAll]);

  // mount 시 1회 draw
  useEffect(() => { scheduleDraw(); }, [scheduleDraw]);
  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  // 하단 정보 라벨을 DOM 직접 갱신 (재렌더 우회)
  const updateInfoLabels = useCallback(() => {
    const a = lineARef.current, b = lineBRef.current;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (floorLabelRef.current) floorLabelRef.current.textContent = lo.toFixed(2);
    if (ceilingLabelRef.current) ceilingLabelRef.current.textContent = hi.toFixed(2);
    if (gapLabelRef.current) gapLabelRef.current.textContent = (hi - lo).toFixed(2);
  }, []);

  // 회전된 샘플 기준으로 peaks 재감지
  const redetectPeaks = useCallback(() => {
    recomputeRotated();
    const buf = rotBuffersRef.current;
    const [a, b] = detectBoundaryPeaks(buf.x, buf.y, buf.z, buf.x.length);
    lineARef.current = a;
    lineBRef.current = b;
    updateInfoLabels();
    scheduleDraw();
  }, [recomputeRotated, updateInfoLabels, scheduleDraw]);

  // Y축 반전된 좌표 변환: 마우스 위로 갈수록 큰 Y(천장)
  const canvasToY = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseY = (e.clientY - rect.top) * (CH / rect.height);
    const b = boundsRef.current;
    const plotH = CH - PAD * 2;
    const scV = plotH / (b.mxY - b.mnY || 1);
    return b.mxY - (mouseY - PAD) / scV;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const yVal = canvasToY(e);
    const dA = Math.abs(yVal - lineARef.current);
    const dB = Math.abs(yVal - lineBRef.current);
    const b = boundsRef.current;
    const range = b.mxY - b.mnY;
    const thresh = range * 0.03;
    if (dA < thresh && dA < dB) draggingRef.current = 'A';
    else if (dB < thresh) draggingRef.current = 'B';
  }, [canvasToY]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const yVal = canvasToY(e);
    const b = boundsRef.current;
    const clamped = Math.max(b.mnY, Math.min(b.mxY, yVal));
    if (drag === 'A') lineARef.current = clamped;
    else lineBRef.current = clamped;
    updateInfoLabels();
    scheduleDraw();
  }, [canvasToY, updateInfoLabels, scheduleDraw]);

  const handleMouseUp = useCallback(() => { draggingRef.current = null; }, []);

  // 슬라이더 onChange — ref 업데이트 + DOM label 직접 갱신 (React 재렌더 0)
  const onRotZSlider = useCallback((deg: number) => {
    rotZRef.current = (deg * Math.PI) / 180;
    if (rotZLabelRef.current) rotZLabelRef.current.textContent = `${deg.toFixed(1)}°`;
    scheduleDraw();
  }, [scheduleDraw]);
  const onRotXSlider = useCallback((deg: number) => {
    rotXRef.current = (deg * Math.PI) / 180;
    if (rotXLabelRef.current) rotXLabelRef.current.textContent = `${deg.toFixed(1)}°`;
    scheduleDraw();
  }, [scheduleDraw]);
  // Reset 버튼 — slider DOM value도 동기화
  const resetRotZ = useCallback(() => {
    if (rotZSliderRef.current) rotZSliderRef.current.value = '0';
    onRotZSlider(0);
  }, [onRotZSlider]);
  const resetRotX = useCallback(() => {
    if (rotXSliderRef.current) rotXSliderRef.current.value = '0';
    onRotXSlider(0);
  }, [onRotXSlider]);

  // 초기 lo/hi (하단 라벨 default 값용 — DOM ref로 그 후 갱신됨)
  const initLo = Math.min(lineARef.current, lineBRef.current);
  const initHi = Math.max(lineARef.current, lineBRef.current);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="text-white font-bold text-sm mb-1">천장 / 바닥 설정</div>
        <div className="text-gray-400 text-xs mb-3">
          슬라이더로 포인트 클라우드를 회전해 천장/바닥이 수평이 되게 맞춘 뒤, <span style={{color:'#22d3ee'}}>천장선</span> / <span style={{color:'#a855f7'}}>바닥선</span>을 드래그하세요.
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
              <input ref={rotZSliderRef} type="range" min={-180} max={180} step={0.5}
                defaultValue={((initialRotZ ?? 0) * 180) / Math.PI}
                onInput={(e) => onRotZSlider(parseFloat((e.target as HTMLInputElement).value))}
                className="flex-1" />
              <span ref={rotZLabelRef} className="text-white font-mono w-12 text-right">
                {(((initialRotZ ?? 0) * 180) / Math.PI).toFixed(1)}°
              </span>
              <button onClick={resetRotZ} className="text-gray-500 hover:text-white text-[10px]">리셋</button>
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
              <input ref={rotXSliderRef} type="range" min={-180} max={180} step={0.5}
                defaultValue={((initialRotX ?? 0) * 180) / Math.PI}
                onInput={(e) => onRotXSlider(parseFloat((e.target as HTMLInputElement).value))}
                className="flex-1" />
              <span ref={rotXLabelRef} className="text-white font-mono w-12 text-right">
                {(((initialRotX ?? 0) * 180) / Math.PI).toFixed(1)}°
              </span>
              <button onClick={resetRotX} className="text-gray-500 hover:text-white text-[10px]">리셋</button>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between mt-4">
          <div className="text-gray-500 text-xs">
            바닥: <span ref={floorLabelRef} className="font-mono" style={{color:'#a855f7'}}>{initLo.toFixed(2)}</span>
            {' '}천장: <span ref={ceilingLabelRef} className="font-mono" style={{color:'#22d3ee'}}>{initHi.toFixed(2)}</span>
            {' '}간격: <span ref={gapLabelRef} className="text-white font-mono">{(initHi - initLo).toFixed(2)}</span>
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
            <button onClick={() => {
                const a = lineARef.current, b = lineBRef.current;
                onConfirm(Math.min(a, b), Math.max(a, b), rotXRef.current, rotZRef.current);
              }}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm cursor-pointer font-bold">
              확인
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
