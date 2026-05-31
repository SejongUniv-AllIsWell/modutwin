'use client';

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { FloorDetailManifest, FloorDetailModuleEntry } from '@/types';
import SplatViewerCore, { type SplatViewerCoreRef } from '@/components/viewer/SplatViewerCore';
import { useAdditionalGsplats } from '@/components/viewer/tools/useAdditionalGsplats';
import { useRefinedMeshLoader } from '@/components/viewer/tools/useRefinedMeshLoader';
import { useToast } from '@/components/ui/Toast';
import RoomWheelPicker, { roomNumberLabel } from '@/components/ui/RoomWheelPicker';
import type { FloorplanResult } from '@/lib/gs/floorplan';
import { createDoorInteraction, type DoorInteractionController, type DoorHandle } from '@/lib/gs/doorInteraction';

const Minimap = lazy(() => import('@/components/viewer/tools/Minimap'));
const CeilingCutPanel = lazy(() => import('@/components/viewer/tools/CeilingCutPanel'));

// 미니맵 이미지 베이크는 천장에서 고정 11cm 컷으로 항상 층 전체를 굽는다.
// (라이브 3D 천장 컷 슬라이더와 분리 — 슬라이더는 화면상 3D 씬 컷만 조절.)
const MINIMAP_CEILING_CUT_M = 0.11;

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type Scale3 = [number, number, number];
type BasemapDoorListResponse = {
  doors: Array<{ id?: string; unitName?: string | null }>;
};
type RoomModuleGroup = {
  name: string;
  modules: FloorDetailModuleEntry[];
  fromBasemap: boolean;
};
type ModuleOverlayRecord = {
  group: any | null;
  splatLayerIds: string[];
  meshEntities: any[];
  cancelled: boolean;
};
type CeilingCutAlphaRecord = {
  texture: any;
  entries: Array<[number, number]>;
};
type CeilingCutState = {
  alphaRecords: CeilingCutAlphaRecord[];
  meshRecords: Array<{ ent: any; enabled: boolean }>;
};

const moduleNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const moduleTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'short',
  timeStyle: 'short',
});
const DEFAULT_DOOR_FRAME_COLOR: [number, number, number] = [0.72, 0.65, 0.53];

function moduleVersionTime(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function hasModuleResult(module: FloorDetailModuleEntry): boolean {
  return Boolean(module.url || module.version);
}

function compareModuleVersionAsc(a: FloorDetailModuleEntry, b: FloorDetailModuleEntry): number {
  const at = moduleVersionTime(a.version);
  const bt = moduleVersionTime(b.version);
  if (at !== bt) {
    if (!Number.isFinite(at)) return 1;
    if (!Number.isFinite(bt)) return -1;
    return at - bt;
  }
  const au = a.uploader_name?.trim() || a.user_id;
  const bu = b.uploader_name?.trim() || b.user_id;
  return moduleNameCollator.compare(au, bu);
}

function formatModuleVersion(value: string | null): string {
  const time = moduleVersionTime(value);
  if (!Number.isFinite(time)) return '';
  return moduleTimeFormatter.format(new Date(time));
}

function moduleUploaderLabel(module: FloorDetailModuleEntry): string {
  return module.uploader_name?.trim() || module.user_id.slice(0, 8);
}

function roomSuffixFromLabel(floorNumber: number, roomName: string): number | null {
  const normalized = roomName.trim().replace(/호$/, '');
  const prefix = String(floorNumber);
  if (!normalized.startsWith(prefix)) return null;
  const suffix = Number(normalized.slice(prefix.length));
  if (!Number.isInteger(suffix) || suffix < 1 || suffix > 99) return null;
  return suffix;
}

function readVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (value.some((n) => typeof n !== 'number' || Number.isNaN(n))) return null;
  return [value[0], value[1], value[2]];
}

function readQuat(value: unknown): Quat | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (value.some((n) => typeof n !== 'number' || Number.isNaN(n))) return null;
  return [value[0], value[1], value[2], value[3]];
}

function readScale3(value: unknown): Scale3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (value.some((n) => typeof n !== 'number' || Number.isNaN(n))) return null;
  return [value[0], value[1], value[2]];
}

function parseAlignmentTransform(raw: Record<string, unknown> | null): { position: Vec3; rotation: Quat; scale: Scale3 } | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = (raw.transform && typeof raw.transform === 'object'
    ? raw.transform
    : raw) as Record<string, unknown>;
  const position = readVec3(root.position) ?? [0, 0, 0];
  const rotation = readQuat(root.rotation) ?? [0, 0, 0, 1];
  const scale = readScale3(root.scale) ?? [1, 1, 1];
  return { position, rotation, scale };
}

function loadHtmlImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function averageImageColor(image: HTMLImageElement): [number, number, number] | null {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) return null;
  const width = Math.max(1, Math.min(64, sourceWidth));
  const height = Math.max(1, Math.min(64, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(image, 0, 0, width, height);
    data = ctx.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  }
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 0) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  return n > 0 ? [r / (255 * n), g / (255 * n), b / (255 * n)] : null;
}

function createColoredMeshEntity(
  pc: any,
  app: any,
  name: string,
  positions: number[],
  indices: number[],
  color: [number, number, number] = DEFAULT_DOOR_FRAME_COLOR,
): any {
  const mesh = new pc.Mesh(app.graphicsDevice);
  mesh.setPositions(positions);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);

  const mat = new pc.StandardMaterial();
  mat.emissive = new pc.Color(color[0], color[1], color[2]);
  mat.useLighting = false;
  mat.cull = pc.CULLFACE_NONE;
  mat.update();

  const ent = new pc.Entity(name);
  ent.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)] });
  app.root.addChild(ent);
  return ent;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function traverseEntities(root: any, visit: (ent: any) => void) {
  if (!root) return;
  visit(root);
  for (const child of root.children ?? []) traverseEntities(child, visit);
}

