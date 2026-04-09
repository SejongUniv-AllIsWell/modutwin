'use client';

import { useRef, useState, useCallback, useEffect, RefObject } from 'react';
import { SplatData, SplatViewerCoreRef } from '../SplatViewerCore';

type SelectTool = 'none' | 'paint' | 'bbox';
type PaintMode = 'union' | 'diff';

interface SelectionState {
  selected: Uint8Array;
  history: Uint8Array[];
}

interface UseGaussianSelectorOptions {
  onSelectionDone?: (indices: number[]) => void;
}

export function useGaussianSelector(
  coreRef: RefObject<SplatViewerCoreRef | null>,
  options: UseGaussianSelectorOptions = {},
) {
  const { onSelectionDone } = options;

  const [selectTool, setSelectTool] = useState<SelectTool>('none');
  const [paintMode, setPaintMode] = useState<PaintMode>('union');
  const [brushSize, setBrushSize] = useState(30);
  const [selectionCount, setSelectionCount] = useState(0);
  const [splatLoaded, setSplatLoaded] = useState(false);
  const [numSplats, setNumSplats] = useState(0);
  const brushCursorRef = useRef<HTMLDivElement | null>(null);

  // BBox state
  const bboxMinRef = useRef<[number, number, number]>([0, 0, 0]);
  const bboxMaxRef = useRef<[number, number, number]>([0, 0, 0]);
  const bboxRangeRef = useRef<{ min: [number, number, number]; max: [number, number, number] }>({ min: [-1, -1, -1], max: [1, 1, 1] });
  const [bboxMin, _setBboxMin] = useState<[number, number, number]>([0, 0, 0]);
  const [bboxMax, _setBboxMax] = useState<[number, number, number]>([0, 0, 0]);
  const setBboxMin = (v: [number, number, number]) => { bboxMinRef.current = v; _setBboxMin(v); };
  const setBboxMax = (v: [number, number, number]) => { bboxMaxRef.current = v; _setBboxMax(v); };

  const selectToolRef = useRef<SelectTool>('none');
  const paintModeRef = useRef<PaintMode>('union');
  const brushSizeRef = useRef(30);
  const selectionRef = useRef<SelectionState | null>(null);

  useEffect(() => { selectToolRef.current = selectTool; }, [selectTool]);
  useEffect(() => { paintModeRef.current = paintMode; }, [paintMode]);
  useEffect(() => { brushSizeRef.current = brushSize; }, [brushSize]);

  // ── 하이라이트 갱신 ──
  const refreshHighlight = useCallback(() => {
    const splatData = coreRef.current?.getSplatData();
    const sel = selectionRef.current;
    if (!splatData || !sel) return;

    setSelectionCount(sel.selected.reduce((acc: number, v: number) => acc + v, 0));

    if (!splatData.colorTexture || !splatData.origColorData) return;

    const data = splatData.colorTexture.lock();
    if (!data) return;

    const orig = splatData.origColorData;
    const f2h = coreRef.current!.float2Half;
    const h2f = coreRef.current!.half2Float;

    for (let i = 0; i < splatData.numSplats; i++) {
      const idx = i * 4;
      if (sel.selected[i]) {
        const r = h2f(orig[idx + 0]);
        const g = h2f(orig[idx + 1]);
        const b = h2f(orig[idx + 2]);
        data[idx + 0] = f2h(r * 0.3 + 1.0 * 0.7);
        data[idx + 1] = f2h(g * 0.3 + 1.0 * 0.7);
        data[idx + 2] = f2h(b * 0.3 + 0.0 * 0.7);
        data[idx + 3] = orig[idx + 3];
      } else {
        data[idx + 0] = orig[idx + 0];
        data[idx + 1] = orig[idx + 1];
        data[idx + 2] = orig[idx + 2];
        data[idx + 3] = orig[idx + 3];
      }
    }
    splatData.colorTexture.unlock();
  }, [coreRef]);

  // ── BBox 선택 적용 ──
  const applyBboxSelection = useCallback((min: [number, number, number], max: [number, number, number]) => {
    const splatData = coreRef.current?.getSplatData();
    const sel = selectionRef.current;
    if (!splatData || !sel) return;

    for (let i = 0; i < splatData.numSplats; i++) {
      sel.selected[i] = (
        splatData.posX[i] >= min[0] && splatData.posX[i] <= max[0] &&
        splatData.posY[i] >= min[1] && splatData.posY[i] <= max[1] &&
        splatData.posZ[i] >= min[2] && splatData.posZ[i] <= max[2]
      ) ? 1 : 0;
    }
    refreshHighlight();
  }, [coreRef, refreshHighlight]);

  const pushHistory = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel) return;
    sel.history.push(new Uint8Array(sel.selected));
    if (sel.history.length > 20) sel.history.shift();
  }, []);

  const undo = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel || !sel.history.length) return;
    sel.selected.set(sel.history.pop()!);
    refreshHighlight();
  }, [refreshHighlight]);

  const resetSelection = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel) return;
    pushHistory();
    sel.selected.fill(0);
    refreshHighlight();
  }, [pushHistory, refreshHighlight]);

  const invertSelection = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel) return;
    pushHistory();
    for (let i = 0; i < sel.selected.length; i++) { sel.selected[i] = sel.selected[i] ? 0 : 1; }
    refreshHighlight();
  }, [pushHistory, refreshHighlight]);

  const doneSelection = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel || !onSelectionDone) return;
    const indices: number[] = [];
    for (let i = 0; i < sel.selected.length; i++) {
      if (sel.selected[i]) indices.push(i);
    }
    onSelectionDone(indices);
  }, [onSelectionDone]);

  /** 인덱스 배열을 .idx 파일로 다운로드 */
  const saveIndices = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel) return;
    const indices: number[] = [];
    for (let i = 0; i < sel.selected.length; i++) {
      if (sel.selected[i]) indices.push(i);
    }
    if (indices.length === 0) return;

    const header = `# splat_count=${sel.selected.length}\n`;
    const content = header + indices.join('\n') + '\n';
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `selection_${indices.length}.idx`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  /** .idx 파일에서 인덱스를 불러와 선택 적용 */
  const loadIndices = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.idx,.txt';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        pushHistory();
        sel.selected.fill(0);

        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = parseInt(trimmed, 10);
          if (!isNaN(idx) && idx >= 0 && idx < sel.selected.length) {
            sel.selected[idx] = 1;
          }
        }
        refreshHighlight();
      };
      reader.readAsText(file);
    };
    input.click();
  }, [pushHistory, refreshHighlight]);

  // ── onSplatLoaded: 코어에 전달할 콜백 ──
  const onSplatLoaded = useCallback((data: SplatData) => {
    selectionRef.current = {
      selected: new Uint8Array(data.numSplats),
      history: [],
    };
    setNumSplats(data.numSplats);
    setSplatLoaded(true);

    // BBox 범위
    let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
    let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
    for (let i = 0; i < data.numSplats; i++) {
      if (data.posX[i] < mnX) mnX = data.posX[i]; if (data.posX[i] > mxX) mxX = data.posX[i];
      if (data.posY[i] < mnY) mnY = data.posY[i]; if (data.posY[i] > mxY) mxY = data.posY[i];
      if (data.posZ[i] < mnZ) mnZ = data.posZ[i]; if (data.posZ[i] > mxZ) mxZ = data.posZ[i];
    }
    bboxRangeRef.current = { min: [mnX, mnY, mnZ], max: [mxX, mxY, mxZ] };
    setBboxMin([mnX, mnY, mnZ]);
    setBboxMax([mxX, mxY, mxZ]);

    // ── 이벤트 연결 ──
    const canvas = coreRef.current?.getCanvas();
    const cameraEntity = coreRef.current?.getCamera();
    if (!canvas || !cameraEntity) return;

    let painting = false;
    let bboxDragAxis = -1;
    let bboxDragIsMax = false;
    let bboxDragStartVal = 0;
    let bboxDragStartMouseY = 0;
    let bboxDragScale = 1;

    const applyBrush = (mouseX: number, mouseY: number) => {
      const splatData = coreRef.current?.getSplatData();
      const sel = selectionRef.current;
      const cam = cameraEntity.camera;
      const pc = coreRef.current?.getPC();
      if (!splatData || !sel || !cam || !pc) return;

      const vpMat = new pc.Mat4();
      vpMat.mul2(cam.projectionMatrix, cam.viewMatrix);
      const m = vpMat.data;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const r2 = brushSizeRef.current * brushSizeRef.current;
      const isUnion = paintModeRef.current === 'union';

      for (let i = 0; i < splatData.numSplats; i++) {
        const px = splatData.posX[i], py = splatData.posY[i], pz = splatData.posZ[i];
        const clipW = m[3] * px + m[7] * py + m[11] * pz + m[15];
        if (clipW <= 0.01) continue;
        const invW = 1 / clipW;
        const sx = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) * invW + 1) * 0.5 * w;
        const sy = (1 - (m[1] * px + m[5] * py + m[9] * pz + m[13]) * invW) * 0.5 * h;
        const dx = sx - mouseX, dy = sy - mouseY;
        if (dx * dx + dy * dy < r2) {
          sel.selected[i] = isUnion ? 1 : 0;
        }
      }
      refreshHighlight();
    };

    const pickBboxFace = (mouseX: number, mouseY: number): { axis: number; isMax: boolean } | null => {
      const cam = cameraEntity.camera!;
      const pc = coreRef.current?.getPC();
      if (!pc) return null;
      const near = new pc.Vec3();
      const far = new pc.Vec3();
      cam.screenToWorld(mouseX, mouseY, cam.nearClip, near);
      cam.screenToWorld(mouseX, mouseY, cam.farClip, far);
      const dir = new pc.Vec3().sub2(far, near).normalize();

      const mn = bboxMinRef.current;
      const mx = bboxMaxRef.current;
      let bestT = Infinity;
      let bestResult: { axis: number; isMax: boolean } | null = null;

      const faceInfos = [
        { axis: 0, isMax: true }, { axis: 0, isMax: false },
        { axis: 1, isMax: true }, { axis: 1, isMax: false },
        { axis: 2, isMax: true }, { axis: 2, isMax: false },
      ];
      const faceVals = [mx[0], mn[0], mx[1], mn[1], mx[2], mn[2]];

      for (let fi = 0; fi < 6; fi++) {
        const axis = faceInfos[fi].axis;
        const originComp = axis === 0 ? near.x : axis === 1 ? near.y : near.z;
        const dirComp = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
        if (Math.abs(dirComp) < 1e-6) continue;
        const t = (faceVals[fi] - originComp) / dirComp;
        if (t < 0 || t >= bestT) continue;

        const hit = new pc.Vec3(near.x + dir.x * t, near.y + dir.y * t, near.z + dir.z * t);
        const axes = [0, 1, 2].filter(a => a !== axis);
        const hv = [hit.x, hit.y, hit.z];
        if (!axes.every(a => hv[a] >= mn[a] && hv[a] <= mx[a])) continue;

        bestT = t;
        bestResult = faceInfos[fi];
      }
      return bestResult;
    };

    const onMouseDown = (e: MouseEvent) => {
      const tool = selectToolRef.current;

      if (e.button === 0 && tool === 'paint') {
        painting = true;
        pushHistory();
        const rect = canvas.getBoundingClientRect();
        applyBrush(e.clientX - rect.left, e.clientY - rect.top);
        return;
      }

      if (e.button === 0 && tool === 'bbox') {
        const rect = canvas.getBoundingClientRect();
        const face = pickBboxFace(e.clientX - rect.left, e.clientY - rect.top);
        if (face) {
          bboxDragAxis = face.axis;
          bboxDragIsMax = face.isMax;
          const vals = face.isMax ? bboxMaxRef.current : bboxMinRef.current;
          bboxDragStartVal = vals[face.axis];
          bboxDragStartMouseY = e.clientY;
          const cp = cameraEntity.getLocalPosition();
          const fc = [
            (bboxMinRef.current[0] + bboxMaxRef.current[0]) / 2,
            (bboxMinRef.current[1] + bboxMaxRef.current[1]) / 2,
            (bboxMinRef.current[2] + bboxMaxRef.current[2]) / 2,
          ];
          bboxDragScale = Math.sqrt(
            (cp.x - fc[0]) ** 2 + (cp.y - fc[1]) ** 2 + (cp.z - fc[2]) ** 2
          ) * 0.003;
          pushHistory();
        }
        return;
      }
    };
    canvas.addEventListener('mousedown', onMouseDown);

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) {
        painting = false;
        bboxDragAxis = -1;
      }
    };
    window.addEventListener('mouseup', onMouseUp);

    const onMouseEnter = () => {
      if (selectToolRef.current === 'paint' && brushCursorRef.current) {
        brushCursorRef.current.style.display = 'block';
      }
    };
    const onMouseLeave = () => {
      if (brushCursorRef.current) brushCursorRef.current.style.display = 'none';
    };
    canvas.addEventListener('mouseenter', onMouseEnter);
    canvas.addEventListener('mouseleave', onMouseLeave);

    const onMouseMove = (e: MouseEvent) => {
      // 브러쉬 커서
      if (brushCursorRef.current && selectToolRef.current === 'paint') {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const sz = brushSizeRef.current * 2;
        brushCursorRef.current.style.display = 'block';
        brushCursorRef.current.style.left = `${x - sz / 2}px`;
        brushCursorRef.current.style.top = `${y - sz / 2}px`;
        brushCursorRef.current.style.width = `${sz}px`;
        brushCursorRef.current.style.height = `${sz}px`;
      } else if (brushCursorRef.current) {
        brushCursorRef.current.style.display = 'none';
      }

      // BBox drag
      if (bboxDragAxis >= 0) {
        const delta = (bboxDragStartMouseY - e.clientY) * bboxDragScale;
        let newVal = bboxDragStartVal + delta;
        const range = bboxRangeRef.current;
        newVal = Math.max(range.min[bboxDragAxis], Math.min(range.max[bboxDragAxis], newVal));

        if (bboxDragIsMax) {
          newVal = Math.max(newVal, bboxMinRef.current[bboxDragAxis] + 0.01);
          const v = [...bboxMaxRef.current] as [number, number, number];
          v[bboxDragAxis] = newVal;
          setBboxMax(v);
          applyBboxSelection(bboxMinRef.current, v);
        } else {
          newVal = Math.min(newVal, bboxMaxRef.current[bboxDragAxis] - 0.01);
          const v = [...bboxMinRef.current] as [number, number, number];
          v[bboxDragAxis] = newVal;
          setBboxMin(v);
          applyBboxSelection(v, bboxMaxRef.current);
        }
        return;
      }

      if (painting) {
        const rect = canvas.getBoundingClientRect();
        applyBrush(e.clientX - rect.left, e.clientY - rect.top);
      }
    };
    canvas.addEventListener('mousemove', onMouseMove);

    // BBox wireframe
    const bboxColor: [number, number, number, number] = [0, 1, 0.5, 1];
    const bboxColorHighlight: [number, number, number, number] = [1, 1, 0, 1];

    const unsubUpdate = coreRef.current!.onUpdate(() => {
      if (selectToolRef.current !== 'bbox') return;
      const mn = bboxMinRef.current;
      const mx = bboxMaxRef.current;

      const corners: [number, number, number][] = [
        [mn[0], mn[1], mn[2]], [mx[0], mn[1], mn[2]],
        [mx[0], mx[1], mn[2]], [mn[0], mx[1], mn[2]],
        [mn[0], mn[1], mx[2]], [mx[0], mn[1], mx[2]],
        [mx[0], mx[1], mx[2]], [mn[0], mx[1], mx[2]],
      ];
      const edges: [number, number][] = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7],
      ];

      for (const [a, b] of edges) {
        let col = bboxColor;
        if (bboxDragAxis >= 0) {
          const dragVal = bboxDragIsMax ? bboxMaxRef.current[bboxDragAxis] : bboxMinRef.current[bboxDragAxis];
          const aOnFace = Math.abs(corners[a][bboxDragAxis] - dragVal) < 0.001;
          const bOnFace = Math.abs(corners[b][bboxDragAxis] - dragVal) < 0.001;
          if (aOnFace && bOnFace) col = bboxColorHighlight;
        }
        coreRef.current!.drawLine(corners[a], corners[b], col, false);
      }
    });

    // cleanup
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseenter', onMouseEnter);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      unsubUpdate();
    };
  }, [coreRef, refreshHighlight, applyBboxSelection, pushHistory]);

  // ── UI ──
  const ui = splatLoaded ? (
    <>
      {/* 브러쉬 커서 */}
      <div ref={brushCursorRef}
        className="absolute pointer-events-none rounded-full border border-white/40"
        style={{ display: 'none', boxShadow: '0 0 4px rgba(255,255,255,0.2)' }} />

      {/* 선택 도구 패널 */}
      <div className="absolute top-3 left-3 bg-black/70 text-gray-300 text-xs rounded p-3 flex flex-col gap-2 select-none min-w-[220px]">
        <div className="text-white font-bold text-sm mb-1">가우시안 선택</div>

        <div className="flex gap-1">
          {(['paint', 'bbox'] as const).map((t) => (
            <button key={t} onClick={() => setSelectTool(prev => prev === t ? 'none' : t)}
              className={`px-2 py-1 rounded cursor-pointer ${selectTool === t ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}>
              {t === 'paint' ? '브러쉬' : 'BBox'}
            </button>
          ))}
        </div>

        {selectTool === 'paint' && (
          <div className="flex flex-col gap-1.5 mt-1">
            <div className="flex gap-1">
              <button onClick={() => setPaintMode('union')}
                className={`px-2 py-0.5 rounded cursor-pointer ${paintMode === 'union' ? 'bg-green-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}>
                + 합집합
              </button>
              <button onClick={() => setPaintMode('diff')}
                className={`px-2 py-0.5 rounded cursor-pointer ${paintMode === 'diff' ? 'bg-red-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}>
                - 차집합
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span>브러쉬</span>
              <input type="range" min="5" max="150" step="1" value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                className="w-24 h-1 accent-blue-500 cursor-pointer" />
              <div className="flex items-center justify-center" style={{ width: 40, height: 40 }}>
                <div className="rounded-full border border-white/50"
                  style={{ width: Math.min(brushSize, 36), height: Math.min(brushSize, 36) }} />
              </div>
            </div>
          </div>
        )}

        {selectTool === 'bbox' && (
          <div className="mt-1 text-[10px] text-gray-400">
            <p>좌클릭+드래그: 면을 잡아서 크기 조절</p>
            <p className="mt-0.5">
              X: [{bboxMin[0].toFixed(2)}, {bboxMax[0].toFixed(2)}]
              {' '}Y: [{bboxMin[1].toFixed(2)}, {bboxMax[1].toFixed(2)}]
              {' '}Z: [{bboxMin[2].toFixed(2)}, {bboxMax[2].toFixed(2)}]
            </p>
          </div>
        )}

        <div className="border-t border-gray-600 pt-2 mt-1">
          <div className="mb-1.5">
            선택: <span className="text-yellow-400 font-bold">{selectionCount.toLocaleString()}</span> 개
            {numSplats > 0 ? ` / ${numSplats.toLocaleString()} 개` : ''}
          </div>
          <div className="flex gap-1">
            <button onClick={undo} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded cursor-pointer">Undo</button>
            <button onClick={invertSelection} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded cursor-pointer">반전</button>
            <button onClick={resetSelection} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded cursor-pointer">Reset</button>
            {onSelectionDone && (
              <button onClick={doneSelection} className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded cursor-pointer">완료</button>
            )}
          </div>
          <div className="flex gap-1 mt-1">
            <button onClick={saveIndices} disabled={selectionCount === 0}
              className="flex-1 px-2 py-1 bg-teal-700 hover:bg-teal-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded cursor-pointer">
              저장 (.idx)
            </button>
            <button onClick={loadIndices}
              className="flex-1 px-2 py-1 bg-amber-700 hover:bg-amber-600 text-white rounded cursor-pointer">
              불러오기
            </button>
          </div>
        </div>
      </div>
    </>
  ) : null;

  return {
    ui,
    onSplatLoaded,
    selectionCount,
    selectedIndices: () => {
      const sel = selectionRef.current;
      if (!sel) return [];
      const indices: number[] = [];
      for (let i = 0; i < sel.selected.length; i++) {
        if (sel.selected[i]) indices.push(i);
      }
      return indices;
    },
  };
}
