'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SplatViewerCoreRef } from '../SplatViewerCore';
import { loadRefineState } from '@/lib/refine/persistence';
import { surfacePlanesFromRoom, type SurfacePlane } from '@/lib/gs/planes';
import { useAdditionalGsplats } from './useAdditionalGsplats';

interface Props {
  coreRef: React.RefObject<SplatViewerCoreRef>;
  uploadId: string;
  currentUrl: string;
  onDone: (newUrl: string) => void;
  onClose: () => void;
}

type Vec3 = [number, number, number];

interface PickedCorner {
  pos: Vec3;        // raw splat frame
  surfaceId: string; // 어느 면(벽/천장/바닥)에 떨어졌는지
}

// 시계방향 (왼위 → 오위 → 오아 → 왼아) — 매칭 일관성을 위해 순서 고정
const CORNERS = [
  { id: 'tl', label: '왼쪽 위',     hex: '#ef4444' },
  { id: 'tr', label: '오른쪽 위',   hex: '#facc15' },
  { id: 'br', label: '오른쪽 아래', hex: '#22c55e' },
  { id: 'bl', label: '왼쪽 아래',   hex: '#3b82f6' },
] as const;

const CORNERS_KEY_PREFIX = 'door_corners_v1_';

function loadCorners(uploadId: string): Array<PickedCorner | null> {
  try {
    const raw = localStorage.getItem(CORNERS_KEY_PREFIX + uploadId);
    if (!raw) return [null, null, null, null];
    const arr = JSON.parse(raw) as Array<PickedCorner | null>;
    if (!Array.isArray(arr) || arr.length !== 4) return [null, null, null, null];
    return arr;
  } catch { return [null, null, null, null]; }
}
function saveCorners(uploadId: string, corners: Array<PickedCorner | null>) {
  try { localStorage.setItem(CORNERS_KEY_PREFIX + uploadId, JSON.stringify(corners)); }
  catch { /* ignore */ }
}

const BASEMAP_KEY_PREFIX = 'basemap_corners_v1_';

function loadBasemapJson(uploadId: string): string {
  try {
    const raw = localStorage.getItem(BASEMAP_KEY_PREFIX + uploadId);
    return raw ?? '';
  } catch { return ''; }
}
function saveBasemapJson(uploadId: string, json: string) {
  try { localStorage.setItem(BASEMAP_KEY_PREFIX + uploadId, json); }
  catch { /* ignore */ }
}

const BASEMAP_URL_KEY_PREFIX = 'basemap_ply_url_v1_';
function loadBasemapUrl(uploadId: string): string {
  try { return localStorage.getItem(BASEMAP_URL_KEY_PREFIX + uploadId) ?? ''; }
  catch { return ''; }
}
function saveBasemapUrl(uploadId: string, url: string) {
  try { localStorage.setItem(BASEMAP_URL_KEY_PREFIX + uploadId, url); }
  catch { /* ignore */ }
}

/** 3x3 회전행렬 (row-major) → quaternion [w, x, y, z] */
function rotationMatrixToQuat(R: ArrayLike<number>): [number, number, number, number] {
  const m00 = R[0], m01 = R[1], m02 = R[2];
  const m10 = R[3], m11 = R[4], m12 = R[5];
  const m20 = R[6], m21 = R[7], m22 = R[8];
  const tr = m00 + m11 + m22;
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return [w, x, y, z];
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
}

/** "[[x,y,z],[x,y,z],[x,y,z],[x,y,z]]" 형태 JSON 파싱 */
function parseBasemapCorners(text: string): Vec3[] | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const out: Vec3[] = [];
    for (const c of parsed) {
      if (!Array.isArray(c) || c.length !== 3) return null;
      const x = Number(c[0]), y = Number(c[1]), z = Number(c[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
      out.push([x, y, z]);
    }
    return out;
  } catch { return null; }
}

