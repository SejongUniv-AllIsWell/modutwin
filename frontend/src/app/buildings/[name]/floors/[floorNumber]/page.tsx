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
type ModuleGroup = {
  name: string;
  modules: FloorDetailModuleEntry[];
};

const moduleNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const moduleTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

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
  const [expandedModuleNames, setExpandedModuleNames] = useState<Set<string>>(() => new Set());

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
  }, [buildingId, floorNumber]);

  const moduleRows = useMemo(() => manifest?.modules ?? [], [manifest]);
  const moduleGroups = useMemo<ModuleGroup[]>(() => {
    const grouped = new Map<string, FloorDetailModuleEntry[]>();
    moduleRows.forEach((module) => {
      const modules = grouped.get(module.name) ?? [];
      modules.push(module);
      grouped.set(module.name, modules);
    });
    return Array.from(grouped.entries())
      .map(([name, modules]) => ({
        name,
        modules: [...modules].sort(compareModuleVersionAsc),
      }))
      .sort((a, b) => moduleNameCollator.compare(a.name, b.name));
  }, [moduleRows]);
  const hasBasemap = !!manifest?.basemap?.url;

  const goRegisterModule = (moduleName: string) => {
    const qs = new URLSearchParams({
      purpose: 'module',
      building_id: buildingId,
      building_name: manifest?.building_name ?? 'Building',
      floor_number: String(manifest?.floor_number ?? floorNumber),
      module_name: moduleName,
    });
    if (manifest?.floor_id) qs.set('floor_id', manifest.floor_id);
    router.push(`/upload?${qs.toString()}`);
  };
  const toggleModuleGroup = (moduleName: string) => {
    setExpandedModuleNames((prev) => {
      const next = new Set(prev);
      if (next.has(moduleName)) {
        next.delete(moduleName);
      } else {
        next.add(moduleName);
      }
      return next;
    });
  };
  const renderableModules = useMemo(
    () => moduleRows.filter((module) => module.url && module.is_visible !== false),
    [moduleRows],
  );
  const selectedModule = useMemo(
    () => renderableModules.find((module) => module.id === selectedModuleId) ?? null,
    [renderableModules, selectedModuleId],
  );
  const moduleOverlays = useMemo(() => {
    if (!primaryUrl || !hasBasemap || !selectedModule?.url) return [];
    if (selectedModule.url === primaryUrl) return [];
    if (!selectedModule.alignment_transform) return [];
    return [selectedModule];
  }, [hasBasemap, primaryUrl, selectedModule]);

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

        <div className="mt-4 text-xs text-gray-500">Modules ({moduleGroups.length})</div>
        <div className="mt-2 space-y-2 overflow-y-auto">
          {moduleGroups.map((group) => {
            const uploadedModules = group.modules.filter(hasModuleResult);
            const expanded = expandedModuleNames.has(group.name);
            const selectedInGroup = uploadedModules.some((module) => module.id === selectedModuleId);
            const canExpand = uploadedModules.length > 0;
            return (
              <div
                key={group.name}
                className={`rounded-md border transition ${
                  selectedInGroup
                    ? 'border-blue-500/70 bg-blue-500/10'
                    : 'border-gray-800 hover:border-gray-700'
                }`}
              >
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      if (canExpand) toggleModuleGroup(group.name);
                    }}
                    className={`flex-1 px-3 py-2 text-left ${canExpand ? 'hover:bg-gray-800/60' : ''}`}
                    aria-expanded={expanded}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`inline-block w-3 text-xs transition-transform ${
                        canExpand ? 'text-gray-500' : 'text-transparent'
                      } ${expanded ? 'rotate-90' : ''}`}>
                        &gt;
                      </span>
                      <span className="min-w-0 flex-1 text-sm font-medium truncate">{group.name}</span>
                      {canExpand && (
                        <span className="shrink-0 rounded border border-gray-700 px-1.5 py-0.5 text-[11px] text-gray-400">
                          {uploadedModules.length}
                        </span>
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => goRegisterModule(group.name)}
                    className="mr-1 w-7 h-7 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-white"
                    aria-label={`${group.name} module 등록`}
                    title="module 등록"
                  >
                    +
                  </button>
                </div>
                {expanded && canExpand && (
                  <div className="border-t border-gray-800 bg-gray-950/70 py-1">
                    {uploadedModules.map((module) => (
                      <button
                        key={module.id}
                        type="button"
                        disabled={!module.url}
                        onClick={() => {
                          if (!module.url) return;
                          setSelectedModuleId(module.id);
                          if (!hasBasemap) setPrimaryUrl(module.url);
                        }}
                        className={`w-full px-6 py-2 text-left transition ${
                          module.url
                            ? selectedModuleId === module.id
                              ? 'bg-blue-500/10 text-blue-100'
                              : 'text-gray-300 hover:bg-gray-800/60'
                            : 'text-gray-600 cursor-not-allowed'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate text-xs font-medium">
                            {moduleUploaderLabel(module)}
                          </span>
                          <span className="shrink-0 text-[11px] text-gray-500">
                            {formatModuleVersion(module.version)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {moduleGroups.length === 0 && <p className="text-sm text-gray-500">No modules available.</p>}
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
