'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { FloorDetailManifest, FloorDetailModuleEntry } from '@/types';
import SplatViewerCore, { type SplatViewerCoreRef } from '@/components/viewer/SplatViewerCore';
import { useAdditionalGsplats } from '@/components/viewer/tools/useAdditionalGsplats';
import { useRefinedMeshLoader } from '@/components/viewer/tools/useRefinedMeshLoader';

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
  basemapSourceUploadId,
  moduleOverlays,
}: {
  primaryUrl: string;
  basemapSourceUploadId: string | null;
  moduleOverlays: FloorDetailModuleEntry[];
}) {
  const coreRef = useRef<SplatViewerCoreRef>(null);
  const additional = useAdditionalGsplats(coreRef);
  const { add, getEntity, remove, setTransform } = additional;
  const layerIdsRef = useRef<Map<string, string>>(new Map());

  // 베이스맵의 wall mesh + 텍스처(천장/바닥/벽) + 도어 splat 까지 같이 로드.
  // 4번째 인자 (additional) 가 있어야 도어 splat 도 씬에 add 됨.
  useRefinedMeshLoader(coreRef, basemapSourceUploadId ?? undefined, !!basemapSourceUploadId, additional);

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

const ROOM_PICKER_ITEM_HEIGHT = 44;
const ROOM_PICKER_VISIBLE_PADDING = ROOM_PICKER_ITEM_HEIGHT * 2;

function RoomWheelPicker({
  floorNumber,
  value,
  onChange,
}: {
  floorNumber: number;
  value: number;
  onChange: (next: number) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const settleTimerRef = useRef<number | null>(null);
  const items = Array.from({ length: 99 }, (_, i) => i + 1);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = (value - 1) * ROOM_PICKER_ITEM_HEIGHT;
    }
  }, []);

  const handleScroll = () => {
    if (!listRef.current) return;
    if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      if (!listRef.current) return;
      const idx = Math.round(listRef.current.scrollTop / ROOM_PICKER_ITEM_HEIGHT);
      const next = Math.max(1, Math.min(99, idx + 1));
      if (next !== value) onChange(next);
    }, 60);
  };

  return (
    <div className="relative h-[220px] w-40 mx-auto select-none">
      <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-[44px] rounded-md border-y border-blue-500/60 bg-blue-500/10" />
      <ul
        ref={listRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
        style={{
          scrollSnapType: 'y mandatory',
          scrollbarWidth: 'none',
          paddingTop: ROOM_PICKER_VISIBLE_PADDING,
          paddingBottom: ROOM_PICKER_VISIBLE_PADDING,
        }}
      >
        {items.map((suffix) => {
          const display = `${floorNumber}${String(suffix).padStart(2, '0')}호`;
          const active = value === suffix;
          return (
            <li
              key={suffix}
              style={{ height: ROOM_PICKER_ITEM_HEIGHT, scrollSnapAlign: 'center' }}
              className={`flex items-center justify-center text-lg transition ${
                active ? 'text-white font-bold' : 'text-gray-500'
              }`}
              onClick={() => {
                listRef.current?.scrollTo({
                  top: (suffix - 1) * ROOM_PICKER_ITEM_HEIGHT,
                  behavior: 'smooth',
                });
              }}
            >
              {display}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function roomNumberLabel(floorNumber: number, suffix: number) {
  return `${floorNumber}${String(suffix).padStart(2, '0')}호`;
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

  const [manifest, setManifest] = useState<FloorDetailManifest | null>(null);
  const [primaryUrl, setPrimaryUrl] = useState<string | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [showAddModuleModal, setShowAddModuleModal] = useState(false);
  const [pickerRoomSuffix, setPickerRoomSuffix] = useState(1);
  const [creatingModule, setCreatingModule] = useState(false);
  const [addModuleError, setAddModuleError] = useState<string | null>(null);
  const [expandedModuleNames, setExpandedModuleNames] = useState<Set<string>>(() => new Set());

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
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

  useEffect(() => {
    reloadManifest();
  }, [buildingId, floorNumber]);

  const moduleRows = useMemo(() => manifest?.modules ?? [], [manifest]);
  // 모듈을 호수별로 그룹화 + 호수명 자연 정렬 (101 < 102 < 1001).
  // 각 호수 안 모듈은 등록 시점 오름차순 (가장 오래된 위) — moduleVersionTime 헬퍼 기반.
  const moduleGroups = useMemo(() => {
    const grouped = new Map<string, FloorDetailModuleEntry[]>();
    moduleRows.forEach((module) => {
      const modules = grouped.get(module.name) ?? [];
      modules.push(module);
      grouped.set(module.name, modules);
    });
    return Array.from(grouped.entries())
      .map(([name, modules]) => [name, [...modules].sort(compareModuleVersionAsc)] as [string, FloorDetailModuleEntry[]])
      .sort(([a], [b]) => moduleNameCollator.compare(a, b));
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

        <div className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-gray-400 shrink-0">
          Modules ({moduleGroups.length})
        </div>
        <div className="mt-3 space-y-2 overflow-y-auto flex-1 min-h-0 pr-1">
          {moduleGroups.map(([roomName, mods]) => {
            const expanded = expandedModuleNames.has(roomName);
            const anySelected = mods.some((m) => m.id === selectedModuleId);
            const activeCount = mods.filter((m) => m.url).length;
            const totalCount = mods.length;
            return (
              <div key={roomName} className="rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => {
                    setExpandedModuleNames((prev) => {
                      const next = new Set(prev);
                      if (next.has(roomName)) next.delete(roomName);
                      else next.add(roomName);
                      return next;
                    });
                  }}
                  className={`w-full px-4 py-3 text-left transition shadow-sm border-2 ${
                    expanded ? 'rounded-t-lg' : 'rounded-lg'
                  } ${
                    anySelected
                      ? 'border-blue-400 bg-blue-500/15 text-white'
                      : 'border-gray-700 bg-gray-800/80 text-gray-100 hover:border-blue-400 hover:bg-gray-800'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-base font-semibold truncate">{roomName}</div>
                      <div className="text-[11px] text-gray-400 mt-0.5">
                        {totalCount}개 등록 {activeCount < totalCount ? `· ${activeCount}개 활성` : ''}
                      </div>
                    </div>
                    <svg
                      className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${
                        expanded ? 'rotate-90' : ''
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </button>
                {expanded && (
                  <div className="border-2 border-t-0 border-gray-700 rounded-b-lg bg-gray-900/60 divide-y divide-gray-800/80">
                    {mods.map((module) => {
                      const isSelected = selectedModuleId === module.id;
                      const disabled = !module.url;
                      const label = module.uploader_name?.trim() || `user ${module.user_id.slice(0, 6)}`;
                      return (
                        <div
                          key={module.id}
                          className={`group flex items-stretch transition ${
                            disabled
                              ? 'text-gray-600'
                              : isSelected
                                ? 'bg-blue-500/15 text-white'
                                : 'text-gray-200 hover:bg-gray-800/70'
                          }`}
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
                              disabled ? 'cursor-not-allowed' : ''
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-gray-500 text-xs">└</span>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium truncate">{label}</div>
                                {disabled ? (
                                  <div className="text-[11px] text-gray-500 mt-0.5">Scene 없음</div>
                                ) : module.version ? (
                                  <div className="text-[11px] text-gray-500 mt-0.5">{formatRegisteredAt(module.version) ?? module.version}</div>
                                ) : null}
                              </div>
                              {isSelected && (
                                <svg className="w-4 h-4 text-blue-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                                window.alert(`모듈 삭제 실패: ${err?.message ?? err}`);
                              }
                            }}
                            className="px-3 flex items-center text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition opacity-60 group-hover:opacity-100"
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
            <p className="text-sm text-gray-500 px-1">등록된 모듈이 없습니다.</p>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            setAddModuleError(null);
            setPickerRoomSuffix(1);
            setShowAddModuleModal(true);
          }}
          disabled={!manifest?.floor_id}
          className="mt-4 shrink-0 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/30 hover:shadow-blue-500/50 transition active:scale-[0.98]"
          aria-label="모듈 추가"
        >
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/20 text-lg leading-none font-bold">
            +
          </span>
          <span>모듈 추가</span>
        </button>
      </aside>

      {showAddModuleModal && manifest && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => {
            if (!creatingModule) setShowAddModuleModal(false);
          }}
        >
          <div
            className="w-[320px] rounded-xl bg-gray-900 border border-gray-800 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-white text-center">호수를 선택하세요</h2>
            <p className="text-xs text-gray-500 text-center mt-1">Floor {manifest.floor_number}</p>

            <div className="mt-4">
              <RoomWheelPicker
                floorNumber={manifest.floor_number}
                value={pickerRoomSuffix}
                onChange={(next) => {
                  setPickerRoomSuffix(next);
                  setAddModuleError(null);
                }}
              />
            </div>

            {addModuleError && (
              <p className="mt-3 text-xs text-red-400 text-center">{addModuleError}</p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                disabled={creatingModule}
                onClick={() => setShowAddModuleModal(false)}
                className="flex-1 rounded-md border border-gray-700 hover:bg-gray-800 disabled:opacity-50 py-2 text-sm text-gray-300"
              >
                취소
              </button>
              <button
                type="button"
                disabled={creatingModule}
                onClick={async () => {
                  if (!manifest?.floor_id || !manifest?.building_id) return;
                  const name = roomNumberLabel(manifest.floor_number, pickerRoomSuffix);
                  setCreatingModule(true);
                  setAddModuleError(null);
                  try {
                    // 사전 확인: 같은 사용자가 같은 호수에 이미 등록한 모듈이 있는지 체크.
                    // 있으면 사용자에게 덮어쓰기 의사 확인. 정합 완료 시 commit-final 이 기존 자산을 삭제하고 교체.
                    const existing = await api.get<Array<{ id: string; name: string }>>(
                      `/floors/${manifest.floor_id}/modules`,
                    );
                    const alreadyExists = existing.some((m) => m.name === name);
                    if (alreadyExists) {
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
                className="flex-1 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-60 py-2 text-sm font-semibold text-white"
              >
                {creatingModule ? '확인 중...' : `${roomNumberLabel(manifest.floor_number, pickerRoomSuffix)} 등록`}
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
          <div className="h-full flex items-center justify-center px-6">
            <div className="max-w-md text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-yellow-500/10 border border-yellow-500/40 mb-4">
                <svg className="w-7 h-7 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="text-base font-semibold text-yellow-300 mb-1">관리자 승인 대기중</div>
              <p className="text-sm text-gray-400 leading-relaxed">
                이 층의 basemap 이 등록되었지만 아직 관리자 승인 전입니다.<br />
                승인 완료 후 자동으로 표시됩니다.
              </p>
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center px-6">
            <div className="max-w-md text-center">
              <div className="text-base font-semibold text-gray-300 mb-1">등록된 basemap 이 없습니다</div>
              <p className="text-sm text-gray-500 mb-5">
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
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold shadow-lg transition cursor-pointer"
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
