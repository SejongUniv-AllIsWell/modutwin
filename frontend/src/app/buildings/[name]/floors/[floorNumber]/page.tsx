'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { FloorDetailManifest, FloorDetailModuleEntry } from '@/types';
import SplatViewerCore, { type SplatViewerCoreRef } from '@/components/viewer/SplatViewerCore';
import { useAdditionalGsplats } from '@/components/viewer/tools/useAdditionalGsplats';
import { useCeilingRemoval, type CeilingMaskRecord } from '@/components/viewer/tools/useCeilingRemoval';
import { useRefinedMeshLoader } from '@/components/viewer/tools/useRefinedMeshLoader';
import { useToast } from '@/components/ui/Toast';
import RoomWheelPicker, { roomNumberLabel } from '@/components/ui/RoomWheelPicker';

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
type ModuleOverlayRecord = CeilingMaskRecord & {
  group: any | null;
  splatLayerIds: string[];               // 전체 splat layer (cleanup 용 — 메인 + 도어)
  meshEntities: any[];
  cancelled: boolean;
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

function FloorCompositeViewer({
  primaryUrl,
  basemapSourceUploadId,
  primarySourceUploadId,
  primaryIsModule,
  moduleOverlays,
  ceilingRemoved,
  onCoreReady,
}: {
  primaryUrl: string;
  basemapSourceUploadId: string | null;
  primarySourceUploadId: string | null;   // 천장제거: primary 자산의 mesh.json fetch 대상
  primaryIsModule: boolean;               // 베이스맵 없이 모듈이 primary 인 경우
  moduleOverlays: FloorDetailModuleEntry[];
  ceilingRemoved: boolean;
  /**
   * coreRef 가 mount 되면 부모에 전달. 부모(FloorPage)가 snapshotTopdown 같은 imperative API 를
   * 호출할 수 있도록. unmount 시 null 로 한 번 더 호출.
   */
  onCoreReady?: (core: SplatViewerCoreRef | null) => void;
}) {
  const coreRef = useRef<SplatViewerCoreRef>(null);
  const additional = useAdditionalGsplats(coreRef);
  const { add, getEntity, remove, applyCeilingMask } = additional;
  const overlayRecordsRef = useRef<Map<string, ModuleOverlayRecord>>(new Map());
  const {
    applyModuleCeilingState,
    clearPrimaryCeiling,
    handlePrimarySplatLoaded,
    registerPrimaryFromSurfaces,
  } = useCeilingRemoval<ModuleOverlayRecord>({
    coreRef,
    ceilingRemoved,
    overlayRecordsRef,
    applyAdditionalCeilingMask: applyCeilingMask,
  });

  useEffect(() => {
    clearPrimaryCeiling();
  }, [clearPrimaryCeiling, primaryUrl, primarySourceUploadId, basemapSourceUploadId, primaryIsModule]);

  // 베이스맵의 wall mesh + 텍스처(천장/바닥/벽) + 도어 splat 까지 같이 로드.
  // 4번째 인자 (additional) 가 있어야 도어 splat 도 씬에 add 됨.
  // 층 overview 는 보기 전용이므로 CPU ImageData 복사 없이 로드해 대형 텍스처 메모리 사용을 줄인다.
  // onLoaded: primary 자산이 베이스맵일 때 visual ceiling entity + Y 를 잡아둠. primary 가 모듈이면
  //   별도의 useRefinedMeshLoader 호출 (아래) 이 채움.
  useRefinedMeshLoader(
    coreRef,
    basemapSourceUploadId ?? undefined,
    !!basemapSourceUploadId,
    additional,
    null,
    false,
    undefined,
    !primaryIsModule
      ? ({ surfaces }) => {
          registerPrimaryFromSurfaces(surfaces);
        }
      : undefined,
  );

  // primary 가 모듈인 경우 — 그 모듈의 mesh.json 을 별도로 로드해 visual ceiling entity / Y 를 잡음.
  // additionalForDoorSplats / onlyDoorUnitName 둘 다 null/undefined — 도어 splat 은 별도 흐름이 처리.
  useRefinedMeshLoader(
    coreRef,
    primaryIsModule ? (primarySourceUploadId ?? undefined) : undefined,
    primaryIsModule && !!primarySourceUploadId,
    undefined,
    null,
    false,
    undefined,
    primaryIsModule
      ? ({ surfaces }) => {
          registerPrimaryFromSurfaces(surfaces);
        }
      : undefined,
  );

  useEffect(() => {
    const cleanupRecord = (record: ModuleOverlayRecord) => {
      record.cancelled = true;
      for (const layerId of record.splatLayerIds) {
        try { remove(layerId); } catch {}
      }
      record.splatLayerIds = [];
      record.mainSplatLayerId = null;
      for (const ent of record.meshEntities) {
        try { ent.destroy(); } catch {}
      }
      record.meshEntities = [];
      record.visualCeilingEntity = null;
      record.visualCeilingY = null;
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

      const record: ModuleOverlayRecord = {
        group: null,
        splatLayerIds: [],
        mainSplatLayerId: null,
        meshEntities: [],
        visualCeilingEntity: null,
        visualCeilingY: null,
        cancelled: false,
      };
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
        record.mainSplatLayerId = splat.id;   // 천장제거 마스크 대상 (도어 splat 제외)
        splat.ready
          .then(() => {
            if (record.cancelled || !record.group) return;
            const ent = getEntity(splat.id);
            if (!ent) return;
            record.group.addChild(ent);
            resetPlyLocalFrame(ent);
            // 천장제거 토글이 ON 상태라면 이 모듈에 즉시 마스킹 (race-safe).
            applyModuleCeilingState(record);
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
                // visual ceiling = 코드 surfaceId 'floor' (claude.md:78-80). entity 와 baked Y 잡고 토글 즉시 반영.
                if (surface.surfaceId === 'floor') {
                  record.visualCeilingEntity = ent;
                  record.visualCeilingY = surface.corners[0][1];
                  applyModuleCeilingState(record);
                }
              }
            }
          }

          for (const door of bundle.doors ?? []) {
            if (record.cancelled || !record.group) return;
            const wrapper = new pc.Entity(`moduleDoor_${module.id}_${door.id}`);
            record.group.addChild(wrapper);
            record.meshEntities.push(wrapper);

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
  }, [add, getEntity, moduleOverlays, remove, applyModuleCeilingState]);

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

  // primary splat (베이스맵 또는 primary 모듈) 의 PLY asset 이 로드된 시점에 호출.
  // mesh.json 이 먼저 도착해 천장 마스크가 skip 됐더라도 useCeilingRemoval 이 여기서 복구 적용한다.
  // callback ref — mount 시 부모에 core 전달, unmount 시 null 전달. snapshotTopdown 등 imperative API 호출용.
  const setCoreRef = useCallback((node: SplatViewerCoreRef | null) => {
    (coreRef as React.MutableRefObject<SplatViewerCoreRef | null>).current = node;
    onCoreReady?.(node);
  }, [onCoreReady]);

  return <SplatViewerCore ref={setCoreRef} sogUrl={primaryUrl} onSplatLoaded={handlePrimarySplatLoaded} />;
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

  // primary 자산의 source_upload_id — 베이스맵이 primary 면 베이스맵의, 모듈이 primary 면 그 모듈의 것.
  // 천장제거가 mesh.json 의 ceiling corners 를 읽어야 하므로 둘 다 cover.
  const primarySourceUploadId = useMemo<string | null>(() => {
    if (!primaryUrl) return null;
    if (manifest?.basemap?.url === primaryUrl) return manifest?.basemap?.source_upload_id ?? null;
    const primaryModule = renderableModules.find((m) => m.url === primaryUrl);
    return primaryModule?.source_upload_id ?? null;
  }, [manifest, primaryUrl, renderableModules]);
  const primaryIsModule = !!primaryUrl && manifest?.basemap?.url !== primaryUrl;

  // 천장제거 토글 — primary + overlay 모든 모듈의 천장 wallMesh + 천장 위 가우시안 alpha 마스킹.
  // FloorCompositeViewer 가 자산 도착 시점에 따라 race-safe 하게 적용.
  const [ceilingRemoved, setCeilingRemoved] = useState(false);

  // 층 대표 이미지 캡처 (admin) — FloorCompositeViewer 의 coreRef 를 통해 imperative snapshotTopdown 호출.
  const viewerCoreRef = useRef<SplatViewerCoreRef | null>(null);
  const [capturingOverview, setCapturingOverview] = useState(false);
  const isAdmin = user?.role === 'admin';
  const handleCaptureOverview = useCallback(async () => {
    if (!manifest) return;
    const core = viewerCoreRef.current;
    if (!core) { showToast('뷰어 준비 중입니다. 잠시 후 다시 시도하세요.'); return; }
    if (!ceilingRemoved) {
      showToast('천장 제거 후 캡처해야 실내가 보입니다.');
      return;
    }
    setCapturingOverview(true);
    try {
      const result = await core.snapshotTopdown({ padding: 0.5 });
      if (!result) { showToast('캡처 실패 — 자산 로드를 기다려주세요.'); return; }
      const fd = new FormData();
      fd.append('image', result.blob, 'overview.png');
      fd.append('meta', JSON.stringify(result.meta));
      await api.postForm(`/admin/floors/${manifest.floor_id}/overview-image`, fd);
      showToast('층 대표 이미지 저장 완료. 빌딩 페이지로 돌아가면 카드에 반영됩니다.');
    } catch (e: any) {
      showToast(`저장 실패: ${e?.message ?? e}`);
    } finally {
      setCapturingOverview(false);
    }
  }, [manifest, ceilingRemoved, showToast]);

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

      <main className="flex-1 bg-black relative">
        {primaryUrl ? (
          <>
            <FloorCompositeViewer
              primaryUrl={primaryUrl}
              basemapSourceUploadId={manifest?.basemap?.source_upload_id ?? null}
              primarySourceUploadId={primarySourceUploadId}
              primaryIsModule={primaryIsModule}
              moduleOverlays={moduleOverlays}
              ceilingRemoved={ceilingRemoved}
              onCoreReady={(core) => { viewerCoreRef.current = core; }}
            />
            {primarySourceUploadId && (
              <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 items-end">
                <button
                  type="button"
                  onClick={() => setCeilingRemoved((v) => !v)}
                  className="px-3 py-2 rounded text-xs font-semibold border transition"
                  style={{
                    background: ceilingRemoved ? 'var(--accent)' : 'var(--paper)',
                    color: ceilingRemoved ? '#04131f' : 'var(--ink)',
                    borderColor: 'var(--rule)',
                  }}
                >
                  {ceilingRemoved ? '천장 복원' : '천장 제거'}
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={handleCaptureOverview}
                    disabled={capturingOverview || !ceilingRemoved}
                    title={!ceilingRemoved ? '천장 제거 후 캡처하세요' : '현재 씬을 위에서 본 ortho top-down 으로 캡처해 층 대표 이미지로 저장'}
                    className="px-3 py-2 rounded text-xs font-semibold border transition disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      background: 'var(--paper)',
                      color: 'var(--ink)',
                      borderColor: 'var(--rule)',
                    }}
                  >
                    {capturingOverview ? '저장 중...' : '대표 이미지로 저장'}
                  </button>
                )}
              </div>
            )}
          </>
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
