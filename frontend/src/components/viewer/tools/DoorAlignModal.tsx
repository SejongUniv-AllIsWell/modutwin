'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SplatViewerCoreRef } from '../SplatViewerCore';
import { loadRefineState } from '@/lib/refine/persistence';
import { surfacePlanesFromRoom, type SurfacePlane } from '@/lib/gs/planes';
import { useAdditionalGsplats } from './useAdditionalGsplats';
import type { GaussianScene } from '@/lib/ply/types';
import type { BoundarySubUpdate } from '@/lib/gs/doorTrim';
import { api } from '@/lib/api';

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

// SPEC (docs/sam3_alignment_pipeline.md): doors.json 은 서버 (`uploads/{id}/refined/doors.json`)
// 에 저장된다. 통째 덮어쓰기 — 이력 보존 안 함. 본 모달은 단일 문(door_1)만 다루지만
// SAM3 결과로 여러 문이 들어와있을 수 있으므로 door_1 (또는 첫 번째 항목) 만 추출해서 편집.

const PRIMARY_DOOR_ID = 'door_1';

interface DoorsJson { doors: Array<{ id: string; corners: number[][] }> }

function emptyPicked(): Array<PickedCorner | null> {
  return [null, null, null, null];
}

async function fetchDoorsFromServer(uploadId: string): Promise<Array<PickedCorner | null>> {
  try {
    const data = await api.get<DoorsJson>(`/uploads/${uploadId}/doors`);
    if (!data.doors || data.doors.length === 0) return emptyPicked();
    const target = data.doors.find(d => d.id === PRIMARY_DOOR_ID) ?? data.doors[0];
    if (!target?.corners || target.corners.length !== 4) return emptyPicked();
    // 서버에는 surfaceId 정보가 없으므로 빈 문자열로 두고, 사용자가 다시 클릭해 보정 가능.
    return target.corners.map(c => ({ pos: [c[0], c[1], c[2]] as Vec3, surfaceId: '' }));
  } catch (e: any) {
    // 401/404 등은 빈 상태로 진행 (정상)
    return emptyPicked();
  }
}

async function persistDoorsToServer(uploadId: string, corners: Array<PickedCorner | null>) {
  // 모든 코너가 채워졌을 때만 doors.json 갱신 (부분 입력 상태로 SAM3 결과를 덮지 않도록).
  const allFilled = corners.every(c => c !== null);
  if (!allFilled) return;
  const door = {
    id: PRIMARY_DOOR_ID,
    corners: corners.map(c => [c!.pos[0], c!.pos[1], c!.pos[2]]),
  };
  try {
    // 기존 다른 door_* 항목은 보존 — fetch → splice → put.
    const existing = await api.get<DoorsJson>(`/uploads/${uploadId}/doors`).catch(() => ({ doors: [] }));
    const others = (existing.doors ?? []).filter(d => d.id !== PRIMARY_DOOR_ID);
    await api.put(`/uploads/${uploadId}/doors`, { doors: [door, ...others] });
  } catch (e: any) {
    console.warn('[doors] persist 실패', e);
  }
}

