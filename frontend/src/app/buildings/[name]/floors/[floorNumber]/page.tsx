'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { FloorDetailManifest, FloorDetailModuleEntry } from '@/types';
import SplatViewerCore, { type SplatViewerCoreRef } from '@/components/viewer/SplatViewerCore';
import { useAdditionalGsplats } from '@/components/viewer/tools/useAdditionalGsplats';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type Scale3 = [number, number, number];

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

function FloorCompositeViewer({
  primaryUrl,
  moduleOverlays,
}: {
  primaryUrl: string;
  moduleOverlays: FloorDetailModuleEntry[];
}) {
  const coreRef = useRef<SplatViewerCoreRef>(null);
  const additional = useAdditionalGsplats(coreRef);
  const { add, getEntity, remove, setTransform } = additional;
  const layerIdsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const knownModuleIds = new Set(moduleOverlays.map((m) => m.id));
    for (const [moduleId, layerId] of Array.from(layerIdsRef.current.entries())) {
      if (!knownModuleIds.has(moduleId)) {
        remove(layerId);
        layerIdsRef.current.delete(moduleId);
      }
    }

    moduleOverlays.forEach((module) => {
      if (!module.url) return;
      const existing = layerIdsRef.current.get(module.id);
      if (existing) return;
      const { id, ready } = add(module.url, {
        name: module.name,
        source: 'server',
        visible: true,
      });
      layerIdsRef.current.set(module.id, id);
      ready
        .then(() => {
          const t = parseAlignmentTransform(module.alignment_transform);
          if (!t) return;
          setTransform(id, t.position, t.rotation);
          const ent = getEntity(id);
          if (ent) ent.setLocalScale(t.scale[0], t.scale[1], t.scale[2]);
        })
        .catch(() => {});
    });
  }, [add, getEntity, moduleOverlays, remove, setTransform]);

  useEffect(() => {
    return () => {
      for (const layerId of Array.from(layerIdsRef.current.values())) remove(layerId);
      layerIdsRef.current.clear();
    };
  }, [remove]);

  return <SplatViewerCore ref={coreRef} sogUrl={primaryUrl} />;
}

export default function FloorDetailPage() {
  const router = useRouter();
  const params = useParams();
  const buildingId = params.name as string;
  const floorNumber = params.floorNumber as string;
  const { user, loading } = useAuth();

  const [manifest, setManifest] = useState<FloorDetailManifest | null>(null);
  const [primaryUrl, setPrimaryUrl] = useState<string | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [openModuleMenuId, setOpenModuleMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (!buildingId || !floorNumber) return;
    api
      .get<FloorDetailManifest>(`/buildings/${buildingId}/floors/${floorNumber}/detail-manifest`)
      .then((data) => {
        setManifest(data);
        const defaultUrl = data.basemap?.url ?? data.modules.find((module) => module.url)?.url ?? null;
        setPrimaryUrl(defaultUrl);
        setSelectedModuleId(null);
      })
      .catch(() => {
        setManifest(null);
        setPrimaryUrl(null);
        setSelectedModuleId(null);
      });
  }, [buildingId, floorNumber]);

  const moduleRows = useMemo(() => manifest?.modules ?? [], [manifest]);
  const hasBasemap = !!manifest?.basemap?.url;

  const goRegisterModule = (moduleName: string) => {
    setOpenModuleMenuId(null);
    const qs = new URLSearchParams({
      purpose: 'module',
      building_id: buildingId,
      building_name: manifest?.building_name ?? 'Building',
      floor_number: String(manifest?.floor_number ?? floorNumber),
      module_name: moduleName,
    });
    if (manifest?.floor_id) qs.set('floor_id', manifest.floor_id);
    router.push(`/viewer?${qs.toString()}`);
  };
  const renderableModules = useMemo(
    () => moduleRows.filter((module) => module.url && module.is_visible !== false),
    [moduleRows],
  );
  const moduleOverlays = useMemo(() => {
    if (!primaryUrl) return [];
    return renderableModules.filter((module) => {
      if (module.url === primaryUrl) return false;
      if (!hasBasemap) return true;
      return !!module.alignment_transform;
    });
  }, [hasBasemap, primaryUrl, renderableModules]);

  if (loading) return null;

  return (
    <div className="h-[calc(100vh-56px)] bg-gray-950 text-gray-100 flex">
      <aside className="w-80 border-r border-gray-800 bg-gray-900/70 p-4 flex flex-col shrink-0">
        <button
          type="button"
          onClick={() => router.push(`/buildings/${buildingId}`)}
          className="text-sm text-gray-400 hover:text-white transition self-start"
        >
          Back to Floors
        </button>
        <h1 className="mt-4 text-base font-semibold truncate">{manifest?.building_name ?? 'Building'}</h1>
        <p className="mt-1 text-xs text-gray-500">Floor {manifest?.floor_number ?? floorNumber}</p>

        <div className="mt-4 text-xs text-gray-500">Modules ({moduleRows.length})</div>
        <div className="mt-2 space-y-2 overflow-y-auto">
          {moduleRows.map((module) => (
            <div
              key={module.id}
              className={`flex items-center rounded-md border transition ${
                module.url
                  ? selectedModuleId === module.id
                    ? 'border-blue-500/70 bg-blue-500/10'
                    : 'border-gray-800 hover:border-gray-700 hover:bg-gray-800/60'
                  : 'border-gray-800'
              }`}
            >
              <button
                type="button"
                disabled={!module.url}
                onClick={() => {
                  if (!module.url) return;
                  setSelectedModuleId(module.id);
                  if (!hasBasemap) setPrimaryUrl(module.url);
                }}
                className={`flex-1 px-3 py-2 text-left ${
                  module.url ? '' : 'text-gray-500 cursor-not-allowed'
                }`}
              >
                <div className="text-sm font-medium truncate">{module.name}</div>
              </button>
              <div className="relative pr-1">
                <button
                  type="button"
                  onClick={() => setOpenModuleMenuId((prev) => (prev === module.id ? null : module.id))}
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-white"
                  aria-label="더보기"
                >
                  ⋮
                </button>
                {openModuleMenuId === module.id && (
                  <div className="absolute right-0 top-8 z-10 w-28 rounded border border-gray-700 bg-gray-900 shadow-lg p-1">
                    <button
                      type="button"
                      onClick={() => goRegisterModule(module.name)}
                      className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-gray-800"
                    >
                      module 등록
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {moduleRows.length === 0 && <p className="text-sm text-gray-500">No modules available.</p>}
        </div>
      </aside>

      <main className="flex-1 bg-black">
        {primaryUrl ? (
          <FloorCompositeViewer primaryUrl={primaryUrl} moduleOverlays={moduleOverlays} />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-500">No renderable URL available for this floor.</div>
        )}
      </main>
    </div>
  );
}