function visualCeilingMeshEntities(app: any): any[] {
  const results: any[] = [];
  traverseEntities(app?.root, (ent) => {
    const name = String(ent?.name ?? '');
    if (!name.startsWith('wallMesh_')) return;
    // Z-180 뷰어 컨벤션상 저장 surfaceId "floor" 가 화면상 천장이다.
    // basemap: wallMesh_floor, module: wallMesh_module_<id>_floor.
    if (name === 'wallMesh_floor' || name.endsWith('_floor')) results.push(ent);
  });
  return results;
}

function collectGsplatRuntimes(app: any): Array<{
  ent: any;
  gsplatData: any;
  colorTexture: any;
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  numSplats: number;
}> {
  const results: Array<{
    ent: any;
    gsplatData: any;
    colorTexture: any;
    posX: Float32Array;
    posY: Float32Array;
    posZ: Float32Array;
    numSplats: number;
  }> = [];
  traverseEntities(app?.root, (ent) => {
    if (!ent?.enabled || !ent.gsplat) return;
    const comp = ent.gsplat;
    const resource = comp.asset?.resource ?? comp.instance?.resource ?? comp.instance?.splatData;
    const gsplatData = resource?.gsplatData ?? resource;
    const colorTexture = resource?.streams?.textures?.get?.('splatColor')
      ?? comp.material?.colorMap
      ?? comp.instance?.material?.colorMap;
    const posX = gsplatData?.getProp?.('x') as Float32Array | undefined;
    const posY = gsplatData?.getProp?.('y') as Float32Array | undefined;
    const posZ = gsplatData?.getProp?.('z') as Float32Array | undefined;
    const numSplats = Number(gsplatData?.numSplats ?? posX?.length ?? 0);
    if (!colorTexture || !posX || !posY || !posZ || !numSplats) return;
    results.push({ ent, gsplatData, colorTexture, posX, posY, posZ, numSplats });
  });
  return results;
}

// 씬 전체(basemap primary + 모듈 오버레이) 가우시안의 world bbox.
// 평면도 프레임을 모든 방에 맞춰 잡아 모듈이 잘리지 않도록 한다.
function sceneWorldBounds(app: any): { mnX: number; mxX: number; mnY: number; mxY: number; mnZ: number; mxZ: number } | null {
  const runtimes = collectGsplatRuntimes(app);
  if (runtimes.length === 0) return null;
  let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (const rt of runtimes) {
    const m = rt.ent.getWorldTransform().data;
    for (let i = 0; i < rt.numSplats; i++) {
      const [wx, wy, wz] = worldPositionFromLocal(m, rt.posX[i], rt.posY[i], rt.posZ[i]);
      if (wx < mnX) mnX = wx; if (wx > mxX) mxX = wx;
      if (wy < mnY) mnY = wy; if (wy > mxY) mxY = wy;
      if (wz < mnZ) mnZ = wz; if (wz > mxZ) mxZ = wz;
    }
  }
  if (!Number.isFinite(mnX)) return null;
  return { mnX, mxX, mnY, mxY, mnZ, mxZ };
}

