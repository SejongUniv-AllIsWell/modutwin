'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Building, Floor, Module } from '@/types';

interface FloorWithModules extends Floor {
  modules: Module[];
}

interface BuildingWithFloors extends Building {
  floors: FloorWithModules[];
}

function formatFloor(n: number): string {
  return n < 0 ? `B${-n}` : `${n}층`;
}

export default function VisibilityManager() {
  const [buildings, setBuildings] = useState<BuildingWithFloors[]>([]);
  const [openBuildings, setOpenBuildings] = useState<Set<string>>(new Set());
  const [openFloors, setOpenFloors] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  const showMessage = (text: string, kind: 'ok' | 'err') => {
    setMessage({ text, kind });
    setTimeout(() => setMessage(null), 3000);
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      const blds = await api.get<Building[]>('/buildings?include_hidden=true');
      const withFloors = await Promise.all(
        blds.map(async (b) => {
          const floors = await api.get<Floor[]>(
            `/buildings/${b.id}/floors?include_hidden=true`,
          );
          const floorsWithModules = await Promise.all(
            floors.map(async (f) => {
              const mods = await api.get<Module[]>(
                `/floors/${f.id}/modules?include_hidden=true`,
              );
              return { ...f, modules: mods };
            }),
          );
          return { ...b, floors: floorsWithModules };
        }),
      );
      setBuildings(withFloors);
    } catch (e: any) {
      showMessage(e.message || '로딩 실패', 'err');
    } finally {
      setLoading(false);
    }
  };

  const toggleBuildingOpen = (id: string) =>
    setOpenBuildings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleFloorOpen = (id: string) =>
    setOpenFloors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // hide 시 cascade 가 백엔드에서 이뤄지므로 가시 상태만 다시 가져오기보다는
  // 응답 본인 + 하위를 클라이언트에서도 동일하게 갱신.

  const toggleBuildingVisibility = async (b: BuildingWithFloors) => {
    const key = `building:${b.id}`;
    setBusyKey(key);
    const next = !b.is_visible;
    try {
      const updated = await api.put<Building>(
        `/admin/buildings/${b.id}/visibility`,
        { is_visible: next },
      );
      setBuildings((prev) =>
        prev.map((x) => {
          if (x.id !== b.id) return x;
          if (updated.is_visible === false) {
            return {
              ...x,
              is_visible: false,
              floors: x.floors.map((f) => ({
                ...f,
                is_visible: false,
                modules: f.modules.map((m) => ({ ...m, is_visible: false })),
              })),
            };
          }
          return { ...x, is_visible: true };
        }),
      );
    } catch (e: any) {
      showMessage(e.message || '변경 실패', 'err');
    } finally {
      setBusyKey(null);
    }
  };

  const toggleFloorVisibility = async (b: BuildingWithFloors, f: FloorWithModules) => {
    const key = `floor:${f.id}`;
    setBusyKey(key);
    const next = !f.is_visible;
    try {
      const updated = await api.put<Floor>(`/admin/floors/${f.id}/visibility`, {
        is_visible: next,
      });
      setBuildings((prev) =>
        prev.map((x) => {
          if (x.id !== b.id) return x;
          return {
            ...x,
            floors: x.floors.map((fl) => {
              if (fl.id !== f.id) return fl;
              if (updated.is_visible === false) {
                return {
                  ...fl,
                  is_visible: false,
                  modules: fl.modules.map((m) => ({ ...m, is_visible: false })),
                };
              }
              return { ...fl, is_visible: true };
            }),
          };
        }),
      );
    } catch (e: any) {
      showMessage(e.message || '변경 실패', 'err');
    } finally {
      setBusyKey(null);
    }
  };

  const toggleModuleVisibility = async (mod: Module) => {
    const key = `mod:${mod.id}`;
    setBusyKey(key);
    try {
      const updated = await api.put<Module>(`/admin/modules/${mod.id}/visibility`, {
        is_visible: !mod.is_visible,
      });
      setBuildings((prev) =>
        prev.map((b) => ({
          ...b,
          floors: b.floors.map((f) => ({
            ...f,
            modules: f.modules.map((m) =>
              m.id === mod.id ? { ...m, is_visible: updated.is_visible } : m,
            ),
          })),
        })),
      );
    } catch (e: any) {
      showMessage(e.message || '변경 실패', 'err');
    } finally {
      setBusyKey(null);
    }
  };

  const visBadge = (visible: boolean) => (
    <span
      className={`text-xs px-2 py-0.5 rounded ${
        visible ? 'bg-green-600/20 text-green-400' : 'bg-gray-800 text-gray-400'
      }`}
    >
      {visible ? '표시' : '숨김'}
    </span>
  );

  const toggleBtn = (visible: boolean, busy: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      disabled={busy}
      className={`text-xs px-3 py-1 rounded text-white disabled:bg-gray-700 shrink-0 ${
        visible ? 'bg-gray-700 hover:bg-gray-600' : 'bg-blue-600 hover:bg-blue-700'
      }`}
    >
      {busy ? '...' : visible ? '숨기기' : '표시'}
    </button>
  );

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">건물 / 층 / 모듈 표시 관리</h2>
        <button
          onClick={loadAll}
          className="text-xs text-gray-400 hover:text-white"
          disabled={loading}
        >
          새로고침
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        상위를 숨기면 하위 항목이 자동으로 숨김 처리됩니다. 표시는 본인만 적용되며, 모든 모듈을 숨기면
        해당 건물도 /explore 에서 사라집니다.
      </p>

      {message && (
        <p className={`text-sm mb-4 ${message.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
          {message.text}
        </p>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">불러오는 중...</p>
      ) : buildings.length === 0 ? (
        <p className="text-gray-500 text-sm">등록된 건물이 없습니다.</p>
      ) : (
        <div className="space-y-2">
          {buildings.map((b) => {
            const isOpen = openBuildings.has(b.id);
            const buildingBusy = busyKey === `building:${b.id}`;
            const sortedFloors = [...b.floors].sort((a, c) => c.floor_number - a.floor_number);
            const moduleCount = b.floors.reduce((s, f) => s + f.modules.length, 0);
            return (
              <div
                key={b.id}
                className={`bg-gray-950 border rounded-lg ${
                  b.is_visible ? 'border-gray-800' : 'border-gray-800 opacity-70'
                }`}
              >
                <div className="flex items-center justify-between px-3 py-2.5 gap-3">
                  <button
                    onClick={() => toggleBuildingOpen(b.id)}
                    className="flex-1 flex items-center gap-2 text-left text-sm text-gray-200 hover:text-white min-w-0"
                  >
                    <svg
                      className={`w-4 h-4 transition-transform shrink-0 ${
                        isOpen ? 'rotate-90' : ''
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="font-medium truncate">{b.name}</span>
                    {visBadge(b.is_visible)}
                    <span className="text-xs text-gray-500 ml-1 shrink-0">
                      {b.floors.length}개 층 · {moduleCount}개 모듈
                    </span>
                  </button>
                  {toggleBtn(b.is_visible, buildingBusy, () => toggleBuildingVisibility(b))}
                </div>

                {isOpen && (
                  <div className="border-t border-gray-800 p-2 space-y-1">
                    {sortedFloors.length === 0 ? (
                      <p className="text-xs text-gray-600 px-2 py-1">층이 없습니다.</p>
                    ) : (
                      sortedFloors.map((f) => {
                        const floorBusy = busyKey === `floor:${f.id}`;
                        const floorOpen = openFloors.has(f.id);
                        return (
                          <div
                            key={f.id}
                            className={`border rounded ${
                              f.is_visible ? 'border-gray-800' : 'border-gray-800 opacity-70'
                            }`}
                          >
                            <div className="flex items-center justify-between px-3 py-1.5 gap-3">
                              <button
                                onClick={() => toggleFloorOpen(f.id)}
                                className="flex-1 flex items-center gap-2 text-left text-sm text-gray-300 hover:text-white min-w-0"
                              >
                                <svg
                                  className={`w-3.5 h-3.5 transition-transform shrink-0 ${
                                    floorOpen ? 'rotate-90' : ''
                                  }`}
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                                <span className="font-medium">{formatFloor(f.floor_number)}</span>
                                {visBadge(f.is_visible)}
                                <span className="text-xs text-gray-500 ml-1 shrink-0">
                                  {f.modules.length}개 모듈
                                </span>
                              </button>
                              {toggleBtn(f.is_visible, floorBusy, () =>
                                toggleFloorVisibility(b, f),
                              )}
                            </div>

                            {floorOpen && f.modules.length > 0 && (
                              <div className="px-3 pb-2 space-y-1">
                                {f.modules.map((m) => {
                                  const modBusy = busyKey === `mod:${m.id}`;
                                  return (
                                    <div
                                      key={m.id}
                                      className={`flex items-center justify-between bg-gray-900 border rounded px-3 py-1.5 ${
                                        m.is_visible ? 'border-gray-800' : 'border-gray-800 opacity-70'
                                      }`}
                                    >
                                      <div className="flex items-center gap-2 text-sm min-w-0">
                                        <span className="text-gray-300 truncate">{m.name}</span>
                                        {visBadge(m.is_visible)}
                                      </div>
                                      {toggleBtn(m.is_visible, modBusy, () =>
                                        toggleModuleVisibility(m),
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {floorOpen && f.modules.length === 0 && (
                              <p className="text-xs text-gray-600 px-3 pb-2">모듈이 없습니다.</p>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
