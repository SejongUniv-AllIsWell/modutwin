'use client';

import { useRef, useState, useCallback, useEffect, RefObject } from 'react';
import { SplatData, SplatViewerCoreRef } from '../SplatViewerCore';

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

  // ── Align API state ──
  const [aligning, setAligning] = useState(false);
  const sourceKeyRef = useRef<string | null>(null);

  const syncPlanes = useCallback(() => setPlanes([...planesRef.current]), []);

  // ── Highlight: planes ──
  const recomputePlanes = useCallback(() => {
    const data = splatDataRef.current; const core = coreRef.current;
    if (!data || !core || planesRef.current.length === 0) {
      setOutsideCount(0); setClosed(false);
      if (data?.colorTexture && data?.origColorData) {
        const td = data.colorTexture.lock(); if (td) { td.set(data.origColorData); data.colorTexture.unlock(); }
      }
      return;
    }
    const codes = computeCellCodes(data.posX, data.posY, data.posZ, data.numSplats, planesRef.current);
    const keep = findKeepCell(codes);
    cellCodesRef.current = codes; keepCellRef.current = keep;
    let out = 0; for (let i = 0; i < codes.length; i++) if (codes[i] !== keep) out++;
    setOutsideCount(out); setClosed(isClosed(keep, planesRef.current.length));

    if (!data.colorTexture || !data.origColorData) return;
    const td = data.colorTexture.lock(); if (!td) return;
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
    data.colorTexture.unlock();
  }, [coreRef]);

  // ── Highlight: brush/bbox selection → red ──
  const refreshSelection = useCallback(() => {
    const data = splatDataRef.current; const core = coreRef.current; const sel = selectionRef.current;
    if (!data || !core || !sel) return;
    let cnt = 0; for (let i = 0; i < sel.length; i++) if (sel[i]) cnt++;
    setSelectionCount(cnt);
    if (!data.colorTexture || !data.origColorData) return;
    const td = data.colorTexture.lock(); if (!td) return;
    const orig = data.origColorData; const f2h = core.float2Half; const h2f = core.half2Float;
    for (let i = 0; i < data.numSplats; i++) {
      const idx = i * 4;
      if (sel[i]) {
        const r = h2f(orig[idx]), g = h2f(orig[idx+1]), b = h2f(orig[idx+2]);
        td[idx] = f2h(r*0.3+1.0*0.7); td[idx+1] = f2h(g*0.3+0.1*0.7); td[idx+2] = f2h(b*0.3+0.1*0.7); td[idx+3] = orig[idx+3];
      } else { td[idx]=orig[idx]; td[idx+1]=orig[idx+1]; td[idx+2]=orig[idx+2]; td[idx+3]=orig[idx+3]; }
    }
    data.colorTexture.unlock();
  }, [coreRef]);

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

  // ── Plane: align to wall (backend API call) ──
  const alignToPlane = useCallback(async () => {
    if (!options?.uploadId || !options?.reloadWithUrl || planesRef.current.length === 0) return;
    setAligning(true);
    try {
      const { api } = await import('@/lib/api');
      // 선택된 평면 사용, 없으면 첫 번째 평면
      const planeIdx = selectedPlaneRef.current >= 0 ? selectedPlaneRef.current : 0;
      const plane = planesRef.current[planeIdx];
      const res = await api.post<{ url: string; source_key: string }>('/refine/align', {
        upload_id: options.uploadId,
        source_key: sourceKeyRef.current,
        plane: { normal: [...plane.normal], d: plane.d },
        thickness: 0.05,
      });
      sourceKeyRef.current = res.source_key;
      options.reloadWithUrl(res.url);
    } catch (e: any) {
      alert(`정렬 실패: ${e.message || e}`);
    } finally {
      setAligning(false);
    }
  }, [options]);

  // ── Save refined result ──
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const saveRefined = useCallback(async () => {
    if (!options?.uploadId || !sourceKeyRef.current) return;
    setSaving(true);
    try {
      const { api } = await import('@/lib/api');
      await api.post<{ scene_id: string; message: string }>('/refine/save', {
        upload_id: options.uploadId,
        source_key: sourceKeyRef.current,
      });
      setSaved(true);
    } catch (e: any) {
      alert(`저장 실패: ${e.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [options]);

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
  const resetAll = useCallback(() => {
    const data = splatDataRef.current; const pristine = pristineRef.current;
    if (!data || !pristine || !data.colorTexture) return;
    data.origColorData = new Uint16Array(pristine);
    const td = data.colorTexture.lock(); if (td) { td.set(pristine); data.colorTexture.unlock(); }
    planesRef.current = []; setPlanes([]); setSelectedPlane(-1); selectedPlaneRef.current = -1; setOutsideCount(0); setClosed(false);
    if (selectionRef.current) selectionRef.current.fill(0); setSelectionCount(0);
  }, []);

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
    const applyBrush = (mouseX: number, mouseY: number) => {
      const sd = splatDataRef.current; const sel = selectionRef.current;
      const cam = cameraEntity.camera; const pc = pcRef.current;
      if (!sd || !sel || !cam || !pc) return;
      const vpMat = new pc.Mat4(); vpMat.mul2(cam.projectionMatrix, cam.viewMatrix);
      const m = vpMat.data; const w = canvas.clientWidth, h = canvas.clientHeight;
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
        const ps = planesRef.current; if (ps.length === 0) return;
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

      <div className="absolute top-3 left-3 bg-black/70 text-gray-300 text-xs rounded p-3 flex flex-col gap-2 select-none min-w-[230px]">
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
            <button onClick={addPlane} disabled={planes.length>=20}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 text-white rounded cursor-pointer text-xs">
              + 평면 추가
            </button>
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
                {options?.uploadId && (
                  <button onClick={alignToPlane} disabled={aligning}
                    className="mt-1 px-3 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 text-white rounded cursor-pointer font-bold text-xs">
                    {aligning ? '정렬 중...' : '벽면 정렬'}
                  </button>
                )}
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

        {/* Save */}
        {options?.uploadId && sourceKeyRef.current && (
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

        {/* Reset (공통) */}
        <button onClick={resetAll} className="mt-1 px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded cursor-pointer text-xs">
          전체 리셋
        </button>
      </div>
    </>
  ) : null;

  return { ui, onSplatLoaded, planes };
}