function worldPositionFromLocal(m: Float32Array | number[], x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// 천장 컷: 화면상 천장에서 cutoffMeters 이내 가우시안 alpha=0 + 천장 메시 숨김. 렌더 전용으로
// 저장 PLY/mesh 는 안 건드리고, restoreCeilingCutForPaper 가 GPU alpha/메시 가시성을 되돌린다.
function applyCeilingCutForPaper(app: any, core: SplatViewerCoreRef, cutoffMeters: number): CeilingCutState | null {
  const runtimes = collectGsplatRuntimes(app);
  if (runtimes.length === 0) return null;
  // Z-180 컨벤션: 화면상 천장(머리 위) = World +Y 최댓값.
  let ceilingY = -Infinity;
  for (const rt of runtimes) {
    const m = rt.ent.getWorldTransform().data;
    for (let i = 0; i < rt.numSplats; i++) {
      const [, wy] = worldPositionFromLocal(m, rt.posX[i], rt.posY[i], rt.posZ[i]);
      if (wy > ceilingY) ceilingY = wy;
    }
  }
  if (!Number.isFinite(ceilingY)) return null;
  // 천장에서 cutoffMeters 만큼 아래 평면. 이 위(천장 슬랩)를 가린다.
  const cutoffY = ceilingY - cutoffMeters;
  const zeroHalf = core.float2Half(0);
  const alphaRecords: CeilingCutAlphaRecord[] = [];
  for (const rt of runtimes) {
    const tex = rt.colorTexture;
    const data = tex.lock?.() as Uint16Array | null;
    if (!data) continue;
    const m = rt.ent.getWorldTransform().data;
    const entries: Array<[number, number]> = [];
    for (let i = 0; i < rt.numSplats; i++) {
      const [, wy] = worldPositionFromLocal(m, rt.posX[i], rt.posY[i], rt.posZ[i]);
      if (wy < cutoffY) continue;
      const ai = i * 4 + 3;
      const prev = data[ai];
      if (prev === zeroHalf) continue;
      entries.push([ai, prev]);
      data[ai] = zeroHalf;
    }
    tex.unlock?.();
    if (entries.length > 0) alphaRecords.push({ texture: tex, entries });
  }

  const meshRecords = visualCeilingMeshEntities(app).map((ent) => {
    const enabled = ent.enabled;
    ent.enabled = false;
    return { ent, enabled };
  });
  return { alphaRecords, meshRecords };
}

function restoreCeilingCutForPaper(state: CeilingCutState | null) {
  if (!state) return;
  for (const record of state.alphaRecords) {
    try {
      const data = record.texture.lock?.() as Uint16Array | null;
      if (!data) continue;
      for (const [idx, value] of record.entries) data[idx] = value;
      record.texture.unlock?.();
    } catch {
      try { record.texture.unlock?.(); } catch {}
    }
  }
  for (const { ent, enabled } of state.meshRecords) {
    try { ent.enabled = enabled; } catch {}
  }
}

function FloorCompositeViewer({
  primaryUrl,
  basemapSourceUploadId,
  moduleOverlays,
}: {
  primaryUrl: string;
  basemapSourceUploadId: string | null;
  moduleOverlays: FloorDetailModuleEntry[];
}) {
  const coreRef = useRef<SplatViewerCoreRef>(null);
  const additional = useAdditionalGsplats(coreRef);
  const { add, getEntity, remove } = additional;
  const overlayRecordsRef = useRef<Map<string, ModuleOverlayRecord>>(new Map());
  const doorInteractionRef = useRef<DoorInteractionController | null>(null);
  // 컨트롤러 생성 (splatReady) 보다 도어 로드가 먼저 끝날 수 있어 등록을 큐잉했다가 생성 시 drain.
  const pendingDoorsRef = useRef<DoorHandle[]>([]);
  const registerDoor = useCallback((handle: DoorHandle) => {
    const ctl = doorInteractionRef.current;
    if (ctl) ctl.add(handle);
    else pendingDoorsRef.current.push(handle);
  }, []);
  const unregisterDoorByWrapper = useCallback((wrapper: any) => {
    const ctl = doorInteractionRef.current;
    if (ctl) { try { ctl.removeByWrapper(wrapper); } catch {} }
    pendingDoorsRef.current = pendingDoorsRef.current.filter(h => h.wrapper !== wrapper);
  }, []);
  const ceilingCutStateRef = useRef<CeilingCutState | null>(null);
  const floorplanBakeSeqRef = useRef(0);
  const [splatReady, setSplatReady] = useState(false);
  const [paperCeilingCut, setPaperCeilingCut] = useState(false);
  const [floorplan, setFloorplan] = useState<FloorplanResult | null>(null);
  const [floorplanCutoff, setFloorplanCutoff] = useState(0.11);

  // 베이스맵의 wall mesh + 텍스처(천장/바닥/벽) + 도어 splat 까지 같이 로드.
  // 4번째 인자 (additional) 가 있어야 도어 splat 도 씬에 add 됨.
  // 층 overview 는 보기 전용이므로 CPU ImageData 복사 없이 로드해 대형 텍스처 메모리 사용을 줄인다.
  useRefinedMeshLoader(coreRef, basemapSourceUploadId ?? undefined, !!basemapSourceUploadId, additional, null, false, undefined, registerDoor, unregisterDoorByWrapper);

  const restorePaperCut = useCallback(() => {
    restoreCeilingCutForPaper(ceilingCutStateRef.current);
    ceilingCutStateRef.current = null;
  }, []);

  const applyPaperCut = useCallback(() => {
    const core = coreRef.current;
    const app = core?.getApp();
    if (!core || !app) return;
    restorePaperCut();
    ceilingCutStateRef.current = applyCeilingCutForPaper(app, core, floorplanCutoff);
  }, [floorplanCutoff, restorePaperCut]);

  useEffect(() => {
    if (paperCeilingCut) applyPaperCut();
    else restorePaperCut();
    return () => restorePaperCut();
  }, [paperCeilingCut, applyPaperCut, restorePaperCut]);

  const bakePaperFloorplan = useCallback(async () => {
    const seq = ++floorplanBakeSeqRef.current;
    const core = coreRef.current;
    const app = core?.getApp();
    const pc = core?.getPC();
    const sd = core?.getSplatData();
    if (!core || !app || !pc || !sd) return;

    const ceilingMeshes = visualCeilingMeshEntities(app);
    const prevEnabled = ceilingMeshes.map((ent) => ent.enabled);
    for (const ent of ceilingMeshes) ent.enabled = false;
    try {
      const { bakeFloorplan } = await import('@/lib/gs/floorplan');
      // 씬 전체(basemap + 모듈) 범위로 프레임을 잡아 모듈이 잘리지 않도록 한다.
      const bounds = sceneWorldBounds(app) ?? undefined;
      const fp = await bakeFloorplan(
        pc,
        app,
        {
          posX: sd.posX,
          posY: sd.posY,
          posZ: sd.posZ,
          numSplats: sd.numSplats,
          origColorData: sd.origColorData ?? null,
          splatEntity: sd.splatEntity,
        },
        core.half2Float,
        {
          cutoffOffsetMeters: MINIMAP_CEILING_CUT_M,
          paddingMeters: 0.5,
          pixelsPerMeter: 60,
          bounds,
        },
      );
      if (seq === floorplanBakeSeqRef.current && fp) setFloorplan(fp);
    } finally {
      for (let i = 0; i < ceilingMeshes.length; i++) ceilingMeshes[i].enabled = prevEnabled[i];
      if (paperCeilingCut) applyPaperCut();
    }
  }, [applyPaperCut, paperCeilingCut]);

  useEffect(() => {
    setSplatReady(false);
    setFloorplan(null);
    restorePaperCut();
    setPaperCeilingCut(false);
  }, [primaryUrl, restorePaperCut]);

  useEffect(() => {
    if (!splatReady) return;
    const t = setTimeout(() => {
      if (paperCeilingCut) applyPaperCut();
      void bakePaperFloorplan();
    }, 1600);
    return () => clearTimeout(t);
  }, [splatReady, applyPaperCut, bakePaperFloorplan, moduleOverlays.length, paperCeilingCut]);

  // 문 상호작용 컨트롤러 — splat 준비 후 1회 생성. 모듈 도어 로드 시 add() 로 등록.
  useEffect(() => {
    if (!splatReady) return;
    const core = coreRef.current;
    const pc = core?.getPC();
    const app = core?.getApp();
    const canvas = core?.getCanvas();
    if (!pc || !app || !canvas) return;
    const controller = createDoorInteraction({
      pc, app, canvas,
      getCamera: () => coreRef.current?.getCamera() ?? null,
      onUpdate: (cb) => core!.onUpdate(cb),
    });
    doorInteractionRef.current = controller;
    // 컨트롤러 생성 전 큐잉된 도어 등록 drain.
    if (pendingDoorsRef.current.length) {
      for (const h of pendingDoorsRef.current) controller.add(h);
      pendingDoorsRef.current = [];
    }
    return () => {
      controller.dispose();
      doorInteractionRef.current = null;
    };
  }, [splatReady]);

  useEffect(() => {
    const cleanupRecord = (record: ModuleOverlayRecord) => {
      record.cancelled = true;
      for (const layerId of record.splatLayerIds) {
        try { remove(layerId); } catch {}
      }
      record.splatLayerIds = [];
      for (const ent of record.meshEntities) {
        try { unregisterDoorByWrapper(ent); } catch {}
        try { ent.destroy(); } catch {}
      }
      record.meshEntities = [];
      if (record.group) {
        try { record.group.destroy(); } catch {}
      }
      record.group = null;
    };

    const applyGroupTransform = (group: any, t: { position: Vec3; rotation: Quat; scale: Scale3 }) => {
      group.setLocalPosition(t.position[0], t.position[1], t.position[2]);
      group.setLocalRotation(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
      group.setLocalScale(t.scale[0], t.scale[1], t.scale[2]);
    };

    const resetPlyLocalFrame = (ent: any) => {
      ent.setLocalPosition(0, 0, 0);
      ent.setLocalEulerAngles(0, 0, 180);
      ent.setLocalScale(1, 1, 1);
    };

    const knownModuleIds = new Set(moduleOverlays.map((m) => m.id));
    for (const [moduleId, record] of Array.from(overlayRecordsRef.current.entries())) {
      if (!knownModuleIds.has(moduleId)) {
        cleanupRecord(record);
        overlayRecordsRef.current.delete(moduleId);
      }
    }

    moduleOverlays.forEach((module, moduleIndex) => {
      if (!module.url) return;
      const t = parseAlignmentTransform(module.alignment_transform);
      if (!t) return;
      const existing = overlayRecordsRef.current.get(module.id);
      if (existing) {
        if (existing.group) applyGroupTransform(existing.group, t);
        return;
      }

      const record: ModuleOverlayRecord = { group: null, splatLayerIds: [], meshEntities: [], cancelled: false };
      overlayRecordsRef.current.set(module.id, record);

      (async () => {
        // 여러 개의 큰 PLY/텍스처를 동시에 올리면 브라우저 ArrayBuffer/GPU 메모리 피크가
        // 급격히 커진다. 층 overview 는 초 단위 지연보다 안정적인 로딩이 중요하므로 순차에 가깝게 시작한다.
        if (moduleIndex > 0) {
          await delay(moduleIndex * 700);
          if (record.cancelled) return;
        }
        let attempts = 0;
        while (!record.cancelled && (!coreRef.current?.getApp() || !coreRef.current?.getPC()) && attempts < 80) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          attempts++;
        }
        if (record.cancelled) return;
        const app = coreRef.current?.getApp();
        const pc = coreRef.current?.getPC();
        if (!app || !pc) return;

        const group = new pc.Entity(`moduleOverlay_${module.id}`);
        applyGroupTransform(group, t);
        app.root.addChild(group);
        record.group = group;

        const splat = add(module.url!, {
          name: module.name,
          source: 'server',
          visible: true,
        });
        record.splatLayerIds.push(splat.id);
        splat.ready
          .then(() => {
            if (record.cancelled || !record.group) return;
            const ent = getEntity(splat.id);
            if (!ent) return;
            record.group.addChild(ent);
            resetPlyLocalFrame(ent);
          })
          .catch(() => {});

        if (!module.source_upload_id) return;
        try {
          const bundle = await api.get<{
            mesh_meta_url: string | null;
            textures: Record<string, string>;
            texture_variants?: Record<string, Record<string, string>>;
            doors?: Array<{
              id: string;
              unitName?: string | null;
              wallSurfaceId?: string | null;
              corners?: number[][];
              hingeEdge?: number | null;
              swing?: number | null;
              door_mesh?: {
                corners: number[][];
                uvs: number[][];
                normalInward: number[];
                textureUrl: string;
              } | null;
              door_splat?: { url: string } | null;
              door_frame?: {
                positions?: number[];
                indices?: number[];
                color?: [number, number, number];
              } | null;
            }>;
          }>(`/refine/refined-bundle?upload_id=${module.source_upload_id}`);
          if (record.cancelled || !record.group) return;

          const { createWallMeshFromPersisted } = await import('@/lib/gs/wallMesh');

          if (bundle.mesh_meta_url) {
            const metaResp = await fetch(bundle.mesh_meta_url);
            if (metaResp.ok) {
              const meta = await metaResp.json();
              const surfaces = meta.surfaces ?? [];
              const images = await Promise.all(
                surfaces.map((surface: any) => {
                  const url = bundle.textures[surface.surfaceId];
                  return url ? loadHtmlImage(url) : Promise.resolve(null);
                }),
              );
              const viewImageMatrix = await Promise.all(
                surfaces.map((surface: any) => Promise.all(
                  ((surface.textureVariants ?? []) as any[]).map(async (variant: any) => {
                    const url = bundle.texture_variants?.[surface.surfaceId]?.[variant.id];
                    const image = url ? await loadHtmlImage(url) : null;
                    return image
                      ? { id: String(variant.id), viewpoint: variant.viewpoint as [number, number, number], image }
                      : null;
                  }),
                )),
              );
              if (record.cancelled || !record.group) return;
              for (let i = 0; i < surfaces.length; i++) {
                const surface = surfaces[i];
                const img = images[i];
                if (!img) continue;
                const ent = createWallMeshFromPersisted(pc, app, {
                  surfaceId: `module_${module.id}_${surface.surfaceId}`,
                  corners: surface.corners,
                  uvs: surface.uvs,
                  normalInward: surface.normalInward,
                  textureImage: img,
                  viewTextures: viewImageMatrix[i]
                    .filter(Boolean)
                    .map((variant: any) => ({
                      id: variant.id,
                      viewpoint: variant.viewpoint,
                      textureImage: variant.image,
                    })),
                }, { mutableTexture: false });
                record.group.addChild(ent);
                resetPlyLocalFrame(ent);
                record.meshEntities.push(ent);
              }
            }
          }

          for (const door of bundle.doors ?? []) {
            if (record.cancelled || !record.group) return;
            const wrapper = new pc.Entity(`moduleDoor_${module.id}_${door.id}`);
            record.group.addChild(wrapper);
            record.meshEntities.push(wrapper);

            // 문 상호작용 등록 — 힌지/코너/normalInward 가 모두 있어야 열기/닫기 가능.
            // (구버전 모듈은 doorMesh/hinge 메타가 없어 hover/클릭 대상에서 제외됨.)
            const doorNormalInward = door.door_mesh?.normalInward;
            if (
              typeof door.hingeEdge === 'number'
              && Array.isArray(door.corners) && door.corners.length === 4
              && Array.isArray(doorNormalInward) && doorNormalInward.length === 3
            ) {
              registerDoor({
                id: `${module.id}_${door.id}`,
                wrapper,
                corners: door.corners.map(c => [c[0], c[1], c[2]] as [number, number, number]),
                hingeEdge: door.hingeEdge,
                swing: typeof door.swing === 'number' ? door.swing : 1,
                normalInward: [doorNormalInward[0], doorNormalInward[1], doorNormalInward[2]],
              });
            }

            let doorMeshImage: HTMLImageElement | null = null;
            let doorMeshAverageColor: [number, number, number] | null = null;
            if (door.door_mesh) {
              doorMeshImage = await loadHtmlImage(door.door_mesh.textureUrl);
              if (record.cancelled || !record.group) return;
              if (doorMeshImage) {
                doorMeshAverageColor = averageImageColor(doorMeshImage);
              }
            }

            if (door.door_frame?.positions?.length && door.door_frame?.indices?.length) {
              const storedColor = door.door_frame.color;
              const frameColor = storedColor ?? doorMeshAverageColor ?? DEFAULT_DOOR_FRAME_COLOR;
              const ent = createColoredMeshEntity(
                pc,
                app,
                `moduleDoorFrame_${module.id}_${door.id}`,
                door.door_frame.positions,
                door.door_frame.indices,
                frameColor,
              );
              record.meshEntities.push(ent);
            }

            if (door.door_mesh && doorMeshImage) {
              const dm = door.door_mesh;
              const ent = createWallMeshFromPersisted(pc, app, {
                surfaceId: `module_door_${module.id}_${door.id}_${door.wallSurfaceId ?? 'w0'}`,
                corners: dm.corners,
                uvs: dm.uvs,
                normalInward: dm.normalInward as [number, number, number],
                textureImage: doorMeshImage,
              }, { mutableTexture: false });
              wrapper.addChild(ent);
              resetPlyLocalFrame(ent);
            }

            if (door.door_splat?.url) {
              const doorSplat = add(door.door_splat.url, {
                name: `도어 영역 가우시안 (${door.unitName ?? module.name})`,
                source: 'server',
                visible: true,
              });
              record.splatLayerIds.push(doorSplat.id);
              doorSplat.ready
                .then(() => {
                  if (record.cancelled) return;
                  const ent = getEntity(doorSplat.id);
                  if (!ent) return;
                  wrapper.addChild(ent);
                  resetPlyLocalFrame(ent);
                })
                .catch(() => {});
            }
          }
        } catch (e) {
          console.warn(`[FloorCompositeViewer] module refined assets load failed: ${module.name}`, e);
        }
      })();
    });
  }, [add, getEntity, moduleOverlays, remove]);

  useEffect(() => {
    return () => {
      for (const record of Array.from(overlayRecordsRef.current.values())) {
        record.cancelled = true;
        for (const layerId of record.splatLayerIds) {
          try { remove(layerId); } catch {}
        }
        if (record.group) {
          try { record.group.destroy(); } catch {}
        }
      }
      overlayRecordsRef.current.clear();
    };
  }, [remove]);

  return (
    <SplatViewerCore
      ref={coreRef}
      sogUrl={primaryUrl}
      onSplatLoaded={() => setSplatReady(true)}
    >
      {/* 우측 컬럼 — 미니맵(자동 베이크) 위, 천장 컷 패널 아래. 각자 독립 슬라이드 숨김. */}
      <div className="absolute top-3 right-3 z-30 flex flex-col items-end gap-2">
        {floorplan && (
          <Suspense fallback={null}>
            <Minimap
              floorplan={floorplan}
              cameraGetter={() => coreRef.current?.getCamera() ?? null}
            />
          </Suspense>
        )}
        {splatReady && (
          <Suspense fallback={null}>
            <CeilingCutPanel
              enabled={paperCeilingCut}
              onToggle={() => setPaperCeilingCut((v) => !v)}
              cutoff={floorplanCutoff}
              onCutoffChange={setFloorplanCutoff}
            />
          </Suspense>
        )}
      </div>
    </SplatViewerCore>
  );
}

function formatRegisteredAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
}

