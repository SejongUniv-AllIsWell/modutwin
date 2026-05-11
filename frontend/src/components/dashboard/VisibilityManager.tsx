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

type DeleteTarget =
  | { scope: 'building'; id: string; label: string; noun: '건물' }
  | { scope: 'floor'; id: string; label: string; noun: '층' }
  | { scope: 'module'; id: string; label: string; noun: '모듈' };

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
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

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

  // 백엔드의 양방향 cascade 와 동일하게 로컬 state 도 갱신:
  //   hide → 자식 모두 hide
  //   show → 자식 모두 show + 조상 모두 show

  const toggleBuildingVisibility = async (b: BuildingWithFloors) => {
    const key = `building:${b.id}`;
    setBusyKey(key);
    const next = !b.is_visible;
    try {
      await api.put<Building>(`/admin/buildings/${b.id}/visibility`, {
        is_visible: next,
      });
      setBuildings((prev) =>
        prev.map((x) => {
          if (x.id !== b.id) return x;
          return {
            ...x,
            is_visible: next,
            floors: x.floors.map((f) => ({
              ...f,
              is_visible: next,
              modules: f.modules.map((m) => ({ ...m, is_visible: next })),
            })),
          };
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
      await api.put<Floor>(`/admin/floors/${f.id}/visibility`, {
        is_visible: next,
      });
      setBuildings((prev) =>
        prev.map((x) => {
          if (x.id !== b.id) return x;
          const nextBuilding = next ? { ...x, is_visible: true } : x;
          return {
            ...nextBuilding,
            floors: nextBuilding.floors.map((fl) => {
              if (fl.id !== f.id) return fl;
              return {
                ...fl,
                is_visible: next,
                modules: fl.modules.map((m) => ({ ...m, is_visible: next })),
              };
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
    const next = !mod.is_visible;
    try {
      await api.put<Module>(`/admin/modules/${mod.id}/visibility`, {
        is_visible: next,
      });
      setBuildings((prev) =>
        prev.map((b) => {
          const owns = b.floors.some((f) => f.modules.some((m) => m.id === mod.id));
          if (!owns) return b;
          const nextBuilding = next ? { ...b, is_visible: true } : b;
          return {
            ...nextBuilding,
            floors: nextBuilding.floors.map((f) => {
              if (!f.modules.some((m) => m.id === mod.id)) return f;
              const nextFloor = next ? { ...f, is_visible: true } : f;
              return {
                ...nextFloor,
                modules: nextFloor.modules.map((m) =>
                  m.id === mod.id ? { ...m, is_visible: next } : m,
                ),
              };
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

  const confirmBuilding = async (buildingId: string) => {
    const key = `confirm:building:${buildingId}`;
    setBusyKey(key);
    try {
      await api.put(`/admin/buildings/${buildingId}/confirm`);
      showMessage('건물 확정 완료', 'ok');
      await loadAll();
    } catch (e: any) {
      showMessage(e.message || '건물 확정 실패', 'err');
    } finally {
      setBusyKey(null);
    }
  };

  const confirmFloor = async (floorId: string) => {
    const key = `confirm:floor:${floorId}`;
    setBusyKey(key);
    try {
      await api.put(`/admin/floors/${floorId}/confirm`);
      showMessage('층 확정 완료', 'ok');
      await loadAll();
    } catch (e: any) {
      showMessage(e.message || '층 확정 실패', 'err');
    } finally {
      setBusyKey(null);
    }
  };

  const confirmModule = async (moduleId: string) => {
    const key = `confirm:mod:${moduleId}`;
    setBusyKey(key);
    try {
      await api.put(`/admin/modules/${moduleId}/confirm`);
      showMessage('모듈 확정 완료', 'ok');
      await loadAll();
    } catch (e: any) {
      showMessage(e.message || '모듈 확정 실패', 'err');
    } finally {
      setBusyKey(null);
    }
  };

  const deleteEndpoint = (target: DeleteTarget) => {
    if (target.scope === 'building') return `/admin/buildings/${target.id}`;
    if (target.scope === 'floor') return `/admin/floors/${target.id}`;
    return `/admin/modules/${target.id}`;
  };

  const deleteWarningText = (target: DeleteTarget) => {
    if (target.scope === 'building') return '삭제 시 해당 건물의 모든 데이터가 삭제됩니다.';
    if (target.scope === 'floor') return '삭제 시 해당 층의 모든 데이터가 삭제됩니다.';
    return '삭제 시 해당 모듈의 모든 데이터가 삭제됩니다.';
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const key = `delete:${target.scope}:${target.id}`;
    setBusyKey(key);
    try {
      await api.delete(deleteEndpoint(target));
      setDeleteTarget(null);
      showMessage(`${target.noun} 삭제 완료`, 'ok');
      await loadAll();
    } catch (e: any) {
      showMessage(e.message || `${target.noun} 삭제 실패`, 'err');
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

  const deleteBtn = (target: DeleteTarget) => (
    <button
      type="button"
      onClick={() => setDeleteTarget(target)}
      disabled={busyKey === `delete:${target.scope}:${target.id}`}
      className="w-7 h-7 rounded border border-red-900/60 text-red-400 hover:bg-red-950/60 hover:text-red-200 disabled:opacity-50 shrink-0"
      aria-label={`${target.label} 삭제`}
      title={`${target.label} 삭제`}
    >
      X
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
        숨기기/표시는 하위 항목으로 자동 전파되며, 하위 항목을 표시하면 상위도 함께 표시됩니다.
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
            const buildingConfirmBusy = busyKey === `confirm:building:${b.id}`;
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
                  <div className="flex items-center gap-2">
                    {!b.is_confirmed && (
                      <button
                        onClick={() => confirmBuilding(b.id)}
                        disabled={buildingConfirmBusy}
                        className="text-xs px-3 py-1 rounded text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700"
                      >
                        {buildingConfirmBusy ? '...' : '확정'}
                      </button>
                    )}
                    {toggleBtn(b.is_visible, buildingBusy, () => toggleBuildingVisibility(b))}
                    {deleteBtn({ scope: 'building', id: b.id, label: b.name, noun: '건물' })}
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-gray-800 p-2 space-y-1">
                    {sortedFloors.length === 0 ? (
                      <p className="text-xs text-gray-600 px-2 py-1">층이 없습니다.</p>
                    ) : (
                      sortedFloors.map((f) => {
                        const floorBusy = busyKey === `floor:${f.id}`;
                        const floorConfirmBusy = busyKey === `confirm:floor:${f.id}`;
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
                              <div className="flex items-center gap-2">
                                {!f.is_confirmed && (
                                  <button
                                    onClick={() => confirmFloor(f.id)}
                                    disabled={floorConfirmBusy}
                                    className="text-xs px-3 py-1 rounded text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700"
                                  >
                                    {floorConfirmBusy ? '...' : '확정'}
                                  </button>
                                )}
                                {toggleBtn(f.is_visible, floorBusy, () => toggleFloorVisibility(b, f))}
                                {deleteBtn({ scope: 'floor', id: f.id, label: `${b.name} ${formatFloor(f.floor_number)}`, noun: '층' })}
                              </div>
                            </div>

                            {floorOpen && f.modules.length > 0 && (
                              <div className="px-3 pb-2 space-y-1">
                                {f.modules.map((m) => {
                                  const modBusy = busyKey === `mod:${m.id}`;
                                  const modConfirmBusy = busyKey === `confirm:mod:${m.id}`;
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
                                      <div className="flex items-center gap-2">
                                        {!m.is_confirmed && (
                                          <button
                                            onClick={() => confirmModule(m.id)}
                                            disabled={modConfirmBusy}
                                            className="text-xs px-3 py-1 rounded text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700"
                                          >
                                            {modConfirmBusy ? '...' : '확정'}
                                          </button>
                                        )}
                                        {toggleBtn(m.is_visible, modBusy, () => toggleModuleVisibility(m))}
                                        {deleteBtn({ scope: 'module', id: m.id, label: m.name, noun: '모듈' })}
                                      </div>
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
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-5 shadow-xl">
            <h3 className="text-base font-semibold text-white">삭제 확인</h3>
            <p className="mt-3 text-sm text-red-300">
              {deleteWarningText(deleteTarget)}
            </p>
            <p className="mt-2 text-sm text-gray-300 truncate">
              대상: {deleteTarget.label}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleDelete}
                disabled={busyKey === `delete:${deleteTarget.scope}:${deleteTarget.id}`}
                className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-gray-700 disabled:text-gray-400"
              >
                {busyKey === `delete:${deleteTarget.scope}:${deleteTarget.id}` ? '삭제 중...' : '삭제'}
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={busyKey === `delete:${deleteTarget.scope}:${deleteTarget.id}`}
                className="rounded bg-gray-700 px-4 py-2 text-sm text-gray-200 hover:bg-gray-600 disabled:opacity-50"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