/**
 * 문 4꼭짓점 추출 모달 (정합 단계).
 *
 * - 다듬기에서 저장된 벽/천장/바닥 6개 평면을 불러옴
 * - 사용자가 순서대로(시계방향: 왼위→오위→오아→왼아) 4번 클릭
 * - 각 클릭의 ray와 가장 가까운 평면의 교점을 raw 프레임에서 계산
 * - 각 코너마다 해당 색의 점 + 라벨을 화면에 표시
 *
 * Apply/target은 추후 구현 — 지금은 추출만.
 */
export default function DoorAlignModal({
  coreRef, uploadId, currentUrl, onDone, onClose,
}: Props) {
  const [picked, setPicked] = useState<Array<PickedCorner | null>>(() => loadCorners(uploadId));
  const [armedIdx, setArmedIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMarkers, setShowMarkers] = useState(true);

  // ── basemap 4 코너 (JSON 입력) ──
  const [basemapJson, setBasemapJson] = useState<string>(() => loadBasemapJson(uploadId));
  const basemapCorners = useMemo<Vec3[] | null>(() => parseBasemapCorners(basemapJson), [basemapJson]);

  // ── basemap PLY URL (입력 → 자동 로드) ──
  const [basemapUrl, setBasemapUrl] = useState<string>(() => loadBasemapUrl(uploadId));
  const additional = useAdditionalGsplats(coreRef);
  const basemapIdRef = useRef<string | null>(null);

  // URL 변경 → 이전 basemap 제거하고 새로 add
  useEffect(() => {
    const url = basemapUrl.trim();
    // 이전 것 정리
    if (basemapIdRef.current) {
      additional.remove(basemapIdRef.current);
      basemapIdRef.current = null;
    }
    if (!url || !/^https?:\/\//.test(url)) return;
    const id = additional.add(url);
    if (id) basemapIdRef.current = id;
  }, [basemapUrl, additional]);

  // ── 정합 상태 ──
  const [rmsd, setRmsd] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [aligned, setAligned] = useState(false); // 애니메이션 한 번이라도 성공했는지

  // ── 애니메이션 상태 ──
  const animRef = useRef<{
    start: number;
    duration: number;
    fromPos: [number, number, number];
    fromQuat: [number, number, number, number];  // x,y,z,w
    toPos: [number, number, number];
    toQuat: [number, number, number, number];
  } | null>(null);

  // 매 프레임 보간 적용
  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    return core.onUpdate(() => {
      const a = animRef.current;
      if (!a) return;
      const sd = core.getSplatData();
      const pc = core.getPC();
      if (!sd || !pc) return;
      const prog = Math.min(1, (performance.now() - a.start) / a.duration);
      const u = easeInOutCubic(prog);
      // lerp position
      const px = a.fromPos[0] + (a.toPos[0] - a.fromPos[0]) * u;
      const py = a.fromPos[1] + (a.toPos[1] - a.fromPos[1]) * u;
      const pz = a.fromPos[2] + (a.toPos[2] - a.fromPos[2]) * u;
      // slerp quaternion (PlayCanvas Quat은 xyzw)
      const qa = new pc.Quat(a.fromQuat[0], a.fromQuat[1], a.fromQuat[2], a.fromQuat[3]);
      const qb = new pc.Quat(a.toQuat[0], a.toQuat[1], a.toQuat[2], a.toQuat[3]);
      const qOut = new pc.Quat();
      qOut.slerp(qa, qb, u);
      sd.splatEntity.setLocalPosition(px, py, pz);
      sd.splatEntity.setLocalRotation(qOut.x, qOut.y, qOut.z, qOut.w);
      if (prog >= 1) animRef.current = null;
    });
  }, [coreRef]);

  // ── 다듬기에서 저장한 벽/천장/바닥 → 6개 평면 ──
  const planes = useMemo<SurfacePlane[] | null>(() => {
    const st = loadRefineState(uploadId);
    if (!st) return null;
    if (!st.cfConfirmed || !st.wallConfirmed) return null;
    if (st.wallAngle === null || !st.wallDistances) return null;
    return surfacePlanesFromRoom({
      angleDeg: st.wallAngle,
      walls: st.wallDistances,
      ceilingY: st.ceilingY,
      floorY: st.floorY,
    });
  }, [uploadId]);

  // ── ray-plane 교점 (raw 프레임) ──
  const raycastToPlanes = useCallback((mouseX: number, mouseY: number): PickedCorner | null => {
    if (!planes) return null;
    const core = coreRef.current;
    const cam = core?.getCamera()?.camera;
    const sd = core?.getSplatData();
    const pc = core?.getPC();
    if (!cam || !sd || !pc) return null;

    // world frame ray
    const nearW = new pc.Vec3();
    const farW = new pc.Vec3();
    cam.screenToWorld(mouseX, mouseY, cam.nearClip, nearW);
    cam.screenToWorld(mouseX, mouseY, cam.farClip, farW);

    // world → raw (splatEntity의 worldTransform 역변환)
    const inv = new pc.Mat4().copy(sd.splatEntity.getWorldTransform()).invert();
    const nearR = new pc.Vec3();
    const farR = new pc.Vec3();
    inv.transformPoint(nearW, nearR);
    inv.transformPoint(farW, farR);

    const ox = nearR.x, oy = nearR.y, oz = nearR.z;
    let dx = farR.x - ox, dy = farR.y - oy, dz = farR.z - oz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    // 가장 작은 양수 t 채택
    let bestT = Infinity;
    let bestId = '';
    let bestPoint: Vec3 | null = null;
    for (const p of planes) {
      const denom = p.normal[0]*dx + p.normal[1]*dy + p.normal[2]*dz;
      if (Math.abs(denom) < 1e-6) continue;
      const numer = p.d - (p.normal[0]*ox + p.normal[1]*oy + p.normal[2]*oz);
      const t = numer / denom;
      if (t <= 0 || t >= bestT) continue;
      bestT = t; bestId = p.id;
      bestPoint = [ox + dx*t, oy + dy*t, oz + dz*t];
    }
    if (!bestPoint) return null;
    return { pos: bestPoint, surfaceId: bestId };
  }, [coreRef, planes]);

  // ── 클릭 리스너 (armed 상태일 때만) ──
  useEffect(() => {
    if (armedIdx === null) return;
    const core = coreRef.current;
    const canvas = core?.getCanvas();
    if (!canvas) return;

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) return;
      const result = raycastToPlanes(mx, my);
      if (!result) { setError('평면과 교점을 찾지 못했습니다'); return; }
      setPicked(prev => {
        const next = [...prev];
        next[armedIdx] = result;
        saveCorners(uploadId, next);
        return next;
      });
      setArmedIdx(null);
      setError(null);
    };
    canvas.addEventListener('mouseup', onMouseUp);
    return () => canvas.removeEventListener('mouseup', onMouseUp);
  }, [armedIdx, coreRef, raycastToPlanes, uploadId]);

  // ── DOM 라벨 (코너 4개) ──
  const labelsRef = useRef<Array<HTMLDivElement | null>>([null, null, null, null]);
  useEffect(() => {
    const core = coreRef.current;
    const container = core?.getContainer();
    if (!container) return;

    const els: HTMLDivElement[] = [];
    for (let i = 0; i < 4; i++) {
      const c = CORNERS[i];
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;pointer-events:none;display:none;transform:translate(-50%,-100%);text-align:center;z-index:30;';

      const text = document.createElement('div');
      text.textContent = c.label;
      text.style.cssText = `font-size:11px;font-weight:bold;color:${c.hex};text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;margin-bottom:3px;`;
      el.appendChild(text);

      const dot = document.createElement('div');
      dot.style.cssText = `width:11px;height:11px;background:${c.hex};border:1.5px solid #fff;border-radius:50%;margin:0 auto;box-shadow:0 0 4px rgba(0,0,0,0.8);`;
      el.appendChild(dot);

      container.appendChild(el);
      els.push(el);
    }
    labelsRef.current = els;
    return () => {
      els.forEach(e => { try { e.remove(); } catch {} });
      labelsRef.current = [null, null, null, null];
    };
  }, [coreRef]);

  // ── 매 프레임 라벨 위치 업데이트 (worldToScreen) ──
  const pickedRef = useRef(picked);
  useEffect(() => { pickedRef.current = picked; }, [picked]);
  const showMarkersRef = useRef(showMarkers);
  useEffect(() => { showMarkersRef.current = showMarkers; }, [showMarkers]);

  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    const off = core.onUpdate(() => {
      const sd = core.getSplatData();
      const cam = core.getCamera()?.camera;
      const pc = core.getPC();
      if (!sd || !cam || !pc) return;

      const m = sd.splatEntity.getWorldTransform();
      const tmpRaw = new pc.Vec3();
      const tmpWorld = new pc.Vec3();
      const tmpScreen = new pc.Vec3();

      for (let i = 0; i < 4; i++) {
        const label = labelsRef.current[i];
        if (!label) continue;
        const p = pickedRef.current[i];
        if (!p || !showMarkersRef.current) { label.style.display = 'none'; continue; }
        // raw → world
        tmpRaw.set(p.pos[0], p.pos[1], p.pos[2]);
        m.transformPoint(tmpRaw, tmpWorld);
        cam.worldToScreen(tmpWorld, tmpScreen);
        // 카메라 뒤(z<0)면 숨김
        if (tmpScreen.z < 0) { label.style.display = 'none'; continue; }
        label.style.display = 'block';
        label.style.left = `${tmpScreen.x}px`;
        label.style.top = `${tmpScreen.y}px`;
      }
    });
    return off;
  }, [coreRef]);

  const clearCorner = (i: number) => {
    setPicked(prev => {
      const n = [...prev];
      n[i] = null;
      saveCorners(uploadId, n);
      return n;
    });
  };

  const clearAll = () => {
    const empty: Array<PickedCorner | null> = [null, null, null, null];
    setPicked(empty);
    saveCorners(uploadId, empty);
    setArmedIdx(null);
  };

  const allPicked = picked.every(p => p !== null);
  const [savedFlash, setSavedFlash] = useState(false);

  const confirmExtraction = () => {
    if (!allPicked) return;
    saveCorners(uploadId, picked);
    setSavedFlash(true);
    // 콘솔에도 추출된 4점을 출력해서 후속 단계에서 확인 가능하도록
    console.log('[DoorAlign] extracted corners (raw frame, CW from TL):', picked);
    setTimeout(() => setSavedFlash(false), 1200);
  };

  // ── 정합 시작 (Kabsch 계산 → 모듈 entity transform 애니메이션) ──
  const startAlignment = useCallback(async () => {
    setError(null); setRmsd(null);
    if (!allPicked) { setError('모듈 4 코너를 먼저 추출하세요'); return; }
    if (!basemapCorners) { setError('basemap 4 코너 JSON이 유효하지 않습니다'); return; }
    const core = coreRef.current;
    const pc = core?.getPC();
    const sd = core?.getSplatData();
    if (!pc || !sd) return;

    try {
      const { matchCorners } = await import('@/lib/alignment');
      const src = new Float64Array(12);
      const dst = new Float64Array(12);
      for (let i = 0; i < 4; i++) {
        const s = picked[i]!.pos;
        src[i*3] = s[0]; src[i*3+1] = s[1]; src[i*3+2] = s[2];
        const t = basemapCorners[i];
        dst[i*3] = t[0]; dst[i*3+1] = t[1]; dst[i*3+2] = t[2];
      }
      const fit = matchCorners(src, dst);
      setRmsd(fit.rmsd);
      console.log('[DoorAlign] Kabsch fit:', fit);

      // PLY entity는 Z180이 baked-in. 최종 entity transform:
      //   rotation = Z180 ∘ R_kabsch (matrix mul, 같은 의미로 quat mul z180 * R)
      //   position = Z180 * t_kabsch (Z180이 t 벡터를 회전시킴)
      const z180 = new pc.Quat();
      z180.setFromEulerAngles(0, 0, 180);

      const [qw, qx, qy, qz] = rotationMatrixToQuat(fit.R);
      const qR = new pc.Quat(qx, qy, qz, qw);
      const targetRot = new pc.Quat();
      targetRot.copy(z180).mul(qR);

      const tVec = new pc.Vec3(fit.t[0], fit.t[1], fit.t[2]);
      const tWorld = new pc.Vec3();
      z180.transformVector(tVec, tWorld);

      // 현재 entity transform을 시작값으로
      const curPos = sd.splatEntity.getLocalPosition();
      const curRot = sd.splatEntity.getLocalRotation();

      animRef.current = {
        start: performance.now(),
        duration: 1500,
        fromPos: [curPos.x, curPos.y, curPos.z],
        fromQuat: [curRot.x, curRot.y, curRot.z, curRot.w],
        toPos: [tWorld.x, tWorld.y, tWorld.z],
        toQuat: [targetRot.x, targetRot.y, targetRot.z, targetRot.w],
      };
      setAligned(true);
    } catch (e: any) {
      setError(`정합 실패: ${e?.message ?? e}`);
    }
  }, [allPicked, basemapCorners, picked, coreRef]);

  // ── 원위치 (모듈을 raw 상태로 되돌림) ──
  const resetPosition = useCallback(() => {
    const core = coreRef.current;
    const pc = core?.getPC();
    const sd = core?.getSplatData();
    if (!pc || !sd) return;
    const z180 = new pc.Quat();
    z180.setFromEulerAngles(0, 0, 180);
    const curPos = sd.splatEntity.getLocalPosition();
    const curRot = sd.splatEntity.getLocalRotation();
    animRef.current = {
      start: performance.now(),
      duration: 1500,
      fromPos: [curPos.x, curPos.y, curPos.z],
      fromQuat: [curRot.x, curRot.y, curRot.z, curRot.w],
      toPos: [0, 0, 0],
      toQuat: [z180.x, z180.y, z180.z, z180.w],
    };
    setAligned(false);
  }, [coreRef]);

  // ── 정합 미리보기 (Kabsch만 돌려 RMSD 표시) ──
  const computePreview = useCallback(async () => {
    setError(null); setRmsd(null);
    if (!allPicked) { setError('모듈 4 코너를 먼저 추출하세요'); return; }
    if (!basemapCorners) { setError('basemap 4 코너 JSON이 유효하지 않습니다'); return; }
    try {
      const { matchCorners } = await import('@/lib/alignment');
      const src = new Float64Array(12);
      const dst = new Float64Array(12);
      for (let i = 0; i < 4; i++) {
        const s = picked[i]!.pos;
        src[i*3] = s[0]; src[i*3+1] = s[1]; src[i*3+2] = s[2];
        const t = basemapCorners[i];
        dst[i*3] = t[0]; dst[i*3+1] = t[1]; dst[i*3+2] = t[2];
      }
      const fit = matchCorners(src, dst);
      setRmsd(fit.rmsd);
      console.log('[DoorAlign] Kabsch fit:', fit);
    } catch (e: any) {
      setError(`추정 실패: ${e?.message ?? e}`);
    }
  }, [allPicked, basemapCorners, picked]);

  // ── 정합 적용 + 저장 (PLY에 변환 적용해 MinIO에 업로드 → 뷰어 리로드) ──
  const applyAndSave = useCallback(async () => {
    setError(null);
    if (!allPicked) { setError('모듈 4 코너를 먼저 추출하세요'); return; }
    if (!basemapCorners) { setError('basemap 4 코너 JSON이 유효하지 않습니다'); return; }
    setRunning(true);
    try {
      const [{ fetchAndParsePly, serializePly }, { matchCorners, applyRigidToScene }] = await Promise.all([
        import('@/lib/ply'),
        import('@/lib/alignment'),
      ]);
      const { api } = await import('@/lib/api');

      const scene = await fetchAndParsePly(currentUrl);

      const src = new Float64Array(12);
      const dst = new Float64Array(12);
      for (let i = 0; i < 4; i++) {
        const s = picked[i]!.pos;
        src[i*3] = s[0]; src[i*3+1] = s[1]; src[i*3+2] = s[2];
        const t = basemapCorners[i];
        dst[i*3] = t[0]; dst[i*3+1] = t[1]; dst[i*3+2] = t[2];
      }
      const fit = matchCorners(src, dst);
      setRmsd(fit.rmsd);
      console.log('[DoorAlign] applying transform:', fit);

      applyRigidToScene(scene, fit);
      const bytes = serializePly(scene);

      const urlReq = await api.post<{ put_url: string; get_url: string }>(
        '/refine/refined-upload-url',
        { upload_id: uploadId, filename: 'aligned.ply' },
      );
      const put = await fetch(urlReq.put_url, {
        method: 'PUT',
        body: bytes,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!put.ok) throw new Error(`MinIO PUT failed: ${put.status}`);

      // 모듈 코너는 이제 basemap 좌표계로 옮겨졌으니 다음 작업에서 다시 추출
      const empty: Array<PickedCorner | null> = [null, null, null, null];
      setPicked(empty);
      saveCorners(uploadId, empty);

      onDone(urlReq.get_url);
    } catch (e: any) {
      setError(`정합 실패: ${e?.message ?? e}`);
    } finally {
      setRunning(false);
    }
  }, [allPicked, basemapCorners, picked, currentUrl, uploadId, onDone]);

  return (
    <div className="fixed right-3 top-3 z-50 bg-gray-900/95 border border-gray-700 rounded-lg shadow-2xl text-white text-xs select-none" style={{width: 380}}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        <div className="font-bold">문 꼭짓점 추출</div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 cursor-pointer text-[11px] text-gray-300" title="추출된 코너의 화면 마커 표시">
            <input
              type="checkbox"
              checked={showMarkers}
              onChange={e => setShowMarkers(e.target.checked)}
              className="cursor-pointer accent-blue-500"
            />
            마커 표시
          </label>
          <button onClick={onClose} className="text-gray-400 hover:text-white cursor-pointer">✕</button>
        </div>
      </div>
      <div className="p-3 space-y-2">
        {!planes ? (
          <div className="text-red-400 text-[11px] p-2 bg-red-900/30 border border-red-800 rounded leading-tight">
            다듬기 단계에서 천장/바닥과 벽면을 먼저 확정한 뒤 정합 단계로 진입하세요.
          </div>
        ) : (
          <div className="text-gray-400 text-[10px] leading-tight">
            시계방향 순서로 문 꼭짓점을 클릭하세요. 클릭 광선과 가장 먼저 만나는 면(벽/천장/바닥)과의 교점이 코너로 기록됩니다.
          </div>
        )}

        <div className="space-y-1">
          {CORNERS.map((c, i) => {
            const p = picked[i];
            const armed = armedIdx === i;
            const canArm = !!planes && (i === 0 || picked[i-1] !== null);
            return (
              <div key={c.id} className="flex items-center gap-2 text-[11px]">
                <div className="w-4 h-4 rounded-full shrink-0 border border-white/30" style={{ backgroundColor: c.hex }} />
                <div className="w-20 text-gray-200 shrink-0">{c.label}</div>
                <button
                  onClick={() => setArmedIdx(armed ? null : i)}
                  disabled={!canArm}
                  className={`px-2 py-1 rounded text-[10px] font-bold w-20 shrink-0 ${
                    !canArm ? 'bg-gray-800 text-gray-600 cursor-not-allowed' :
                    armed ? 'bg-yellow-500 text-black cursor-pointer' :
                    p ? 'bg-green-700 hover:bg-green-600 cursor-pointer' :
                    'bg-blue-600 hover:bg-blue-500 cursor-pointer'
                  }`}
                >{armed ? '클릭하세요' : p ? '재선택' : '선택'}</button>
                {p && (
                  <button onClick={() => clearCorner(i)} className="text-gray-500 hover:text-red-400 cursor-pointer text-[12px] shrink-0" title="삭제">×</button>
                )}
              </div>
            );
          })}
        </div>

        {picked.some(p => p !== null) && (
          <div className="border-t border-gray-700 pt-2 space-y-0.5">
            <div className="text-[10px] text-gray-500 mb-1">좌표 (raw frame)</div>
            {picked.map((p, i) => p && (
              <div key={i} className="flex items-center gap-1.5 text-[10px] font-mono text-gray-400">
                <span style={{ color: CORNERS[i].hex }}>●</span>
                <span className="text-gray-500 w-12 shrink-0">[{p.surfaceId}]</span>
                <span className="truncate">{p.pos[0].toFixed(3)}, {p.pos[1].toFixed(3)}, {p.pos[2].toFixed(3)}</span>
              </div>
            ))}
          </div>
        )}

        {error && <div className="text-red-400 text-[11px]">{error}</div>}

        <div className="flex gap-1.5 pt-1">
          <button
            onClick={clearAll}
            disabled={!picked.some(p => p !== null)}
            className="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 rounded cursor-pointer text-xs"
          >
            전체 초기화
          </button>
          <button
            onClick={confirmExtraction}
            disabled={!allPicked}
            className={`flex-1 px-3 py-1.5 rounded text-xs text-center font-bold ${
              !allPicked ? 'bg-gray-800 text-gray-500 cursor-not-allowed' :
              savedFlash ? 'bg-green-500 text-black cursor-pointer' :
              'bg-green-600 hover:bg-green-500 text-white cursor-pointer'
            }`}
          >
            {!allPicked ? `${picked.filter(Boolean).length}/4` :
             savedFlash ? '저장됨 ✓' : '추출 완료'}
          </button>
        </div>

        {/* ── basemap PLY URL + 4코너 + 정합 ── */}
        <div className="border-t border-gray-700 pt-2 space-y-1.5">
          <div className="text-[11px] font-bold text-gray-200">basemap (정합 대상)</div>

          {/* PLY URL */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">PLY URL (presigned)</span>
              <span className="text-[10px]">
                {(() => {
                  const item = additional.items.find(it => it.id === basemapIdRef.current);
                  if (!item) return basemapUrl.trim() ? <span className="text-yellow-500">URL 무효</span> : <span className="text-gray-600">미입력</span>;
                  if (item.error) return <span className="text-red-400">로드 실패</span>;
                  if (!item.loaded) return <span className="text-yellow-400">로딩 중...</span>;
                  return <span className="text-green-400">로드 완료</span>;
                })()}
              </span>
            </div>
            <input
              type="text"
              value={basemapUrl}
              onChange={e => { setBasemapUrl(e.target.value); saveBasemapUrl(uploadId, e.target.value); }}
              placeholder="https://..."
              spellCheck={false}
              className="w-full bg-gray-800 border border-gray-600 rounded px-1.5 py-1 text-[10px] font-mono"
            />
          </div>

          {/* 4 코너 JSON */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">4 코너 (시계방향, basemap raw frame)</span>
              <span className="text-[10px]">
                {basemapCorners ? <span className="text-green-400">유효</span> : <span className="text-gray-600">미입력 / 무효</span>}
              </span>
            </div>
            <textarea
              value={basemapJson}
              onChange={e => { setBasemapJson(e.target.value); saveBasemapJson(uploadId, e.target.value); }}
              placeholder='[[0,0,0],[1,0,0],[1,-2,0],[0,-2,0]]'
              spellCheck={false}
              className="w-full h-14 bg-gray-800 border border-gray-600 rounded px-1.5 py-1 text-[10px] font-mono resize-y"
            />
          </div>

          {rmsd !== null && (
            <div className="text-[11px]">
              RMSD: <span className={`font-mono font-bold ${rmsd < 0.02 ? 'text-green-400' : rmsd < 0.1 ? 'text-yellow-400' : 'text-red-400'}`}>
                {rmsd.toFixed(4)}
              </span> m
            </div>
          )}

          <div className="flex gap-1.5">
            <button
              onClick={resetPosition}
              disabled={!aligned}
              className="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 rounded cursor-pointer text-xs"
              title="모듈을 원위치(raw)로 되돌림"
            >
              원위치
            </button>
            <button
              onClick={startAlignment}
              disabled={!allPicked || !basemapCorners}
              className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded cursor-pointer text-xs font-bold"
            >
              정합 시작
            </button>
          </div>

          <button
            onClick={applyAndSave}
            disabled={running || !allPicked || !basemapCorners}
            className="w-full px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 rounded cursor-pointer text-xs font-bold"
          >
            {running ? '처리 중...' : '확정 저장 (PLY에 적용 후 업로드)'}
          </button>
        </div>
      </div>
    </div>
  );
}