export default function FloorDetailPage() {
  const router = useRouter();
  const params = useParams();
  const buildingId = params.name as string;
  const floorNumber = params.floorNumber as string;
  const { user, loading } = useAuth();
  const { show: showToast } = useToast();

  const [manifest, setManifest] = useState<FloorDetailManifest | null>(null);
  const [primaryUrl, setPrimaryUrl] = useState<string | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [showAddModuleModal, setShowAddModuleModal] = useState(false);
  const [pickerRoomSuffix, setPickerRoomSuffix] = useState(1);
  const [creatingModule, setCreatingModule] = useState(false);
  const [addModuleError, setAddModuleError] = useState<string | null>(null);
  const [expandedModuleNames, setExpandedModuleNames] = useState<Set<string>>(() => new Set());
  const [basemapRoomNames, setBasemapRoomNames] = useState<string[]>([]);

  const reloadManifest = () => {
    if (!buildingId || !floorNumber) return Promise.resolve();
    return api
      .get<FloorDetailManifest>(`/buildings/${buildingId}/floors/${floorNumber}/detail-manifest`)
      .then((data) => {
        setManifest(data);
        const defaultModule = data.modules.find((module) => module.url);
        const defaultUrl = data.basemap?.url ?? defaultModule?.url ?? null;
        setPrimaryUrl(defaultUrl);
        setSelectedModuleId(data.basemap?.url ? null : defaultModule?.id ?? null);
        setExpandedModuleNames(new Set());
      })
      .catch(() => {
        setManifest(null);
        setPrimaryUrl(null);
        setSelectedModuleId(null);
        setExpandedModuleNames(new Set());
      });
  };

  useEffect(() => {
    reloadManifest();
  }, [buildingId, floorNumber]);

  useEffect(() => {
    const basemapId = manifest?.basemap?.id;
    if (!basemapId) {
      setBasemapRoomNames([]);
      return;
    }
    let disposed = false;
    api
      .get<BasemapDoorListResponse>(`/basemaps/${basemapId}/doors`)
      .then((data) => {
        if (disposed) return;
        const names = Array.from(
          new Set(
            (data.doors ?? [])
              .map((door) => door.unitName?.trim())
              .filter((name): name is string => !!name),
          ),
        ).sort(moduleNameCollator.compare);
        setBasemapRoomNames(names);
      })
      .catch(() => {
        if (!disposed) setBasemapRoomNames([]);
      });
    return () => {
      disposed = true;
    };
  }, [manifest?.basemap?.id]);

  const moduleRows = useMemo(() => manifest?.modules ?? [], [manifest]);
  // 모듈을 호수별로 그룹화 + 호수명 자연 정렬 (101 < 102 < 1001).
  // 각 호수 안 모듈은 등록 시점 오름차순 (가장 오래된 위) — moduleVersionTime 헬퍼 기반.
  const groupedModules = useMemo(() => {
    const grouped = new Map<string, FloorDetailModuleEntry[]>();
    moduleRows.forEach((module) => {
      const modules = grouped.get(module.name) ?? [];
      modules.push(module);
      grouped.set(module.name, modules);
    });
    return grouped;
  }, [moduleRows]);
  const moduleGroups = useMemo<RoomModuleGroup[]>(() => {
    const basemapRoomSet = new Set(basemapRoomNames);
    const primaryRooms = basemapRoomNames.length > 0
      ? basemapRoomNames
      : Array.from(groupedModules.keys()).sort(moduleNameCollator.compare);
    const extraModuleRooms = Array.from(groupedModules.keys())
      .filter((name) => !basemapRoomSet.has(name))
      .sort(moduleNameCollator.compare);
    return [...primaryRooms, ...extraModuleRooms].map((name) => ({
      name,
      modules: [...(groupedModules.get(name) ?? [])].sort(compareModuleVersionAsc),
      fromBasemap: basemapRoomNames.length === 0 || basemapRoomSet.has(name),
    }));
  }, [basemapRoomNames, groupedModules]);
  const hasBasemap = !!manifest?.basemap?.url;
  const allowedRoomSuffixes = useMemo(() => {
    if (!manifest || basemapRoomNames.length === 0) return undefined;
    return basemapRoomNames
      .map((name) => roomSuffixFromLabel(manifest.floor_number, name))
      .filter((suffix): suffix is number => suffix !== null);
  }, [basemapRoomNames, manifest]);
  const selectedRoomName = manifest ? roomNumberLabel(manifest.floor_number, pickerRoomSuffix) : '';
  const selectedRoomAllowed = !allowedRoomSuffixes || allowedRoomSuffixes.includes(pickerRoomSuffix);

  const renderableModules = useMemo(
    () => moduleRows.filter((module) => module.url && module.is_visible !== false),
    [moduleRows],
  );
  const moduleOverlays = useMemo(() => {
    if (!primaryUrl || !hasBasemap) return [];
    return renderableModules.filter((module) => module.url !== primaryUrl && module.alignment_transform);
  }, [hasBasemap, primaryUrl, renderableModules]);

  if (loading) return null;

  return (
    <div
      className="h-[calc(100vh-56px)] flex"
      style={{ background: 'var(--bg)', color: 'var(--ink)' }}
    >
      <aside
        className="w-80 border-r p-4 flex flex-col shrink-0"
        style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
      >
        <button
          type="button"
          onClick={() => router.push(`/buildings/${buildingId}`)}
          className="text-sm transition self-start hover:underline underline-offset-4"
          style={{ color: 'var(--muted)' }}
        >
          Back to Floors
        </button>
        <h1 className="mt-4 text-base font-semibold truncate" style={{ color: 'var(--ink)' }}>
          {manifest?.building_name ?? 'Building'}
        </h1>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Floor {manifest?.floor_number ?? floorNumber}
        </p>

        <div
          className="mt-4 text-[11px] font-semibold uppercase shrink-0"
          style={{ color: 'var(--muted)', fontFamily: 'ui-monospace, Menlo, monospace', letterSpacing: 0 }}
        >
          Rooms ({moduleGroups.length})
        </div>
        <div className="mt-3 space-y-2 overflow-y-auto flex-1 min-h-0 pr-1">
          {moduleGroups.map(({ name: roomName, modules: mods, fromBasemap }) => {
            const expanded = expandedModuleNames.has(roomName);
            const anySelected = mods.some((m) => m.id === selectedModuleId);
            const activeCount = mods.filter((m) => m.url).length;
            const totalCount = mods.length;
            const registered = activeCount > 0;
            return (
              <div key={roomName} className="rounded-md overflow-hidden">
                <button
                  type="button"
                  onClick={() => {
                    if (mods.length === 0) return;
                    setExpandedModuleNames((prev) => {
                      const next = new Set(prev);
                      if (next.has(roomName)) next.delete(roomName);
                      else next.add(roomName);
                      return next;
                    });
                  }}
                  className={`w-full px-4 py-3 text-left transition border ${
                    expanded ? 'rounded-t-md' : 'rounded-md'
                  } ${
                    mods.length > 0
                      ? 'hover:brightness-125 hover:shadow-[0_0_0_1px_rgba(56,189,248,0.32)]'
                      : 'cursor-default'
                  }`}
                  style={{
                    borderColor: anySelected ? 'var(--accent)' : registered ? 'rgba(56,189,248,0.35)' : 'var(--rule)',
                    background: anySelected
                      ? 'var(--accent-soft)'
                      : registered
                        ? 'rgba(56,189,248,0.08)'
                        : 'rgba(255,255,255,0.025)',
                    color: registered ? 'var(--ink)' : 'var(--muted)',
                    opacity: fromBasemap ? 1 : 0.72,
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-base font-semibold truncate">{roomName}</div>
                      <div
                        className="text-[11px] mt-0.5"
                        style={{ color: registered ? 'var(--accent)' : 'var(--muted)' }}
                      >
                        {registered
                          ? `${activeCount}개 등록${activeCount < totalCount ? ` · ${totalCount}개 중` : ''}`
                          : '모듈 미등록'}
                      </div>
                    </div>
                    {mods.length > 0 ? (
                      <svg
                        className={`w-4 h-4 shrink-0 transition-transform ${
                          expanded ? 'rotate-90' : ''
                        }`}
                        style={{ color: registered ? 'var(--accent)' : 'var(--muted)' }}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                      </svg>
                    ) : (
                      <span className="text-[11px] shrink-0" style={{ color: 'var(--muted-2)' }}>비활성</span>
                    )}
                  </div>
                </button>
                {expanded && (
                  <div
                    className="border border-t-0 rounded-b-md divide-y"
                    style={{
                      borderColor: anySelected ? 'var(--accent)' : 'var(--rule)',
                      background: 'var(--paper)',
                    }}
                  >
                    {mods.map((module) => {
                      const isSelected = selectedModuleId === module.id;
                      const disabled = !module.url;
                      const label = module.uploader_name?.trim() || `user ${module.user_id.slice(0, 6)}`;
                      return (
                        <div
                          key={module.id}
                          className="group flex items-stretch transition"
                          style={{
                            background: isSelected ? 'var(--accent-soft)' : undefined,
                            color: disabled ? 'var(--muted-2)' : 'var(--ink)',
                            borderColor: 'var(--rule-soft)',
                          }}
                        >
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => {
                              if (!module.url) return;
                              setSelectedModuleId(module.id);
                              if (!hasBasemap) setPrimaryUrl(module.url);
                            }}
                            className={`flex-1 min-w-0 px-4 py-2.5 text-left ${
                              disabled ? 'cursor-not-allowed' : 'hover:bg-sky-400/10'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-xs" style={{ color: 'var(--muted)' }}>└</span>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium truncate">{label}</div>
                                {disabled ? (
                                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>Scene 없음</div>
                                ) : module.version ? (
                                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>{formatRegisteredAt(module.version) ?? module.version}</div>
                                ) : null}
                              </div>
                              {isSelected && (
                                <svg
                                  className="w-4 h-4 shrink-0"
                                  style={{ color: 'var(--accent)' }}
                                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const ok = window.confirm(`${roomName} (${label}) 모듈을 삭제하시겠습니까?\n관련 업로드/씬 데이터 모두 삭제됩니다.`);
                              if (!ok) return;
                              try {
                                await api.delete(`/admin/modules/${module.id}`);
                                await reloadManifest();
                              } catch (err: any) {
                                showToast(`모듈 삭제 실패: ${err?.message ?? err}`, 'error');
                              }
                            }}
                            className="px-3 flex items-center transition opacity-60 group-hover:opacity-100 hover:bg-red-500/10"
                            style={{ color: 'var(--muted)' }}
                            aria-label="모듈 삭제"
                            title="모듈 삭제"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {moduleGroups.length === 0 && (
            <p className="text-sm px-1" style={{ color: 'var(--muted)' }}>basemap에 등록된 호수가 없습니다.</p>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            setAddModuleError(null);
            setPickerRoomSuffix(allowedRoomSuffixes?.[0] ?? 1);
            setShowAddModuleModal(true);
          }}
          disabled={!manifest?.floor_id || !user}
          title={!user ? '로그인 후 등록 가능합니다' : undefined}
          className="mt-4 shrink-0 w-full inline-flex items-center justify-center gap-2 rounded-sm border py-3 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: 'var(--accent)',
            color: '#04131f',
            borderColor: 'var(--accent)',
          }}
          aria-label="모듈 추가"
        >
          <span
            className="inline-flex items-center justify-center w-6 h-6 rounded-full text-lg leading-none font-bold"
            style={{ background: 'rgba(255,255,255,0.15)' }}
          >
            +
          </span>
          <span>모듈 추가</span>
        </button>
      </aside>

      {showAddModuleModal && manifest && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => {
            if (!creatingModule) setShowAddModuleModal(false);
          }}
        >
          <div
            className="w-[320px] rounded-xl border p-5 shadow-2xl"
            style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-center" style={{ color: 'var(--ink)' }}>
              호수를 선택하세요
            </h2>
            <p className="text-xs text-center mt-1" style={{ color: 'var(--muted)' }}>
              Floor {manifest.floor_number}
            </p>

            <div className="mt-4">
              <RoomWheelPicker
                floorNumber={manifest.floor_number}
                value={pickerRoomSuffix}
                enabledSuffixes={allowedRoomSuffixes}
                onChange={(next) => {
                  setPickerRoomSuffix(next);
                  setAddModuleError(null);
                }}
              />
            </div>
            {allowedRoomSuffixes && allowedRoomSuffixes.length > 0 && !selectedRoomAllowed && (
              <p className="mt-2 text-xs text-center" style={{ color: 'var(--muted)' }}>
                basemap에 등록된 호수만 선택할 수 있습니다.
              </p>
            )}
            {allowedRoomSuffixes?.length === 0 && (
              <p className="mt-2 text-xs text-center" style={{ color: '#fca5a5' }}>
                basemap에 등록된 호수가 없습니다.
              </p>
            )}

            {addModuleError && (
              <p className="mt-3 text-xs text-center" style={{ color: '#b04646' }}>{addModuleError}</p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                disabled={creatingModule}
                onClick={() => setShowAddModuleModal(false)}
                className="flex-1 rounded-sm border hover:bg-sky-400/10 disabled:opacity-50 py-2 text-sm"
                style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
              >
                취소
              </button>
              <button
                type="button"
                disabled={creatingModule || !selectedRoomAllowed || allowedRoomSuffixes?.length === 0}
                onClick={async () => {
                  if (!manifest?.floor_id || !manifest?.building_id) return;
                  const name = roomNumberLabel(manifest.floor_number, pickerRoomSuffix);
                  setCreatingModule(true);
                  setAddModuleError(null);
                  try {
                    // 사전 확인: 같은 사용자가 같은 호수에 저장된 정합 작업물이 있는지 체크.
                    // 단순 Module 슬롯만 있는 경우는 신규 저장으로 취급한다.
                    const existing = await api.get<Array<{ id: string; name: string; alignment_transform?: unknown | null }>>(
                      `/floors/${manifest.floor_id}/modules`,
                    );
                    const alreadyHasSavedWork = existing.some((m) => m.name === name && !!m.alignment_transform);
                    if (alreadyHasSavedWork) {
                      const ok = window.confirm(
                        `${name} 은(는) 이미 등록되어 있습니다.\n계속 진행하면 정합 완료 시 기존 작업물은 삭제되고 새 작업물로 교체됩니다.\n\n진행하시겠습니까?`,
                      );
                      if (!ok) {
                        setCreatingModule(false);
                        return;
                      }
                    }
                    const qs = new URLSearchParams({
                      purpose: 'module',
                      building_id: manifest.building_id,
                      building_name: manifest.building_name ?? 'Building',
                      floor_id: manifest.floor_id,
                      floor_number: String(manifest.floor_number),
                      module_name: name,
                    });
                    router.push(`/viewer?${qs.toString()}`);
                  } catch (err: any) {
                    setAddModuleError(err?.message || '뷰어 이동에 실패했습니다.');
                    setCreatingModule(false);
                  }
                }}
                className="flex-1 rounded-sm border disabled:opacity-60 py-2 text-sm font-semibold"
                style={{
                  background: 'var(--accent)',
                  color: '#04131f',
                  borderColor: 'var(--accent)',
                }}
              >
                {creatingModule ? '확인 중...' : `${selectedRoomName} 등록`}
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 bg-black">
        {primaryUrl ? (
          <FloorCompositeViewer
            primaryUrl={primaryUrl}
            basemapSourceUploadId={manifest?.basemap?.source_upload_id ?? null}
            moduleOverlays={moduleOverlays}
          />
        ) : manifest?.basemap_pending_approval ? (
          <div
            className="h-full flex items-center justify-center px-6"
            style={{ background: 'var(--bg)' }}
          >
            <div className="max-w-md text-center">
              <div
                className="inline-flex items-center justify-center w-14 h-14 rounded-full border mb-4"
                style={{ background: '#f5ecd6', borderColor: '#c9a227' }}
              >
                <svg className="w-7 h-7" style={{ color: '#a07f1a' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="text-base font-semibold mb-1" style={{ color: '#a07f1a' }}>관리자 승인 대기중</div>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--ink-2)' }}>
                이 층의 basemap 이 등록되었지만 아직 관리자 승인 전입니다.<br />
                승인 완료 후 자동으로 표시됩니다.
              </p>
            </div>
          </div>
        ) : (
          <div
            className="h-full flex items-center justify-center px-6"
            style={{ background: 'var(--bg)' }}
          >
            <div className="max-w-md text-center">
              <div className="text-base font-semibold mb-1" style={{ color: 'var(--ink)' }}>등록된 basemap 이 없습니다</div>
              <p className="text-sm mb-5" style={{ color: 'var(--muted)' }}>
                이 층에 표시할 basemap 이 아직 등록되지 않았습니다.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (!manifest) return;
                  const qs = new URLSearchParams({
                    purpose: 'basemap',
                    building_id: manifest.building_id,
                    building_name: manifest.building_name ?? 'Building',
                    floor_id: manifest.floor_id,
                    floor_number: String(manifest.floor_number),
                  });
                  router.push(`/viewer?${qs.toString()}`);
                }}
                disabled={!user}
                title={!user ? '로그인 후 등록 가능합니다' : undefined}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-sm border text-sm font-semibold transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  background: 'var(--accent)',
                  color: '#04131f',
                  borderColor: 'var(--accent)',
                }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Basemap 등록
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
