'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type SplatViewerCoreRef } from '../SplatViewerCore';
import { gsplatVisibleSigmaRadius, sigmoidOpacity } from '@/lib/gs/playcanvasGsplat';

export type DoorCleanupState = 'included' | 'excluded' | 'deleted';

type CleanupHistoryEntry = {
  states: Map<number, DoorCleanupState>;
  applied: boolean;
};

type CleanupSplatData = {
  numSplats: number;
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  colorTexture: any;
  splatEntity: any;
  resource: any;
  gsplatData: any;
};

function cleanupStatesEqual(
  a: Map<number, DoorCleanupState>,
  b: Map<number, DoorCleanupState>,
): boolean {
  const keys = new Set<number>();
  a.forEach((_, k) => keys.add(k));
  b.forEach((_, k) => keys.add(k));
  let same = true;
  keys.forEach((k) => {
    if ((a.get(k) ?? 'included') !== (b.get(k) ?? 'included')) same = false;
  });
  return same;
}

function splatDataFromEntity(ent: any): CleanupSplatData | null {
  const gs = ent?.gsplat;
  if (!gs) return null;
  const resource = gs.resource ?? gs.instance?.resource ?? null;
  const gsplatData = resource?.gsplatData ?? null;
  const colorTexture = resource?.streams?.textures?.get('splatColor') ?? null;
  if (!resource || !gsplatData || !colorTexture) return null;
  return {
    numSplats: gsplatData.numSplats,
    posX: gsplatData.getProp('x') as Float32Array,
    posY: gsplatData.getProp('y') as Float32Array,
    posZ: gsplatData.getProp('z') as Float32Array,
    colorTexture,
    splatEntity: ent,
    resource,
    gsplatData,
  };
}

interface DoorCleanupViewerModalProps {
  coreRef: React.RefObject<SplatViewerCoreRef>;
  doorSplatEntity: any | null;
  origIndexOrder: number[];
  initialStates: Map<number, DoorCleanupState>;
  busy: boolean;
  onApply: (nextStates: Map<number, DoorCleanupState>) => Promise<void> | void;
  onClose: () => void;
  /** 모달 헤더에 표시할 문 번호 라벨. 예: "문 1 다듬기". */
  doorLabel?: string;
}