async function clearDoorsOnServer(uploadId: string) {
  // door_1 만 제거 (다른 문은 유지).
  try {
    const existing = await api.get<DoorsJson>(`/uploads/${uploadId}/doors`).catch(() => ({ doors: [] }));
    const others = (existing.doors ?? []).filter(d => d.id !== PRIMARY_DOOR_ID);
    await api.put(`/uploads/${uploadId}/doors`, { doors: others });
  } catch (e: any) {
    console.warn('[doors] clear 실패', e);
  }
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
  const [picked, setPicked] = useState<Array<PickedCorner | null>>(() => emptyPicked());

  // 모달이 열릴 때 서버 doors.json 으로부터 door_1 (또는 SAM3 결과 첫 항목) 로드
  useEffect(() => {
    let cancelled = false;
    fetchDoorsFromServer(uploadId).then(corners => {
      if (cancelled) return;
      const hasAny = corners.some(c => c !== null);
      if (hasAny) setPicked(corners);
    });
    return () => { cancelled = true; };
  }, [uploadId]);
  const [outlineActive, setOutlineActive] = useState(false); // 추출 완료 → 4 코너 outline 표시
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
        // 모든 코너가 채워지면 서버에 영속화 (도중엔 SAM3 결과를 덮지 않도록 보류).
        void persistDoorsToServer(uploadId, next);
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
      // 부분 입력 상태 — 서버 doors.json 은 그대로 두고 다음 완성 시 갱신.
      return n;
    });
    setOutlineActive(false);
  };

  const clearAll = () => {
    const empty: Array<PickedCorner | null> = [null, null, null, null];
    setPicked(empty);
    void clearDoorsOnServer(uploadId);
    setArmedIdx(null);
    setOutlineActive(false);
  };

  // 4점 outline 그리기 (추출 완료 후) — z180 으로 변환해서 world 좌표로 즉시 라인.
  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    return core.onUpdate(() => {
      if (!outlineActive) return;
      const pcLib = core.getPC();
      const app = core.getApp();
      if (!pcLib || !app) return;
      const ps = picked;
      if (!ps.every(p => p !== null)) return;
      // raw → world 변환 (z180 적용 = (x,y,z) → (-x,-y,z))
      const corners4: any[] = [];
      for (let i = 0; i < 4; i++) {
        const p = ps[i]!.pos;
        corners4.push(new pcLib.Vec3(-p[0], -p[1], p[2]));
      }
      const yellow = new pcLib.Color(1, 1, 0);
      app.drawLine(corners4[0], corners4[1], yellow, false);
      app.drawLine(corners4[1], corners4[2], yellow, false);
      app.drawLine(corners4[2], corners4[3], yellow, false);
      app.drawLine(corners4[3], corners4[0], yellow, false);
    });
  }, [coreRef, outlineActive, picked]);

  const allPicked = picked.every(p => p !== null);
  const [savedFlash, setSavedFlash] = useState(false);

  const confirmExtraction = () => {
    if (!allPicked) return;
    void persistDoorsToServer(uploadId, picked);
    setSavedFlash(true);
    setOutlineActive(true); // 4점 outline 표시 시작
    // 콘솔에도 추출된 4점을 출력해서 후속 단계에서 확인 가능하도록
    console.log('[DoorAlign] extracted corners (raw frame, CW from TL):', picked);
    setTimeout(() => setSavedFlash(false), 1200);
  };

  // ── 텍스처맵 저장 (디버그) ──
  // 6개 wall mesh + 1개 도어 영역 = 총 7개 PNG 다운로드. 사용자 Downloads 폴더로.
  const downloadRgbaAsPng = async (rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, filename: string): Promise<void> => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.createImageData(w, h);
    const len = Math.min(imageData.data.length, rgba.length);
    for (let i = 0; i < len; i++) imageData.data[i] = rgba[i];
    ctx.putImageData(imageData, 0, 0);
    return new Promise<void>((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) { resolve(); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        resolve();
      }, 'image/png');
    });
  };

  // GPU 텍스처에서 픽셀을 직접 읽기 — 서버 로드 텍스처는 lock() 으로 못 읽음 (CPU side 없음).
  // 임시 framebuffer 에 첨부해 gl.readPixels.
  const readTextureFromGPU = (tex: any, app: any): { rgba: Uint8ClampedArray; w: number; h: number } | null => {
    const w = tex.width, h = tex.height;
    if (!w || !h) return null;
    const device = app.graphicsDevice;
    const gl = device?.gl;
    if (!gl) return null;
    const glTex = tex.impl?._glTexture ?? tex._impl?._glTexture ?? tex._glTexture;
    if (!glTex) return null;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glTex, 0);
    let rgba: Uint8ClampedArray | null = null;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status === gl.FRAMEBUFFER_COMPLETE) {
      const tmp = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
      // readPixels 는 bottom-up. canvas 그리기는 top-down 이므로 row flip.
      const flipped = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const srcOff = (h - 1 - y) * w * 4;
        const dstOff = y * w * 4;
        for (let i = 0; i < w * 4; i++) flipped[dstOff + i] = tmp[srcOff + i];
      }
      rgba = flipped;
    } else {
      console.warn(`[SaveTex] FB incomplete: 0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return rgba ? { rgba, w, h } : null;
  };

  const saveAllTextureMaps = async () => {
    const core = coreRef.current;
    const app = core?.getApp();
    if (!core || !app || !allPicked || !planes) {
      console.warn('[SaveTex] prerequisites not met');
      return;
    }

    // 1. Wall mesh 6개 저장
    const surfaces = ['ceiling', 'floor', 'w1a', 'w1b', 'w2a', 'w2b'];
    for (const sid of surfaces) {
      const ent = findEntityByName(app.root, `wallMesh_${sid}`);
      const tex = ent?.render?.meshInstances?.[0]?.material?.emissiveMap;
      if (!tex) {
        console.warn(`[SaveTex] wallMesh_${sid} not found in app.root`);
        continue;
      }
      const result = readTextureFromGPU(tex, app);
      if (!result) {
        console.warn(`[SaveTex] wallMesh_${sid} GPU read failed`);
        continue;
      }
      const { rgba, w, h } = result;
      let rmin = 255, rmax = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i] < rmin) rmin = rgba[i];
        if (rgba[i] > rmax) rmax = rgba[i];
      }
      console.log(`[SaveTex] wallMesh_${sid}: ${w}×${h}, alpha=0 pixels: ${countAlpha0(rgba)}, R range=[${rmin},${rmax}]`);
      await downloadRgbaAsPng(rgba, w, h, `wallMesh_${sid}.png`);
    }

    // 2. 도어 영역 저장 — 추출 ON 상태면 기존 mesh, 아니면 fresh bake
    const doorSurfaceId = picked[0]!.surfaceId;
    if (doorMeshEntityRef.current) {
      const tex = doorMeshEntityRef.current.render?.meshInstances?.[0]?.material?.emissiveMap;
      if (tex) {
        const lvl = tex.lock();
        if (lvl) {
          const w = tex.width, h = tex.height;
          const rgba = new Uint8ClampedArray(w * h * 4);
          const lim = Math.min(rgba.length, (lvl as any).length ?? 0);
          for (let i = 0; i < lim; i++) rgba[i] = (lvl as any)[i];
          tex.unlock();
          console.log(`[SaveTex] doorMesh_${doorSurfaceId}: ${w}×${h}`);
          await downloadRgbaAsPng(rgba, w, h, `doorMesh_${doorSurfaceId}.png`);
        } else {
          try { tex.unlock(); } catch {}
        }
      }
    } else {
      // Fresh bake
      try {
        const wallPlane = planes.find(p => p.id === doorSurfaceId);
        if (!wallPlane) throw new Error('wall plane not found');
        const projectFn = (p: Vec3): Vec3 => {
          const n = wallPlane.normal;
          const sdv = n[0]*p[0]+n[1]*p[1]+n[2]*p[2] - wallPlane.d;
          return [p[0]-sdv*n[0], p[1]-sdv*n[1], p[2]-sdv*n[2]];
        };
        const corners: [Vec3, Vec3, Vec3, Vec3] = [
          projectFn(picked[0]!.pos),
          projectFn(picked[1]!.pos),
          projectFn(picked[2]!.pos),
          projectFn(picked[3]!.pos),
        ];
        if (!cachedSceneRef.current) {
          const { fetchAndParsePly } = await import('@/lib/ply');
          cachedSceneRef.current = await fetchAndParsePly(currentUrl);
        }
        const { decomposeBoundaryGaussians, doorPlaneBakeInput } = await import('@/lib/gs/doorTrim');
        const decomp = decomposeBoundaryGaussians(cachedSceneRef.current, { corners }, {
          safetyMargin: doorSafetyMargin,
          doorThickness,
        });
        const { filterScene } = await import('@/lib/ply');
        const keepDoor = new Uint8Array(cachedSceneRef.current.numSplats);
        for (const i of decomp.doorOriginalIndices) keepDoor[i] = 1;
        const doorScene = filterScene(cachedSceneRef.current, keepDoor);
        const { bakeTextureForPlane } = await import('@/lib/gs/textureBake');
        const bakeInput = doorPlaneBakeInput(corners, wallPlane.normal);
        const doorBake = await bakeTextureForPlane(bakeInput, doorScene, { depthGate: doorBakeGate });
        console.log(`[SaveTex] doorRegion_${doorSurfaceId}: ${doorBake.width}×${doorBake.height} (fresh bake)`);
        await downloadRgbaAsPng(doorBake.rgba, doorBake.width, doorBake.height, `doorRegion_${doorSurfaceId}.png`);
      } catch (e) {
        console.error('[SaveTex] door fresh bake failed:', e);
      }
    }
    console.log('[SaveTex] DONE — 7 PNG files in Downloads');
  };

  const countAlpha0 = (rgba: Uint8ClampedArray): number => {
    let n = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 0) n++;
    return n;
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

  // ────────────────────────────────────────────────────────────────────
  // 문 경계 정제 (boundary 가우시안 분할 + wall mesh 도어 영역 alpha=0 + 도어 mesh)
  //
  // 토글 ON  → applyDoorRefine: cachedScene 으로 분할 계산 → main PLY GPU in-place
  //            (boundary slot → wall-side sub) + door-side sub blob → additional splat
  //            + door mesh 베이크 + wall 텍스처 alpha=0 punch.
  // 토글 OFF → revertDoorRefine: 모든 변경 원복.
  // 슬라이더 변경 (활성 상태 시) → 600ms 디바운스 후 재적용.
  // ────────────────────────────────────────────────────────────────────
  const [doorRefineActive, setDoorRefineActive] = useState(false);
  const [doorRefining, setDoorRefining] = useState(false);
  const [doorRefineError, setDoorRefineError] = useState<string | null>(null);
  const [doorBakeGate, setDoorBakeGate] = useState(0.05);   // 도어 mesh 베이크 depthGate (m)
  const [doorSafetyMargin, setDoorSafetyMargin] = useState(0); // 분할 후 sub scale 에 추가 (1-margin) 곱
  const [doorThickness, setDoorThickness] = useState(0.3);     // 문 두께 (m). doorOriginalIndices 깊이 필터 (±thickness/2 from wall plane).
  const [boundarySplitEnabled, setBoundarySplitEnabled] = useState(true); // 가장자리 가우시안 분할 (SAGS-style). 끄면 추출만, split 안 함.
  const [doorRefineStats, setDoorRefineStats] = useState<{ N: number; nBoundary: number; nDoorOrig: number } | null>(null);

  const cachedSceneRef = useRef<GaussianScene | null>(null);
  // 메인 PLY 의 boundary 슬롯 in-place 변경 전 snapshot — 원복용.
  const boundarySnapshotRef = useRef<Array<{ idx: number; x: number; y: number; z: number; s0: number; s1: number; s2: number }>>([]);
  const doorSubGsplatIdRef = useRef<string | null>(null);
  const doorSubBlobUrlRef = useRef<string | null>(null);
  const doorMeshEntityRef = useRef<any>(null);
  const wallMeshNameRef = useRef<string | null>(null);
  const wallTexSnapshotRef = useRef<Uint8ClampedArray | null>(null);
  // 메인 PLY 의 doorOriginalIndices 들 — 정제 ON 시 숨김 (scale → -30) 하기 전 원본 scale snapshot.
  const doorOrigSnapshotRef = useRef<Array<{ idx: number; s0: number; s1: number; s2: number }>>([]);
  // doorOrig 들의 colorTexture alpha snapshot (정제 ON 시 alpha=0 적용 → invisible 보장).
  const doorOrigAlphaSnapshotRef = useRef<Array<{ idx: number; alpha: number }>>([]);
  // 디버그 노랑 틴트용 — 추가 gsplat 의 원본 colorTexture 데이터 + 도어 mesh 의 원본 emissive.
  const doorGsplatOrigColorsRef = useRef<Uint16Array | null>(null);
  const doorMeshOrigEmissiveRef = useRef<{ r: number; g: number; b: number } | null>(null);

  // 디버그: 문 내부로 분류된 가우시안 인덱스 (decomp.doorOriginalIndices) — 정제 적용 후 토글로 표시.
  const doorOriginalIndicesRef = useRef<number[]>([]);
  const [doorInternalShow, setDoorInternalShow] = useState(false);

  // ── 힌지 선택 + 회전 ──
  // hingeIndices: picked[] 의 인덱스 두 개 (TL=0, TR=1, BR=2, BL=3 중 두 개)
  const [hingeIndices, setHingeIndices] = useState<number[]>([]);
  const [doorAngleDeg, setDoorAngleDeg] = useState(60);
  const [doorSwing, setDoorSwing] = useState<1 | -1>(1); // 1: 방 안쪽, -1: 방 바깥쪽
  const [doorRotated, setDoorRotated] = useState(false);

  const toggleHinge = (i: number) => {
    setHingeIndices(prev => {
      if (prev.includes(i)) return prev.filter(x => x !== i);
      if (prev.length >= 2) return [prev[1], i]; // 가장 오래된 것 밀어내기
      return [...prev, i];
    });
  };

  // app.root 트리에서 이름으로 entity 찾기.
  const findEntityByName = useCallback((root: any, name: string): any | null => {
    if (!root) return null;
    if (root.name === name) return root;
    const children = root.children || [];
    for (const c of children) {
      const r = findEntityByName(c, name);
      if (r) return r;
    }
    return null;
  }, []);

  // 메인 splat data 의 boundary 슬롯들에 wall-side sub 데이터 in-place 적용 (GPU sync 포함).
  const applyBoundaryUpdatesToGPU = useCallback((
    splatData: any,
    updates: BoundarySubUpdate[],
    float2Half: (v: number) => number,
  ) => {
    const gsplat = splatData.gsplatData;
    const sc0 = gsplat?.getProp('scale_0');
    const sc1 = gsplat?.getProp('scale_1');
    const sc2 = gsplat?.getProp('scale_2');
    if (!sc0 || !sc1 || !sc2) {
      console.warn('[DoorRefine] gsplatData scale props missing');
      return;
    }
    const tA = splatData.transformATexture;
    const tB = splatData.transformBTexture;
    const dataA = tA?.lock();
    const dataAF32 = dataA ? new Float32Array(dataA.buffer) : null;
    const dataB = tB?.lock();
    for (const u of updates) {
      splatData.posX[u.idx] = u.wallNewPos[0];
      splatData.posY[u.idx] = u.wallNewPos[1];
      splatData.posZ[u.idx] = u.wallNewPos[2];
      sc0[u.idx] = u.wallNewLogScale[0];
      sc1[u.idx] = u.wallNewLogScale[1];
      sc2[u.idx] = u.wallNewLogScale[2];
      if (dataAF32) {
        dataAF32[u.idx*4 + 0] = u.wallNewPos[0];
        dataAF32[u.idx*4 + 1] = u.wallNewPos[1];
        dataAF32[u.idx*4 + 2] = u.wallNewPos[2];
      }
      if (dataB) {
        dataB[u.idx*4 + 0] = float2Half(Math.exp(u.wallNewLogScale[0]));
        dataB[u.idx*4 + 1] = float2Half(Math.exp(u.wallNewLogScale[1]));
        dataB[u.idx*4 + 2] = float2Half(Math.exp(u.wallNewLogScale[2]));
      }
    }
    if (tA) tA.unlock();
    if (tB) tB.unlock();
    const inst = (splatData.splatEntity as any)?.gsplat?.instance;
    if (inst?.sorter?.centers) {
      for (const u of updates) {
        inst.sorter.centers[u.idx*3 + 0] = u.wallNewPos[0];
        inst.sorter.centers[u.idx*3 + 1] = u.wallNewPos[1];
        inst.sorter.centers[u.idx*3 + 2] = u.wallNewPos[2];
      }
      inst.sorter.setMapping(null);
      inst.lastCameraPosition.set(Infinity, Infinity, Infinity);
    }
  }, []);

  // 토글 OFF: 모든 변경 원복.
  const revertDoorRefine = useCallback(async () => {
    console.log('[DoorRefine] revert START');
    try {
      const core = coreRef.current;
      const sd = core?.getSplatData();
      const float2Half = core?.float2Half;

      // 1. boundary 슬롯 GPU 복원
      try {
        if (sd && float2Half && boundarySnapshotRef.current.length > 0) {
          const restoreUpdates: BoundarySubUpdate[] = boundarySnapshotRef.current.map(s => ({
            idx: s.idx,
            wallNewPos: [s.x, s.y, s.z],
            wallNewLogScale: [s.s0, s.s1, s.s2],
          }));
          applyBoundaryUpdatesToGPU(sd, restoreUpdates, float2Half);
        }
      } catch (e) { console.error('[DoorRefine] revert step 1 (boundary restore):', e); }
      boundarySnapshotRef.current = [];

      // 1b. doorOriginalIndices 슬롯 scale 복원 (숨김 → 원본)
      try {
        if (sd && float2Half && doorOrigSnapshotRef.current.length > 0) {
          const restoreOrigs: BoundarySubUpdate[] = doorOrigSnapshotRef.current.map(s => ({
            idx: s.idx,
            wallNewPos: [sd.posX[s.idx], sd.posY[s.idx], sd.posZ[s.idx]],
            wallNewLogScale: [s.s0, s.s1, s.s2],
          }));
          applyBoundaryUpdatesToGPU(sd, restoreOrigs, float2Half);
        }
      } catch (e) { console.error('[DoorRefine] revert step 1b (doorOrig restore):', e); }
      doorOrigSnapshotRef.current = [];

      // 1c. doorOrig colorTexture alpha 복원
      try {
        if (sd?.colorTexture && doorOrigAlphaSnapshotRef.current.length > 0) {
          const td = sd.colorTexture.lock();
          if (td) {
            for (const s of doorOrigAlphaSnapshotRef.current) {
              td[s.idx * 4 + 3] = s.alpha;
            }
            sd.colorTexture.unlock();
          }
        }
      } catch (e) { console.error('[DoorRefine] revert step 1c (alpha restore):', e); }
      doorOrigAlphaSnapshotRef.current = [];

      // 2. additional door splat 제거
      try {
        if (doorSubGsplatIdRef.current) {
          additional.remove(doorSubGsplatIdRef.current);
          doorSubGsplatIdRef.current = null;
        }
        if (doorSubBlobUrlRef.current) {
          try { URL.revokeObjectURL(doorSubBlobUrlRef.current); } catch {}
          doorSubBlobUrlRef.current = null;
        }
      } catch (e) { console.error('[DoorRefine] revert step 2 (additional remove):', e); }

      // 3. door mesh entity 제거
      try {
        if (doorMeshEntityRef.current) {
          try { doorMeshEntityRef.current.destroy(); } catch {}
          doorMeshEntityRef.current = null;
        }
      } catch (e) { console.error('[DoorRefine] revert step 3 (door mesh destroy):', e); }

      // 4. wall mesh 텍스처 복원 — lvl 이 TypedArray 가 아닐 수 있어 인덱스 복사로 수행.
      try {
        if (wallTexSnapshotRef.current && wallMeshNameRef.current) {
          const app = core?.getApp();
          if (app) {
            const wallEnt = findEntityByName(app.root, wallMeshNameRef.current);
            const tex = wallEnt?.render?.meshInstances?.[0]?.material?.emissiveMap;
            if (tex) {
              const lvl: any = tex.lock();
              if (lvl) {
                const src = wallTexSnapshotRef.current;
                const len = Math.min(lvl.length ?? 0, src.length);
                if (typeof lvl.set === 'function' && lvl.length === src.length) {
                  lvl.set(src);
                } else {
                  for (let i = 0; i < len; i++) lvl[i] = src[i];
                }
              }
              tex.unlock();
            }
          }
        }
      } catch (e) { console.error('[DoorRefine] revert step 4 (wall tex restore):', e); }
      wallTexSnapshotRef.current = null;
      wallMeshNameRef.current = null;

      // 5. 회전 애니메이션 / 상태 정리
      doorAnimRef.current = null;
      doorCurrentAngleRef.current = 0;
      lastDoorHingeRef.current = null;
      // 노랑 tint snapshot 도 정리 (도어 entity 들이 destroy 되면 의미 없음)
      doorGsplatOrigColorsRef.current = null;
      doorMeshOrigEmissiveRef.current = null;

      setDoorRefineActive(false);
      setDoorRefineError(null);
      setDoorRefineStats(null);
      setDoorRotated(false);
      console.log('[DoorRefine] revert COMPLETE');
    } catch (e) {
      console.error('[DoorRefine] revert outer error:', e);
      // 그래도 상태는 OFF 로 풀어 줌 — 사용자가 다시 ON 못 누르는 상황 방지.
      setDoorRefineActive(false);
      setDoorRefineError(null);
      setDoorRefineStats(null);
      setDoorRotated(false);
    }
  }, [coreRef, additional, applyBoundaryUpdatesToGPU, findEntityByName]);

  // 토글 ON 또는 슬라이더 변경 시 재적용.
  const applyDoorRefine = useCallback(async () => {
    console.log('[DoorRefine] apply START');
    setDoorRefineError(null);
    setDoorRefining(true);
    try {
      // 0. 검증
      if (!allPicked) throw new Error('도어 4점을 먼저 추출하세요');
      const surfaceIds = picked.map(p => p!.surfaceId);
      if (new Set(surfaceIds).size > 1) throw new Error('도어 4점이 같은 면 위에 있어야 합니다');
      const wallSurfaceId = surfaceIds[0];

      const core = coreRef.current;
      const pc = core?.getPC();
      const app = core?.getApp();
      const sd = core?.getSplatData();
      const float2Half = core?.float2Half;
      if (!pc || !app || !sd || !float2Half) throw new Error('PlayCanvas 미준비');

      // 1. 이전 상태가 있으면 먼저 원복
      if (doorRefineActive || boundarySnapshotRef.current.length > 0
          || doorSubGsplatIdRef.current || doorMeshEntityRef.current) {
        await revertDoorRefine();
      }

      // 2. cachedScene 확보 (PLY parse 1회만)
      if (!cachedSceneRef.current) {
        const { fetchAndParsePly } = await import('@/lib/ply');
        cachedSceneRef.current = await fetchAndParsePly(currentUrl);
      }
      const scene = cachedSceneRef.current;

      // 3. 분할 계산
      // 사용자가 찍은 4점이 wall plane 에서 약간 어긋나 있을 수 있어 (raycast 가 정확히 같은 면 안 맞을 때)
      // wall plane 으로 투영해 평면 quad 보장 (비평면 quad 는 mesh fold 시각 이상의 원인).
      const wallPlaneFor3 = planes?.find(p => p.id === picked[0]!.surfaceId);
      const projectToWall = (p: Vec3): Vec3 => {
        if (!wallPlaneFor3) return p;
        const n = wallPlaneFor3.normal;
        const sd0 = n[0]*p[0] + n[1]*p[1] + n[2]*p[2] - wallPlaneFor3.d;
        return [p[0] - sd0*n[0], p[1] - sd0*n[1], p[2] - sd0*n[2]];
      };
      const corners: [Vec3, Vec3, Vec3, Vec3] = [
        projectToWall(picked[0]!.pos),
        projectToWall(picked[1]!.pos),
        projectToWall(picked[2]!.pos),
        projectToWall(picked[3]!.pos),
      ];
      const { decomposeBoundaryGaussians, buildDoorSubScene, doorPlaneBakeInput, punchAlphaZeroInDoorRegion }
        = await import('@/lib/gs/doorTrim');
      const decomp = decomposeBoundaryGaussians(scene, { corners }, {
        safetyMargin: doorSafetyMargin,
        doorThickness,
      });
      doorOriginalIndicesRef.current = decomp.doorOriginalIndices.slice();
      console.log(`[DoorRefine] N=${scene.numSplats}, boundary=${decomp.boundaryIndices.length}, doorOrig=${decomp.doorOriginalIndices.length}, wallOrig=${decomp.wallOriginalIndices.length}`);
      setDoorRefineStats({
        N: scene.numSplats,
        nBoundary: decomp.boundaryIndices.length,
        nDoorOrig: decomp.doorOriginalIndices.length,
      });

      // 4. boundary 슬롯 snapshot (in-place 변경 전) — boundary split 활성 시만
      const sc0 = sd.gsplatData?.getProp('scale_0');
      const sc1 = sd.gsplatData?.getProp('scale_1');
      const sc2 = sd.gsplatData?.getProp('scale_2');
      if (!sc0 || !sc1 || !sc2) throw new Error('gsplatData scale props missing');
      if (boundarySplitEnabled) {
        boundarySnapshotRef.current = decomp.boundaryIndices.map(i => ({
          idx: i,
          x: sd.posX[i], y: sd.posY[i], z: sd.posZ[i],
          s0: sc0[i], s1: sc1[i], s2: sc2[i],
        }));

        // 5. wall-side updates GPU 적용 (boundary 가우시안 → 벽쪽 sub 만 메인 PLY 에 남김)
        applyBoundaryUpdatesToGPU(sd, decomp.wallSideUpdates, float2Half);
      } else {
        boundarySnapshotRef.current = [];
      }

      // 5b. doorOriginalIndices 메인 PLY 에서 숨김 — 회전 시 메인 PLY 잔상이 "복제본만 회전" 처럼 보이지 않게.
      // (i) scale → -30 (≈ 0): 가우시안 footprint 0.
      // (ii) colorTexture alpha → 0: 추가 안전장치 (PlayCanvas brush 삭제와 동일 메커니즘, 확실히 invisible).
      const HIDE_LOGSCALE = -30;
      doorOrigSnapshotRef.current = decomp.doorOriginalIndices.map(i => ({
        idx: i,
        s0: sc0[i], s1: sc1[i], s2: sc2[i],
      }));
      const hideUpdates: BoundarySubUpdate[] = decomp.doorOriginalIndices.map(i => ({
        idx: i,
        wallNewPos: [sd.posX[i], sd.posY[i], sd.posZ[i]],
        wallNewLogScale: [HIDE_LOGSCALE, HIDE_LOGSCALE, HIDE_LOGSCALE],
      }));
      applyBoundaryUpdatesToGPU(sd, hideUpdates, float2Half);

      // alpha=0 적용 + 원본 alpha snapshot.
      doorOrigAlphaSnapshotRef.current = [];
      if (sd.colorTexture) {
        const td = sd.colorTexture.lock();
        if (td) {
          const halfZero = float2Half(0);
          const snap: Array<{ idx: number; alpha: number }> = [];
          for (const i of decomp.doorOriginalIndices) {
            snap.push({ idx: i, alpha: td[i*4 + 3] });
            td[i*4 + 3] = halfZero;
          }
          doorOrigAlphaSnapshotRef.current = snap;
          sd.colorTexture.unlock();
        }
      }

      // 6. 도어 풀 씬 = doorOriginal (+ boundary split 활성 시 doorSubs) → 단일 추가 splat group (회전 단위)
      const { filterScene, concatScenes, serializePly } = await import('@/lib/ply');
      const keepDoor = new Uint8Array(scene.numSplats);
      for (const i of decomp.doorOriginalIndices) keepDoor[i] = 1;
      const doorOrigScene = filterScene(scene, keepDoor);
      const doorSubsScene = (boundarySplitEnabled && decomp.doorSubMetadata.length > 0)
        ? buildDoorSubScene(scene, decomp.doorSubMetadata)
        : null;
      const doorFullScene = doorSubsScene
        ? concatScenes(doorOrigScene, doorSubsScene)
        : doorOrigScene;

      if (doorFullScene.numSplats > 0) {
        const bytes = serializePly(doorFullScene);
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        doorSubBlobUrlRef.current = blobUrl;
        const id = additional.add(blobUrl);
        if (id) doorSubGsplatIdRef.current = id;
      }

      // 7. wall plane normal 조회
      const wallPlane = planes?.find(p => p.id === wallSurfaceId);
      if (!wallPlane) {
        console.warn(`[DoorRefine] wallPlane not found for surfaceId=${wallSurfaceId} — skipping mesh ops`);
      } else {
        // 8. 도어 mesh 베이크용 scene 은 doorFullScene 재사용
        const doorBakeScene = doorFullScene;

        // 도어 mesh 코너를 도어 가우시안의 평균 깊이로 shift — 벽 평면(sd=0) 에 두면 splats 와
        // 깊이 차이로 "들뜨는" 효과 발생. doorOriginal 평균 sd 만큼 안쪽으로 이동.
        let avgDoorSd = 0;
        if (decomp.doorOriginalIndices.length > 0) {
          const n = wallPlane.normal;
          let sum = 0;
          for (const i of decomp.doorOriginalIndices) {
            sum += sd.posX[i]*n[0] + sd.posY[i]*n[1] + sd.posZ[i]*n[2] - wallPlane.d;
          }
          avgDoorSd = sum / decomp.doorOriginalIndices.length;
        }
        const cornersForMesh: [Vec3, Vec3, Vec3, Vec3] = corners.map(c => [
          c[0] + avgDoorSd * wallPlane.normal[0],
          c[1] + avgDoorSd * wallPlane.normal[1],
          c[2] + avgDoorSd * wallPlane.normal[2],
        ] as Vec3) as [Vec3, Vec3, Vec3, Vec3];
        console.log(`[DoorRefine] door mesh shifted by ${(avgDoorSd*100).toFixed(2)}cm along wall normal (avg doorOrig depth)`);

        const { bakeTextureForPlane } = await import('@/lib/gs/textureBake');
        const bakeInput = { ...doorPlaneBakeInput(cornersForMesh, wallPlane.normal) };
        const doorBake = await bakeTextureForPlane(
          bakeInput,
          doorBakeScene,
          { depthGate: doorBakeGate },
        );

        // 9. 도어 mesh entity 생성
        const { createWallMeshEntity } = await import('@/lib/gs/wallMesh');
        doorMeshEntityRef.current = createWallMeshEntity(
          pc, app, sd.splatEntity, doorBake, `doorMesh_${wallSurfaceId}`,
        );

        // 10. wall mesh 텍스처에 도어 영역 alpha=0
        const wallEntName = `wallMesh_${wallSurfaceId}`;
        const wallEnt = findEntityByName(app.root, wallEntName);
        if (!wallEnt) {
          console.warn(`[DoorRefine] wall mesh entity ${wallEntName} not found — skip alpha hole`);
        } else {
          const meshInst = wallEnt.render?.meshInstances?.[0];
          const tex = meshInst?.material?.emissiveMap;
          const mesh = meshInst?.mesh;
          if (!tex || !mesh) {
            console.warn(`[DoorRefine] wall mesh tex/mesh missing — skip alpha hole`);
          } else {
            const positions: number[] = [];
            const uvs: number[] = [];
            mesh.getPositions(positions);
            mesh.getUvs(0, uvs);
            const wallCorners: [Vec3, Vec3, Vec3, Vec3] = [
              [positions[0], positions[1], positions[2]],
              [positions[3], positions[4], positions[5]],
              [positions[6], positions[7], positions[8]],
              [positions[9], positions[10], positions[11]],
            ];
            const wallUvs: [[number, number], [number, number], [number, number], [number, number]] = [
              [uvs[0], uvs[1]], [uvs[2], uvs[3]], [uvs[4], uvs[5]], [uvs[6], uvs[7]],
            ];
            const lvl = tex.lock();
            if (lvl) {
              const rgba = lvl as Uint8ClampedArray;
              // snapshot 보관 (revert 용)
              wallTexSnapshotRef.current = new Uint8ClampedArray(rgba);
              wallMeshNameRef.current = wallEntName;
              const touched = punchAlphaZeroInDoorRegion(rgba, tex.width, tex.height, wallCorners, wallUvs, corners);
              console.log(`[DoorRefine] wall mesh hole: ${touched} pixels`);
            }
            tex.unlock();
          }
        }
      }

      setDoorRefineActive(true);
      console.log('[DoorRefine] apply SUCCESS');
    } catch (e: any) {
      console.error('[DoorRefine] failed:', e);
      setDoorRefineError(`정제 실패: ${e?.message ?? e}`);
      // 실패 시 깨끗한 상태로 원복
      try { await revertDoorRefine(); } catch {}
    } finally {
      setDoorRefining(false);
    }
  }, [allPicked, picked, currentUrl, coreRef, additional, planes, doorBakeGate, doorSafetyMargin, doorThickness,
      doorRefineActive, boundarySplitEnabled, applyBoundaryUpdatesToGPU, findEntityByName, revertDoorRefine]);

  // 문 내부 가우시안 색칠 (정제 전/후 모두 사용 가능).
  // ON 시: 4 코너 + 두께 기준 doorOriginalIndices 를 lazy 계산 → 빨강 틴트.
  // OFF 시: origColorData 의 RGB 로 복원.
  // 두께/코너 변경 시 자동 재계산 (아래 useEffect 참조).
  const setDoorInternalShowAsync = useCallback(async (next: boolean) => {
    const core = coreRef.current;
    const sd = core?.getSplatData();
    if (!core || !sd?.colorTexture || !sd?.origColorData) return;
    const f2h = core.float2Half;

    // 1. 기존 tint 가 있다면 (토글 ON 상태였다면) 일단 RGB 복원
    const oldIndices = doorOriginalIndicesRef.current;
    if (oldIndices.length > 0 && doorInternalShow) {
      const td = sd.colorTexture.lock();
      if (td) {
        for (const i of oldIndices) {
          td[i * 4 + 0] = sd.origColorData[i * 4 + 0];
          td[i * 4 + 1] = sd.origColorData[i * 4 + 1];
          td[i * 4 + 2] = sd.origColorData[i * 4 + 2];
        }
        sd.colorTexture.unlock();
      }
    }

    // 1b. 추가 gsplat 색 복원
    if (doorInternalShow && doorGsplatOrigColorsRef.current && doorSubGsplatIdRef.current) {
      const doorEnt = additional.getEntity(doorSubGsplatIdRef.current);
      const doorInst = (doorEnt as any)?.gsplat?.instance;
      const doorColorTex = doorInst?.splatData?.colorTexture;
      if (doorColorTex) {
        const dt = doorColorTex.lock();
        if (dt) {
          dt.set(doorGsplatOrigColorsRef.current);
          doorColorTex.unlock();
        }
      }
      doorGsplatOrigColorsRef.current = null;
    }

    // 1c. 도어 mesh emissive 복원
    if (doorInternalShow && doorMeshOrigEmissiveRef.current && doorMeshEntityRef.current) {
      const meshMat = doorMeshEntityRef.current.render?.meshInstances?.[0]?.material;
      const pcLibR = core.getPC();
      if (meshMat && pcLibR) {
        const o = doorMeshOrigEmissiveRef.current;
        if (meshMat.emissive?.set) meshMat.emissive.set(o.r, o.g, o.b);
        else meshMat.emissive = new pcLibR.Color(o.r, o.g, o.b);
        meshMat.update?.();
      }
      doorMeshOrigEmissiveRef.current = null;
    }

    if (!next) { setDoorInternalShow(false); return; }
    if (!allPicked) { setDoorInternalShow(false); return; }

    // 2. 새 indices 계산 (scene 캐시 + decompose)
    // applyDoorRefine 와 동일하게 wall plane 으로 투영한 corners 사용 — 안 그러면 결과가 달라져
    // hide 와 tint 가 어긋남 (alpha=0 인 splats 와 yellow 칠하는 splats 가 다른 집합).
    try {
      if (!cachedSceneRef.current) {
        const { fetchAndParsePly } = await import('@/lib/ply');
        cachedSceneRef.current = await fetchAndParsePly(currentUrl);
      }
      const wallPlanePrev = planes?.find(p => p.id === picked[0]!.surfaceId);
      const projectPrev = (p: Vec3): Vec3 => {
        if (!wallPlanePrev) return p;
        const n = wallPlanePrev.normal;
        const sd0 = n[0]*p[0] + n[1]*p[1] + n[2]*p[2] - wallPlanePrev.d;
        return [p[0] - sd0*n[0], p[1] - sd0*n[1], p[2] - sd0*n[2]];
      };
      const corners: [Vec3, Vec3, Vec3, Vec3] = [
        projectPrev(picked[0]!.pos),
        projectPrev(picked[1]!.pos),
        projectPrev(picked[2]!.pos),
        projectPrev(picked[3]!.pos),
      ];
      const { decomposeBoundaryGaussians } = await import('@/lib/gs/doorTrim');
      const decomp = decomposeBoundaryGaussians(cachedSceneRef.current, { corners }, {
        safetyMargin: doorSafetyMargin,
        doorThickness,
      });
      doorOriginalIndicesRef.current = decomp.doorOriginalIndices.slice();
      console.log(`[DoorRefine] preview: door-inside=${decomp.doorOriginalIndices.length}, boundary=${decomp.boundaryIndices.length}, thickness=${(doorThickness*100).toFixed(1)}cm`);
    } catch (e: any) {
      console.error('[DoorRefine] preview compute failed:', e);
      setDoorInternalShow(false);
      return;
    }

    const indices = doorOriginalIndicesRef.current;
    if (indices.length === 0) { setDoorInternalShow(false); return; }

    // 3. 노랑 틴트 적용 (R,G high, B low — SH DC 공간)
    const td = sd.colorTexture.lock();
    if (!td) { setDoorInternalShow(false); return; }
    const r = f2h(2.0), g = f2h(2.0), b = f2h(-2.0);
    for (const i of indices) {
      td[i * 4 + 0] = r;
      td[i * 4 + 1] = g;
      td[i * 4 + 2] = b;
    }
    sd.colorTexture.unlock();

    // 3b. 추가 splat group (도어 entity) 의 colorTexture 전체 노랑 칠 (snapshot 으로 복원 가능).
    if (doorSubGsplatIdRef.current) {
      const doorEnt = additional.getEntity(doorSubGsplatIdRef.current);
      const doorInst = (doorEnt as any)?.gsplat?.instance;
      const doorColorTex = doorInst?.splatData?.colorTexture;
      if (doorColorTex) {
        const dt = doorColorTex.lock();
        if (dt) {
          if (!doorGsplatOrigColorsRef.current) {
            doorGsplatOrigColorsRef.current = new Uint16Array(dt);
          }
          for (let i = 0; i < dt.length; i += 4) {
            dt[i + 0] = r;
            dt[i + 1] = g;
            dt[i + 2] = b;
            // alpha 유지
          }
          doorColorTex.unlock();
        }
      }
    }

    // 3c. 도어 mesh material 노랑 emissive 칠 (snapshot 으로 복원 가능).
    if (doorMeshEntityRef.current) {
      const meshMat = doorMeshEntityRef.current.render?.meshInstances?.[0]?.material;
      const pcLib = core.getPC();
      if (meshMat && pcLib) {
        if (!doorMeshOrigEmissiveRef.current) {
          const e = meshMat.emissive;
          doorMeshOrigEmissiveRef.current = e ? { r: e.r, g: e.g, b: e.b } : { r: 0, g: 0, b: 0 };
        }
        if (meshMat.emissive?.set) meshMat.emissive.set(1, 1, 0);
        else meshMat.emissive = new pcLib.Color(1, 1, 0);
        meshMat.update?.();
      }
    }
    setDoorInternalShow(true);
  }, [coreRef, doorInternalShow, allPicked, picked, currentUrl, doorSafetyMargin, doorThickness, doorRefineActive, additional, planes]);

  const toggleDoorInternalShow = useCallback(() => {
    void setDoorInternalShowAsync(!doorInternalShow);
  }, [setDoorInternalShowAsync, doorInternalShow]);

  // 코너/두께 변경 시 ON 상태면 자동 refresh.
  const setDoorInternalShowAsyncRef = useRef(setDoorInternalShowAsync);
  useEffect(() => { setDoorInternalShowAsyncRef.current = setDoorInternalShowAsync; }, [setDoorInternalShowAsync]);
  useEffect(() => {
    if (!doorInternalShow) return;
    void setDoorInternalShowAsyncRef.current(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, doorThickness]);

  // 슬라이더 변경 시 자동 재적용 (활성일 때만, 600ms 디바운스).
  // applyDoorRefine 자체를 deps 에 넣으면 재생성 루프가 생기므로 ref 로 우회.
  const applyDoorRefineRef = useRef(applyDoorRefine);
  useEffect(() => { applyDoorRefineRef.current = applyDoorRefine; }, [applyDoorRefine]);
  useEffect(() => {
    if (!doorRefineActive) return;
    const t = setTimeout(() => {
      applyDoorRefineRef.current().catch(e => console.error('[DoorRefine] auto re-apply failed:', e));
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doorBakeGate, doorSafetyMargin, doorThickness]);

  // 모달 언마운트 시 정리
  useEffect(() => {
    return () => {
      if (doorSubBlobUrlRef.current) {
        try { URL.revokeObjectURL(doorSubBlobUrlRef.current); } catch {}
      }
    };
  }, []);

  // ── 힌지 축 기준 문 회전 (애니메이션) ──
  // 각 프레임에서 angle 만 보간하고 transform 은 그 angle 로 다시 계산 → 힌지 축의 점은 항상 고정.
  // localRot = Z180 ∘ R(angle), localPos = Z180 * (cA − R(angle)·cA)
  const doorAnimRef = useRef<{
    start: number;
    duration: number;
    fromAngleRad: number;
    toAngleRad: number;
    axis: [number, number, number]; // 힌지 단위 벡터 (raw frame)
    cA: [number, number, number];   // 힌지 시작점 (raw frame, 고정점)
  } | null>(null);
  // 현재 누적 회전각 (rad). 다음 회전의 시작각.
  const doorCurrentAngleRef = useRef<number>(0);
  // 마지막에 사용한 힌지 (resetDoorRotation 이 hingeIndices 변경 후에도 같은 축으로 닫기 위해).
  const lastDoorHingeRef = useRef<{ axis: [number, number, number]; cA: [number, number, number] } | null>(null);

  // 매 프레임 angle(t) → transform 적용. 힌지(cA, axis)는 보간에 영향 안 줌 → 회전축 절대 안 움직임.
  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    return core.onUpdate(() => {
      const a = doorAnimRef.current;
      if (!a) return;
      const pc = core.getPC();
      if (!pc) return;
      const tNorm = Math.min(1, (performance.now() - a.start) / a.duration);
      const u = easeInOutCubic(tNorm);
      const angle = a.fromAngleRad + (a.toAngleRad - a.fromAngleRad) * u;
      const half = angle / 2;
      const sH = Math.sin(half), cH = Math.cos(half);
      const qR = new pc.Quat(a.axis[0]*sH, a.axis[1]*sH, a.axis[2]*sH, cH);
      const z180 = new pc.Quat();
      z180.setFromEulerAngles(0, 0, 180);
      const localRot = new pc.Quat();
      localRot.copy(z180).mul(qR);
      const cAvec = new pc.Vec3(a.cA[0], a.cA[1], a.cA[2]);
      const rotatedCA = new pc.Vec3();
      qR.transformVector(cAvec, rotatedCA);
      const offsetRaw = new pc.Vec3(a.cA[0] - rotatedCA.x, a.cA[1] - rotatedCA.y, a.cA[2] - rotatedCA.z);
      const offsetWorld = new pc.Vec3();
      z180.transformVector(offsetRaw, offsetWorld);

      const doorEnt = doorSubGsplatIdRef.current ? additional.getEntity(doorSubGsplatIdRef.current) : null;
      if (doorEnt) {
        doorEnt.setLocalRotation(localRot.x, localRot.y, localRot.z, localRot.w);
        doorEnt.setLocalPosition(offsetWorld.x, offsetWorld.y, offsetWorld.z);
      }
      if (doorMeshEntityRef.current) {
        doorMeshEntityRef.current.setLocalRotation(localRot.x, localRot.y, localRot.z, localRot.w);
        doorMeshEntityRef.current.setLocalPosition(offsetWorld.x, offsetWorld.y, offsetWorld.z);
      }
      if (tNorm >= 1) {
        doorCurrentAngleRef.current = a.toAngleRad;
        doorAnimRef.current = null;
      }
    });
  }, [coreRef, additional]);

  const applyDoorRotation = useCallback(() => {
    if (hingeIndices.length !== 2) {
      setDoorRefineError('힌지로 사용할 두 코너를 선택하세요');
      return;
    }
    if (!allPicked || !planes) return;

    const cA = picked[hingeIndices[0]]!.pos;
    const cB = picked[hingeIndices[1]]!.pos;
    const hxv = cB[0] - cA[0], hyv = cB[1] - cA[1], hzv = cB[2] - cA[2];
    const hLen = Math.hypot(hxv, hyv, hzv) || 1;
    const ax = hxv/hLen, ay = hyv/hLen, az = hzv/hLen;

    // swing 방향 부호 — 힌지 아닌 코너의 cross(axis, d) 가 wall normal 과 동방향이면 +angle = 안쪽.
    const otherIdx = [0,1,2,3].find(i => !hingeIndices.includes(i));
    if (otherIdx === undefined) return;
    const P = picked[otherIdx]!.pos;
    const dxv = P[0] - cA[0], dyv = P[1] - cA[1], dzv = P[2] - cA[2];
    const crossX = ay*dzv - az*dyv;
    const crossY = az*dxv - ax*dzv;
    const crossZ = ax*dyv - ay*dxv;
    const wallSurfaceId = picked[0]!.surfaceId;
    const wallPlane = planes.find(p => p.id === wallSurfaceId);
    if (!wallPlane) return;
    const wn = wallPlane.normal;
    const dotCN = crossX*wn[0] + crossY*wn[1] + crossZ*wn[2];
    // planes.ts 의 normal 은 방 바깥 방향. 따라서 +angle 이 +wn 방향으로 P 를 보낸다 = 바깥쪽.
    // doorSwing=1 (안쪽) → -wn 방향 → -insideSign 적용.
    const insideSign = dotCN > 0 ? -1 : 1;
    const angleSign = doorSwing * insideSign;
    const angleRad = angleSign * doorAngleDeg * Math.PI / 180;

    const axis: [number, number, number] = [ax, ay, az];
    const cAvec3: [number, number, number] = [cA[0], cA[1], cA[2]];
    lastDoorHingeRef.current = { axis, cA: cAvec3 };

    doorAnimRef.current = {
      start: performance.now(),
      duration: 800,
      fromAngleRad: doorCurrentAngleRef.current,
      toAngleRad: angleRad,
      axis,
      cA: cAvec3,
    };
    setDoorRotated(true);
    setDoorRefineError(null);
    console.log(`[DoorRotate] hinge ${hingeIndices[0]}→${hingeIndices[1]}, ${doorAngleDeg}° ${doorSwing === 1 ? '안쪽' : '바깥쪽'} (insideSign=${insideSign}, from=${(doorCurrentAngleRef.current * 180 / Math.PI).toFixed(1)}° → ${(angleRad * 180 / Math.PI).toFixed(1)}°)`);
  }, [hingeIndices, doorAngleDeg, doorSwing, picked, planes, allPicked]);

  const resetDoorRotation = useCallback(() => {
    // 마지막 사용한 힌지로 angle=0 까지 보간. 없으면 직접 identity 적용.
    const last = lastDoorHingeRef.current;
    if (last) {
      doorAnimRef.current = {
        start: performance.now(),
        duration: 800,
        fromAngleRad: doorCurrentAngleRef.current,
        toAngleRad: 0,
        axis: last.axis,
        cA: last.cA,
      };
    } else {
      const core = coreRef.current;
      const pc = core?.getPC();
      if (pc) {
        const z180 = new pc.Quat();
        z180.setFromEulerAngles(0, 0, 180);
        const doorEnt = doorSubGsplatIdRef.current ? additional.getEntity(doorSubGsplatIdRef.current) : null;
        if (doorEnt) {
          doorEnt.setLocalRotation(z180.x, z180.y, z180.z, z180.w);
          doorEnt.setLocalPosition(0, 0, 0);
        }
        if (doorMeshEntityRef.current) {
          doorMeshEntityRef.current.setLocalRotation(z180.x, z180.y, z180.z, z180.w);
          doorMeshEntityRef.current.setLocalPosition(0, 0, 0);
        }
      }
      doorCurrentAngleRef.current = 0;
    }
    setDoorRotated(false);
  }, [coreRef, additional]);

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

      // SPEC: 변환행렬 + basemap/door 매칭을 upload-scoped 로 저장.
      // fit.R 은 row-major 3x3, fit.t 는 [x,y,z]. 엔드포인트는 position/rotation(quat)/scale 형태.
      try {
        const [qw, qx, qy, qz] = rotationMatrixToQuat(fit.R);
        await api.post(`/uploads/${uploadId}/alignment`, {
          transform: {
            position: [fit.t[0], fit.t[1], fit.t[2]],
            rotation: [qx, qy, qz, qw],
            scale: [1, 1, 1],
          },
          rmsd: fit.rmsd,
          matches: [{ module_door_id: PRIMARY_DOOR_ID, basemap_id: 'manual' }],
        });
      } catch (e: any) {
        console.warn('[DoorAlign] alignment 저장 실패 (PLY 는 이미 업로드됨)', e);
      }

      // 모듈 코너는 이제 basemap 좌표계로 옮겨졌으니 다음 작업에서 다시 추출
      const empty: Array<PickedCorner | null> = [null, null, null, null];
      setPicked(empty);
      void clearDoorsOnServer(uploadId);

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

        {/* 텍스처맵 저장 (디버그) — 추출 완료 후 표시 */}
        {outlineActive && (
          <button
            onClick={saveAllTextureMaps}
            disabled={!allPicked}
            className="w-full px-3 py-1.5 bg-purple-700 hover:bg-purple-600 disabled:bg-gray-700 disabled:text-gray-500 rounded cursor-pointer text-xs font-bold text-white"
            title="6개 wall mesh + 1개 도어 영역 = 총 7개 PNG 다운로드. 도어가 있는 wall mesh 의 도어 영역이 alpha=0 인지 확인용."
          >
            텍스처맵 저장 (7개 PNG)
          </button>
        )}

        {/* ── 도어 추출 (메인 PLY 에서 도어 영역 분리 → mesh + 추가 splat group) ── */}
        <div className="border-t border-gray-700 pt-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-bold text-gray-200">도어 추출</div>
            <span className="text-[10px]">
              {doorRefineActive
                ? <span className="text-green-400">추출됨</span>
                : <span className="text-gray-600">미추출</span>}
            </span>
          </div>
          <div className="text-[10px] text-gray-500 leading-tight">
            메인 PLY 의 도어 가우시안 → 별도 entity. 추가로 boundary 정제 옵션 선택 가능.
          </div>

          {/* 베이크 시작 (depthGate) */}
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-gray-400 w-16" title="도어 mesh 베이크 시 평면 안쪽 가우시안 채택 한계">베이크 시작</span>
            <input type="range" min={0.005} max={0.5} step={0.005}
              value={doorBakeGate}
              onChange={e => setDoorBakeGate(parseFloat(e.target.value))}
              className="flex-1 accent-cyan-500 cursor-pointer" />
            <span className="text-white font-mono w-12 text-right">
              {(doorBakeGate * 100).toFixed(1)}cm
            </span>
          </div>

          {/* 분할 안전 margin */}
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-gray-400 w-16" title="분할 후 sub scale 에 추가 (1-margin) 곱. boundary 에서 더 들여 자르기">안전 margin</span>
            <input type="range" min={0} max={0.3} step={0.01}
              value={doorSafetyMargin}
              onChange={e => setDoorSafetyMargin(parseFloat(e.target.value))}
              className="flex-1 accent-orange-500 cursor-pointer" />
            <span className="text-white font-mono w-12 text-right">
              {(doorSafetyMargin * 100).toFixed(0)}%
            </span>
          </div>

          {/* 문 두께 (벽 평면 ± thickness/2 깊이 필터) */}
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-gray-400 w-16" title="문 내부 가우시안 분류 시 벽 평면에서 ± 두께/2 이내만 채택. 문 뒤 가구 등 깊이 필터.">문 두께</span>
            <input type="range" min={0.02} max={0.5} step={0.005}
              value={doorThickness}
              onChange={e => setDoorThickness(parseFloat(e.target.value))}
              className="flex-1 accent-purple-500 cursor-pointer" />
            <span className="text-white font-mono w-12 text-right">
              {(doorThickness * 100).toFixed(1)}cm
            </span>
            <button
              onClick={toggleDoorInternalShow}
              disabled={!allPicked}
              title="현재 문 두께 설정으로 도어에 포함되는 가우시안을 노랑으로 표시 (다시 누르면 OFF)"
              className={`w-7 h-6 rounded text-[10px] font-bold cursor-pointer disabled:bg-gray-700 disabled:text-gray-500 ${
                doorInternalShow
                  ? 'bg-yellow-500 hover:bg-yellow-400 text-black'
                  : 'bg-gray-600 hover:bg-gray-500 text-gray-200'
              }`}
            >👁</button>
          </div>

          {doorRefineStats && (
            <div className="text-[10px] text-gray-500 font-mono">
              N={doorRefineStats.N.toLocaleString()} ·
              boundary={doorRefineStats.nBoundary.toLocaleString()} ·
              door-inside={doorRefineStats.nDoorOrig.toLocaleString()}
            </div>
          )}

          {doorRefineError && (
            <div className="text-red-400 text-[11px]">{doorRefineError}</div>
          )}

          <div className="flex gap-1.5">
            <button
              onClick={applyDoorRefine}
              disabled={!allPicked || doorRefining || doorRefineActive}
              className={`flex-1 px-3 py-1.5 rounded cursor-pointer text-xs font-bold disabled:bg-gray-700 disabled:text-gray-500 ${
                doorRefineActive
                  ? 'bg-green-700 text-white'
                  : 'bg-blue-600 hover:bg-blue-500 text-white'
              }`}
            >
              {doorRefining ? '처리 중...' :
               doorRefineActive ? '추출 ON ✓' : '추출 ON'}
            </button>
            <button
              onClick={revertDoorRefine}
              disabled={!doorRefineActive || doorRefining}
              className="flex-1 px-3 py-1.5 rounded cursor-pointer text-xs font-bold disabled:bg-gray-700 disabled:text-gray-500 bg-amber-600 hover:bg-amber-500 text-white"
            >
              추출 OFF
            </button>
          </div>

          {/* boundary 분할 토글 (가장자리 가우시안 split, SAGS-style) */}
          <label className="flex items-center gap-1.5 text-[10px] cursor-pointer text-gray-300">
            <input
              type="checkbox"
              checked={boundarySplitEnabled}
              onChange={e => setBoundarySplitEnabled(e.target.checked)}
              className="cursor-pointer accent-cyan-500"
            />
            <span>boundary 가우시안 분할 (가장자리 정제)</span>
          </label>

          {/* 문 표시 토글 — main PLY + 추가 gsplat + 도어 mesh emissive 모두 노랑. 정제 전/후 모두 사용 가능. */}
          <button
            onClick={toggleDoorInternalShow}
            disabled={!allPicked}
            className={`w-full px-3 py-1 rounded cursor-pointer text-[10px] font-bold disabled:bg-gray-700 disabled:text-gray-500 ${
              doorInternalShow
                ? 'bg-yellow-500 hover:bg-yellow-400 text-black'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
            }`}
            title="4 코너 + 문 두께 기준 도어 영역을 노랑으로 임시 표시 (가우시안 + 텍스처 메쉬). 정제 전후 모두 사용 가능."
          >
            {doorInternalShow ? '문 표시 OFF' : '문 표시'}
          </button>
        </div>

        {/* ── 문 회전 (힌지 + 각도 + 방향) ── */}
        <div className="border-t border-gray-700 pt-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-bold text-gray-200">문 회전</div>
            <span className="text-[10px]">
              {doorRotated
                ? <span className="text-green-400">회전됨</span>
                : <span className="text-gray-600">정지</span>}
            </span>
          </div>
          <div className="text-[10px] text-gray-500 leading-tight">
            힌지로 쓸 두 코너를 선택 → 그 축 기준 회전. 도어 splat + 도어 mesh 동시 회전.
          </div>

          {/* 힌지 코너 선택 (2x2 그리드) */}
          <div className="grid grid-cols-2 gap-1">
            {CORNERS.map((c, i) => {
              const sel = hingeIndices.includes(i);
              return (
                <button key={c.id}
                  onClick={() => toggleHinge(i)}
                  disabled={!allPicked}
                  className="px-2 py-1 rounded text-[10px] font-bold border-2 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  style={{
                    background: sel ? c.hex : '#374151',
                    color: sel ? '#000' : '#d1d5db',
                    borderColor: sel ? '#fff' : 'transparent',
                  }}
                >{c.label}</button>
              );
            })}
          </div>

          {/* 회전각 슬라이더 */}
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-gray-400 w-16">회전각</span>
            <input type="range" min={0} max={120} step={1}
              value={doorAngleDeg}
              onChange={e => setDoorAngleDeg(parseFloat(e.target.value))}
              className="flex-1 accent-cyan-500 cursor-pointer" />
            <span className="text-white font-mono w-12 text-right">{doorAngleDeg}°</span>
          </div>

          {/* 방향 토글 */}
          <div className="flex gap-1.5">
            <button
              onClick={() => setDoorSwing(1)}
              className={`flex-1 px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${doorSwing === 1 ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
            >방 안쪽</button>
            <button
              onClick={() => setDoorSwing(-1)}
              className={`flex-1 px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${doorSwing === -1 ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
            >방 바깥쪽</button>
          </div>

          <div className="flex gap-1.5">
            <button
              onClick={resetDoorRotation}
              disabled={!doorRotated}
              className="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 rounded cursor-pointer text-xs font-bold"
            >문 닫기</button>
            <button
              onClick={applyDoorRotation}
              disabled={hingeIndices.length !== 2 || !doorRefineActive}
              className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 rounded cursor-pointer text-xs font-bold"
              title={!doorRefineActive ? '먼저 추출 ON 을 누르세요' : ''}
            >문 열기</button>
          </div>
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