export default function DoorCleanupViewerModal({
  coreRef,
  doorSplatEntity,
  origIndexOrder,
  initialStates,
  busy,
  onApply,
  onClose,
  doorLabel,
}: DoorCleanupViewerModalProps) {
  const splatDataRef = useRef<CleanupSplatData | null>(null);
  const colorSnapshotRef = useRef<Uint16Array | null>(null);
  const [mode, setMode] = useState<Exclude<DoorCleanupState, 'included'>>('excluded');
  const [eraser, setEraser] = useState(false);
  const [brushRadius, setBrushRadius] = useState(24);
  const brushRadiusRef = useRef(brushRadius);
  useEffect(() => { brushRadiusRef.current = brushRadius; }, [brushRadius]);
  const statesRef = useRef<Map<number, DoorCleanupState>>(new Map(initialStates));
  const appliedStatesRef = useRef<Map<number, DoorCleanupState>>(new Map(initialStates));
  const historyRef = useRef<CleanupHistoryEntry[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  const [counts, setCounts] = useState({ excluded: 0, deleted: 0 });
  const [viewerReadyVersion, setViewerReadyVersion] = useState(0);
  const [brushCursor, setBrushCursor] = useState<{ x: number; y: number; radius: number; visible: boolean }>({
    x: 0,
    y: 0,
    radius: brushRadius,
    visible: false,
  });

  const refreshCounts = useCallback(() => {
    let excluded = 0;
    let deleted = 0;
    for (const idx of origIndexOrder) {
      const st = statesRef.current.get(idx) ?? 'included';
      if (st === 'excluded') excluded++;
      else if (st === 'deleted') deleted++;
    }
    setCounts({ excluded, deleted });
  }, [origIndexOrder]);

  const paint = useCallback(() => {
    const core = coreRef.current;
    const sd = splatDataRef.current;
    if (!core || !sd?.colorTexture) return;
    const data = sd.colorTexture.lock?.();
    if (!data) return;
    try {
      if (!colorSnapshotRef.current || colorSnapshotRef.current.length !== data.length) {
        colorSnapshotRef.current = new Uint16Array(data);
      }
      data.set(colorSnapshotRef.current);
      const f2h = core.float2Half;
      const red = [f2h(1), f2h(0.02), f2h(0.02), f2h(1)];
      const outline = [f2h(0.1), f2h(0.9), f2h(1), f2h(0.38)];
      for (let localIdx = 0; localIdx < origIndexOrder.length; localIdx++) {
        const st = statesRef.current.get(origIndexOrder[localIdx]) ?? 'included';
        if (st === 'included') continue;
        const base = localIdx * 4;
        const color = st === 'deleted' ? red : outline;
        data[base + 0] = color[0];
        data[base + 1] = color[1];
        data[base + 2] = color[2];
        data[base + 3] = color[3];
      }
    } finally {
      sd.colorTexture.unlock();
    }
    refreshCounts();
  }, [coreRef, origIndexOrder, refreshCounts]);

  useEffect(() => {
    const data = splatDataFromEntity(doorSplatEntity);
    splatDataRef.current = data;
    colorSnapshotRef.current = null;
    setViewerReadyVersion(v => v + 1);
    setTimeout(paint, 0);
  }, [doorSplatEntity, origIndexOrder.length, paint]);

  const pushHistory = useCallback((applied: boolean) => {
    historyRef.current.push({ states: new Map(statesRef.current), applied });
    if (historyRef.current.length > 50) historyRef.current.shift();
    setUndoDepth(historyRef.current.length);
  }, []);

  const handleApply = useCallback(async () => {
    const previousApplied = new Map(appliedStatesRef.current);
    const nextStates = new Map(statesRef.current);
    let pushedApplyHistory = false;
    if (!cleanupStatesEqual(previousApplied, nextStates)) {
      historyRef.current.push({ states: previousApplied, applied: true });
      if (historyRef.current.length > 50) historyRef.current.shift();
      setUndoDepth(historyRef.current.length);
      pushedApplyHistory = true;
    }
    try {
      await onApply(nextStates);
      appliedStatesRef.current = new Map(nextStates);
    } catch (e) {
      if (pushedApplyHistory) {
        historyRef.current.pop();
        setUndoDepth(historyRef.current.length);
      }
      throw e;
    }
  }, [onApply]);

  const handleUndo = useCallback(async () => {
    const entry = historyRef.current.pop();
    setUndoDepth(historyRef.current.length);
    if (!entry) return;
    statesRef.current = new Map(entry.states);
    paint();
    if (!entry.applied) return;
    try {
      await onApply(new Map(entry.states));
      appliedStatesRef.current = new Map(entry.states);
    } catch (e) {
      historyRef.current.push(entry);
      setUndoDepth(historyRef.current.length);
      throw e;
    }
  }, [onApply, paint]);

  useEffect(() => {
    const core = coreRef.current;
    const canvas = core?.getCanvas();
    if (!core || !canvas) return;
    let painting = false;
    let strokeChanged = false;
    let lastCanvasPoint: { x: number; y: number; radius: number } | null = null;

    const pointerToCanvas = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
        radius: brushRadiusRef.current,
      };
    };

    const updateBrushCursor = (clientX: number, clientY: number, visible = true) => {
      setBrushCursor({
        x: clientX,
        y: clientY,
        radius: brushRadiusRef.current,
        visible,
      });
    };

    const updateBrushCursorForViewport = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('[data-door-cleanup-panel="true"]')) {
        updateBrushCursor(e.clientX, e.clientY, false);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      updateBrushCursor(e.clientX, e.clientY, inside);
    };

    const applyBrushAt = (mx: number, my: number, brushRadiusPx: number) => {
      const sd = splatDataRef.current;
      const cam = core.getCamera()?.camera;
      const pc = core.getPC();
      if (!sd || !cam || !pc) return;
      const tmpRaw = new pc.Vec3();
      const tmpWorld = new pc.Vec3();
      const tmpScreen = new pc.Vec3();
      const tmpExtentRaw = new pc.Vec3();
      const tmpExtentWorld = new pc.Vec3();
      const tmpExtentScreen = new pc.Vec3();
      const m = sd.splatEntity.getWorldTransform();
      const sc0 = sd.gsplatData?.getProp?.('scale_0') as Float32Array | undefined;
      const sc1 = sd.gsplatData?.getProp?.('scale_1') as Float32Array | undefined;
      const sc2 = sd.gsplatData?.getProp?.('scale_2') as Float32Array | undefined;
      const r0 = sd.gsplatData?.getProp?.('rot_0') as Float32Array | undefined;
      const r1 = sd.gsplatData?.getProp?.('rot_1') as Float32Array | undefined;
      const r2 = sd.gsplatData?.getProp?.('rot_2') as Float32Array | undefined;
      const r3 = sd.gsplatData?.getProp?.('rot_3') as Float32Array | undefined;
      const opacity = sd.gsplatData?.getProp?.('opacity') as Float32Array | undefined;
      let changed = false;
      const selectableCount = Math.min(origIndexOrder.length, sd.numSplats);
      for (let localIdx = 0; localIdx < selectableCount; localIdx++) {
        tmpRaw.set(sd.posX[localIdx], sd.posY[localIdx], sd.posZ[localIdx]);
        m.transformPoint(tmpRaw, tmpWorld);
        cam.worldToScreen(tmpWorld, tmpScreen);
        if (tmpScreen.z < 0) continue;

        let splatScreenRadius = 0;
        if (sc0 && sc1 && sc2 && r0 && r1 && r2 && r3) {
          const k = gsplatVisibleSigmaRadius(opacity ? sigmoidOpacity(opacity[localIdx]) : 1);
          const qw0 = r0[localIdx], qx0 = r1[localIdx], qy0 = r2[localIdx], qz0 = r3[localIdx];
          const qLen = Math.hypot(qw0, qx0, qy0, qz0) || 1;
          const qw = qw0 / qLen, qx = qx0 / qLen, qy = qy0 / qLen, qz = qz0 / qLen;
          const xx = qx * qx, yy = qy * qy, zz = qz * qz;
          const xy = qx * qy, xz = qx * qz, yz = qy * qz;
          const wx = qw * qx, wy = qw * qy, wz = qw * qz;
          const axes = [
            [(1 - 2 * (yy + zz)) * Math.exp(sc0[localIdx]) * k, (2 * (xy + wz)) * Math.exp(sc0[localIdx]) * k, (2 * (xz - wy)) * Math.exp(sc0[localIdx]) * k],
            [(2 * (xy - wz)) * Math.exp(sc1[localIdx]) * k, (1 - 2 * (xx + zz)) * Math.exp(sc1[localIdx]) * k, (2 * (yz + wx)) * Math.exp(sc1[localIdx]) * k],
            [(2 * (xz + wy)) * Math.exp(sc2[localIdx]) * k, (2 * (yz - wx)) * Math.exp(sc2[localIdx]) * k, (1 - 2 * (xx + yy)) * Math.exp(sc2[localIdx]) * k],
          ] as const;
          if (k > 0) {
            let maxAxisScreenLength = 0;
            for (const axis of axes) {
              let axisScreenLength = 0;
              for (const sign of [-1, 1] as const) {
                tmpExtentRaw.set(
                  sd.posX[localIdx] + axis[0] * sign,
                  sd.posY[localIdx] + axis[1] * sign,
                  sd.posZ[localIdx] + axis[2] * sign,
                );
                m.transformPoint(tmpExtentRaw, tmpExtentWorld);
                cam.worldToScreen(tmpExtentWorld, tmpExtentScreen);
                if (tmpExtentScreen.z < 0) continue;
                const ex = tmpExtentScreen.x - tmpScreen.x;
                const ey = tmpExtentScreen.y - tmpScreen.y;
                axisScreenLength = Math.max(axisScreenLength, Math.hypot(ex, ey));
              }
              maxAxisScreenLength = Math.max(maxAxisScreenLength, axisScreenLength);
            }
            splatScreenRadius = maxAxisScreenLength;
          }
        }

        const dx = tmpScreen.x - mx;
        const dy = tmpScreen.y - my;
        const hitRadius = brushRadiusPx + splatScreenRadius;
        if (dx * dx + dy * dy > hitRadius * hitRadius) continue;
        const origIdx = origIndexOrder[localIdx];
        const next = eraser ? 'included' : mode;
        if ((statesRef.current.get(origIdx) ?? 'included') === next) continue;
        statesRef.current.set(origIdx, next);
        changed = true;
      }
      if (changed) {
        strokeChanged = true;
        paint();
      }
    };

    const applyBrushStroke = (point: { x: number; y: number; radius: number }) => {
      const prev = lastCanvasPoint;
      if (!prev) {
        applyBrushAt(point.x, point.y, point.radius);
        lastCanvasPoint = point;
        return;
      }
      const dx = point.x - prev.x;
      const dy = point.y - prev.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, Math.min(prev.radius, point.radius) * 0.5);
      const steps = Math.max(1, Math.ceil(dist / step));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        applyBrushAt(
          prev.x + dx * t,
          prev.y + dy * t,
          prev.radius + (point.radius - prev.radius) * t,
        );
      }
      lastCanvasPoint = point;
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      updateBrushCursor(e.clientX, e.clientY);
      painting = true;
      strokeChanged = false;
      pushHistory(false);
      lastCanvasPoint = null;
      applyBrushStroke(pointerToCanvas(e.clientX, e.clientY));
    };
    const onMove = (e: MouseEvent) => {
      updateBrushCursor(e.clientX, e.clientY);
      if (!painting) return;
      e.preventDefault();
      e.stopPropagation();
      applyBrushStroke(pointerToCanvas(e.clientX, e.clientY));
    };
    const onEnter = (e: MouseEvent) => {
      updateBrushCursor(e.clientX, e.clientY);
    };
    const onLeave = () => {
      setBrushCursor(c => ({ ...c, visible: false }));
    };
    const onUp = () => {
      if (!painting) return;
      painting = false;
      lastCanvasPoint = null;
      if (!strokeChanged) {
        historyRef.current.pop();
        setUndoDepth(historyRef.current.length);
      }
    };
    canvas.addEventListener('mousedown', onDown, true);
    canvas.addEventListener('mousemove', onMove, true);
    canvas.addEventListener('mouseenter', onEnter, true);
    canvas.addEventListener('mouseleave', onLeave, true);
    window.addEventListener('mousemove', updateBrushCursorForViewport, true);
    window.addEventListener('mouseup', onUp, true);
    return () => {
      canvas.removeEventListener('mousedown', onDown, true);
      canvas.removeEventListener('mousemove', onMove, true);
      canvas.removeEventListener('mouseenter', onEnter, true);
      canvas.removeEventListener('mouseleave', onLeave, true);
      window.removeEventListener('mousemove', updateBrushCursorForViewport, true);
      window.removeEventListener('mouseup', onUp, true);
    };
  }, [coreRef, eraser, mode, origIndexOrder, paint, pushHistory, viewerReadyVersion]);

  return (
    <div className="fixed inset-0 pointer-events-none text-[var(--ink)]" style={{ zIndex: 1000 }}>
      {brushCursor.visible && (
        <div
          className={`fixed pointer-events-none rounded-full border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.55),0_0_18px_rgba(0,0,0,0.35)] ${
            eraser
              ? 'border-yellow-300 bg-yellow-300/10'
              : mode === 'deleted'
                ? 'border-red-400 bg-red-500/10'
                : 'border-cyan-300 bg-cyan-300/10'
          }`}
          style={{
            left: brushCursor.x - brushCursor.radius,
            top: brushCursor.y - brushCursor.radius,
            width: brushCursor.radius * 2,
            height: brushCursor.radius * 2,
            zIndex: 1000,
            boxSizing: 'border-box',
          }}
        />
      )}
      <div
        data-door-cleanup-panel="true"
        className="fixed w-[360px] rounded-lg border border-white/15 bg-black/90 p-4 text-xs shadow-xl pointer-events-auto"
        style={{ left: 24, top: 112 }}
      >
        <div className="flex items-center justify-between">
          <div className="text-sm font-bold">{doorLabel ?? '문 추출'}</div>
          <button type="button" onClick={onClose} className="text-[var(--muted)] hover:text-[var(--ink)]">x</button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => { setMode('excluded'); setEraser(false); }} className={`rounded px-2 py-2 font-bold ${mode === 'excluded' && !eraser ? 'bg-cyan-700' : 'bg-[var(--bg-soft)]'}`}>문에서 제외하기</button>
          <button type="button" onClick={() => { setMode('deleted'); setEraser(false); }} className={`rounded px-2 py-2 font-bold ${mode === 'deleted' && !eraser ? 'bg-red-700' : 'bg-[var(--bg-soft)]'}`}>제거하기</button>
          <button type="button" onClick={() => setEraser(v => !v)} className={`rounded px-2 py-2 font-bold ${eraser ? 'bg-yellow-600 text-black' : 'bg-[var(--bg-soft)]'}`}>지우개</button>
          <button
            type="button"
            disabled={busy || undoDepth === 0}
            onClick={() => { void handleUndo(); }}
            className="rounded bg-[var(--bg-soft)] px-2 py-2 font-bold disabled:opacity-50"
          >
            되돌리기
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="w-14 text-[var(--muted)]">브러쉬</span>
          <input type="range" min={6} max={90} step={1} value={brushRadius} onChange={e => setBrushRadius(Number(e.target.value))} className="flex-1 accent-cyan-500" />
          <span className="w-10 text-right font-mono">{brushRadius}px</span>
        </div>
        <div className="mt-3 rounded border border-white/10 bg-white/5 p-2 text-[11px] text-[var(--ink-2)]">
          제외 <span className="font-mono text-cyan-300">{counts.excluded}</span> · 제거 <span className="font-mono text-red-300">{counts.deleted}</span>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={busy} onClick={handleApply} className="flex-1 rounded bg-blue-600 px-3 py-2 font-bold hover:bg-blue-500 disabled:bg-[var(--bg-soft)]">적용</button>
          <button type="button" disabled={busy} onClick={onClose} className="flex-1 rounded bg-green-700 px-3 py-2 font-bold hover:bg-green-600 disabled:bg-[var(--bg-soft)]">완료</button>
        </div>
      </div>
    </div>
  );
}
