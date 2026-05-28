'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Building, Floor, Module } from '@/types';
import { floorLabelKo as formatFloor } from '@/lib/format/floor';

interface FloorWithModules extends Floor {
  modules: Module[];
}

interface BuildingWithFloors extends Building {
  floors: FloorWithModules[];
}

interface KakaoPlace {
  id: string;
  place_name: string;
  address_name: string;
  road_address_name: string;
  x: string;
  y: string;
}

type DeleteTarget =
  | { scope: 'building'; id: string; label: string; noun: '건물' }
  | { scope: 'floor'; id: string; label: string; noun: '층' }
  | { scope: 'module'; id: string; label: string; noun: '모듈' };

export default function VisibilityManager() {
  const [buildings, setBuildings] = useState<BuildingWithFloors[]>([]);
  const [openBuildings, setOpenBuildings] = useState<Set<string>>(new Set());
  const [openFloors, setOpenFloors] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  // 건물 추가 모달
  const [addBuildingOpen, setAddBuildingOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<KakaoPlace[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [addBuildingBusy, setAddBuildingBusy] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);

  // 인라인 층 추가 — buildingId → 입력 중인 floor_number 문자열
  const [floorAddTarget, setFloorAddTarget] = useState<string | null>(null);
  const [floorAddValue, setFloorAddValue] = useState('');

  // 인라인 모듈 추가 — floorId → 입력 중인 module_input 문자열
  const [moduleAddTarget, setModuleAddTarget] = useState<string | null>(null);
  const [moduleAddValue, setModuleAddValue] = useState('');

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

  useEffect(() => {
    if (!addBuildingOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const t = setTimeout(async () => {
      searchAbortRef.current?.abort();
      const ctl = new AbortController();
      searchAbortRef.current = ctl;
      try {
        const data = await api.get<{ documents: KakaoPlace[] }>(
          `/kakao/search/keyword?query=${encodeURIComponent(query)}&size=10`,
        );
        if (!ctl.signal.aborted) setSearchResults(data.documents || []);
      } catch {
        if (!ctl.signal.aborted) setSearchResults([]);
      } finally {
        if (!ctl.signal.aborted) setSearchLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [addBuildingOpen, searchQuery]);

  const openAddBuilding = () => {
    setSearchQuery('');
    setSearchResults([]);
    setAddBuildingOpen(true);
  };

  const closeAddBuilding = () => {
    if (addBuildingBusy) return;
    setAddBuildingOpen(false);
    setSearchQuery('');
    setSearchResults([]);
  };

  const addBuildingFromKakao = async (place: KakaoPlace) => {
    setAddBuildingBusy(true);
    try {
      const created = await api.post<Building>('/buildings/from-kakao', {
        place_id: place.id,
        name: place.place_name,
        address_name: place.address_name || null,
        road_address_name: place.road_address_name || null,
        latitude: place.y ? Number(place.y) : null,
        longitude: place.x ? Number(place.x) : null,
      });
      try {
        await api.put(`/admin/buildings/${created.id}/confirm`);
      } catch {
        // 확정 실패해도 건물 자체는 등록됨 — 사용자가 별도 '확정' 버튼으로 처리 가능.
      }
      setAddBuildingOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      showMessage(`건물 추가 완료: ${created.name}`, 'ok');
      await loadAll();
    } catch (e: any) {
      showMessage(e.message || '건물 추가 실패', 'err');
    } finally {
      setAddBuildingBusy(false);
    }
  };

  const beginAddFloor = (buildingId: string) => {
    setFloorAddTarget(buildingId);
    setFloorAddValue('');
  };

  const cancelAddFloor = () => {
    setFloorAddTarget(null);
    setFloorAddValue('');
  };

  const submitAddFloor = async (buildingId: string) => {
    const parsed = Number.parseInt(floorAddValue, 10);
    if (!Number.isFinite(parsed) || parsed === 0) {
      showMessage('층수는 0이 아닌 정수여야 합니다.', 'err');
      return;
    }
    const key = `addFloor:${buildingId}`;
    setBusyKey(key);
    try {
      const floor = await api.post<Floor>(`/buildings/${buildingId}/floors`, {
        floor_number: parsed,
      });
      try {
        await api.put(`/admin/floors/${floor.id}/confirm`);
      } catch {
        // 확정 실패해도 층 자체는 추가됨.
      }
      cancelAddFloor();
      showMessage(`${formatFloor(parsed)} 추가 완료`, 'ok');
      setOpenBuildings((prev) => {
        const next = new Set(prev);
        next.add(buildingId);
        return next;
      });
      await loadAll();
    } catch (e: any) {
      showMessage(e.message || '층 추가 실패', 'err');
    } finally {
      setBusyKey(null);
    }
  };

  const beginAddModule = (floorId: string) => {
    setModuleAddTarget(floorId);
    setModuleAddValue('');
  };

  const cancelAddModule = () => {
    setModuleAddTarget(null);
    setModuleAddValue('');
  };

  const submitAddModule = async (floorId: string) => {
    const moduleInput = moduleAddValue.trim();
    if (!moduleInput) {
      showMessage('모듈명을 입력하세요.', 'err');
      return;
    }
    const key = `addModule:${floorId}`;
    setBusyKey(key);
    try {
      await api.post<Module[]>(`/admin/floors/${floorId}/modules`, {
        module_input: moduleInput,
      });
      cancelAddModule();
      showMessage('모듈 추가 완료', 'ok');
      setOpenFloors((prev) => {
        const next = new Set(prev);
        next.add(floorId);
        return next;
      });
      await loadAll();
    } catch (e: any) {
      showMessage(e.message || '모듈 추가 실패', 'err');
    } finally {
      setBusyKey(null);
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
        visible ? 'bg-green-600/20 text-green-400' : 'bg-[var(--bg-soft)] text-[var(--muted)]'
      }`}
    >
      {visible ? '표시' : '숨김'}
    </span>
  );

  const toggleBtn = (visible: boolean, busy: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      disabled={busy}
      className={`text-xs px-3 py-1 rounded text-[var(--ink)] disabled:bg-[var(--bg-soft)] shrink-0 ${
        visible ? 'bg-[var(--paper)] hover:bg-sky-400/10 border border-[var(--rule)]' : 'bg-[var(--accent)] hover:brightness-110 text-[#04131f]'
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
      className="ml-1 w-6 h-6 flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] hover:bg-red-600 rounded disabled:opacity-50 shrink-0"
      aria-label={`${target.label} 삭제`}
      title={`${target.label} 삭제`}
    >
      ×
    </button>
  );

  return (
    <section className="bg-[var(--paper)] border border-[var(--rule)] rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">건물 / 층 / 모듈 표시 관리</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={openAddBuilding}
            className="text-xs px-3 py-1 rounded bg-[var(--accent)] hover:brightness-110 text-[#04131f]"
          >
            + 건물 추가
          </button>
          <button
            onClick={loadAll}
            className="text-xs text-[var(--muted)] hover:text-[var(--ink)]"
            disabled={loading}
          >
            새로고침
          </button>
        </div>
      </div>
      <p className="text-xs text-[var(--muted)] mb-4">
        숨기기/표시는 하위 항목으로 자동 전파되며, 하위 항목을 표시하면 상위도 함께 표시됩니다.
      </p>

      {message && (
        <p className={`text-sm mb-4 ${message.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
          {message.text}
        </p>
      )}

      {loading ? (
        <p className="text-[var(--muted)] text-sm">불러오는 중...</p>
      ) : buildings.length === 0 ? (
        <p className="text-[var(--muted)] text-sm">등록된 건물이 없습니다.</p>
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
                className={`bg-[var(--bg)] border rounded-lg ${
                  b.is_visible ? 'border-[var(--rule)]' : 'border-[var(--rule)] opacity-70'
                }`}
              >
                <div className="flex items-center justify-between px-3 py-2.5 gap-3">
                  <button
                    onClick={() => toggleBuildingOpen(b.id)}
                    className="flex-1 flex items-center gap-2 text-left text-sm text-[var(--ink)] hover:text-[var(--ink)] min-w-0"
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
                    <span className="text-xs text-[var(--muted)] ml-1 shrink-0">
                      {b.floors.length}개 층 · {moduleCount}개 모듈
                    </span>
                  </button>
                  <div className="flex items-center gap-2">
                    {toggleBtn(b.is_visible, buildingBusy, () => toggleBuildingVisibility(b))}
                    {deleteBtn({ scope: 'building', id: b.id, label: b.name, noun: '건물' })}
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-[var(--rule)] p-2 space-y-1">
                    <div className="flex items-center justify-end px-1 pb-1">
                      {floorAddTarget === b.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            value={floorAddValue}
                            onChange={(e) => setFloorAddValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') submitAddFloor(b.id);
                              if (e.key === 'Escape') cancelAddFloor();
                            }}
                            placeholder="예: 1, -1"
                            className="w-24 bg-[var(--paper)] border border-[var(--rule)] rounded px-2 py-1 text-xs text-[var(--ink)]"
                            autoFocus
                          />
                          <button
                            onClick={() => submitAddFloor(b.id)}
                            disabled={busyKey === `addFloor:${b.id}`}
                            className="text-xs px-2 py-1 rounded bg-[var(--accent)] hover:brightness-110 text-[#04131f] disabled:bg-[var(--bg-soft)]"
                          >
                            {busyKey === `addFloor:${b.id}` ? '...' : '추가'}
                          </button>
                          <button
                            onClick={cancelAddFloor}
                            className="text-xs px-2 py-1 rounded bg-[var(--paper)] hover:bg-sky-400/10 border border-[var(--rule)] text-[var(--ink)]"
                          >
                            취소
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => beginAddFloor(b.id)}
                          className="text-xs px-2 py-1 rounded bg-[var(--bg-soft)] hover:bg-[var(--bg-soft)] text-[var(--ink-2)] border border-[var(--rule)]"
                        >
                          + 층 추가
                        </button>
                      )}
                    </div>
                    {sortedFloors.length === 0 ? (
                      <p className="text-xs text-[var(--muted-2)] px-2 py-1">층이 없습니다.</p>
                    ) : (
                      sortedFloors.map((f) => {
                        const floorBusy = busyKey === `floor:${f.id}`;
                        const floorOpen = openFloors.has(f.id);
                        return (
                          <div
                            key={f.id}
                            className={`border rounded ${
                              f.is_visible ? 'border-[var(--rule)]' : 'border-[var(--rule)] opacity-70'
                            }`}
                          >
                            <div className="flex items-center justify-between px-3 py-1.5 gap-3">
                              <button
                                onClick={() => toggleFloorOpen(f.id)}
                                className="flex-1 flex items-center gap-2 text-left text-sm text-[var(--ink-2)] hover:text-[var(--ink)] min-w-0"
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
                                <span className="text-xs text-[var(--muted)] ml-1 shrink-0">
                                  {f.modules.length}개 모듈
                                </span>
                              </button>
                              <div className="flex items-center gap-2">
                                {toggleBtn(f.is_visible, floorBusy, () => toggleFloorVisibility(b, f))}
                                {deleteBtn({ scope: 'floor', id: f.id, label: `${b.name} ${formatFloor(f.floor_number)}`, noun: '층' })}
                              </div>
                            </div>

                            {floorOpen && (
                              <div className="px-3 pb-2 space-y-1">
                                <div className="flex items-center justify-end pb-1">
                                  {moduleAddTarget === f.id ? (
                                    <div className="flex items-center gap-2">
                                      <input
                                        type="text"
                                        value={moduleAddValue}
                                        onChange={(e) => setModuleAddValue(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') submitAddModule(f.id);
                                          if (e.key === 'Escape') cancelAddModule();
                                        }}
                                        placeholder="모듈명 또는 1~10"
                                        className="w-40 bg-[var(--paper)] border border-[var(--rule)] rounded px-2 py-1 text-xs text-[var(--ink)]"
                                        autoFocus
                                      />
                                      <button
                                        onClick={() => submitAddModule(f.id)}
                                        disabled={busyKey === `addModule:${f.id}`}
                                        className="text-xs px-2 py-1 rounded bg-[var(--accent)] hover:brightness-110 text-[#04131f] disabled:bg-[var(--bg-soft)]"
                                      >
                                        {busyKey === `addModule:${f.id}` ? '...' : '추가'}
                                      </button>
                                      <button
                                        onClick={cancelAddModule}
                                        className="text-xs px-2 py-1 rounded bg-[var(--paper)] hover:bg-sky-400/10 border border-[var(--rule)] text-[var(--ink)]"
                                      >
                                        취소
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => beginAddModule(f.id)}
                                      className="text-xs px-2 py-1 rounded bg-[var(--bg-soft)] hover:bg-[var(--bg-soft)] text-[var(--ink-2)] border border-[var(--rule)]"
                                    >
                                      + 모듈 추가
                                    </button>
                                  )}
                                </div>
                                {f.modules.length === 0 ? (
                                  <p className="text-xs text-[var(--muted-2)]">모듈이 없습니다.</p>
                                ) : (
                                  f.modules.map((m) => {
                                    const modBusy = busyKey === `mod:${m.id}`;
                                    return (
                                      <div
                                        key={m.id}
                                        className={`flex items-center justify-between bg-[var(--paper)] border rounded px-3 py-1.5 ${
                                          m.is_visible ? 'border-[var(--rule)]' : 'border-[var(--rule)] opacity-70'
                                        }`}
                                      >
                                        <div className="flex items-center gap-2 text-sm min-w-0">
                                          <span className="text-[var(--ink-2)] truncate">{m.name}</span>
                                          {visBadge(m.is_visible)}
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {toggleBtn(m.is_visible, modBusy, () => toggleModuleVisibility(m))}
                                          {deleteBtn({ scope: 'module', id: m.id, label: m.name, noun: '모듈' })}
                                        </div>
                                      </div>
                                    );
                                  })
                                )}
                              </div>
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
      {addBuildingOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-lg rounded-lg border border-[var(--rule)] bg-[var(--paper)] p-5 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold text-[var(--ink)]">건물 추가 — 카카오 검색</h3>
              <button
                type="button"
                onClick={closeAddBuilding}
                disabled={addBuildingBusy}
                className="text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-50"
              >
                ✕
              </button>
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="건물 이름 / 주소 검색..."
              autoFocus
              disabled={addBuildingBusy}
              className="w-full bg-[var(--bg-soft)] border border-[var(--rule)] rounded px-3 py-2 text-[var(--ink)] text-sm focus:outline-none focus:border-sky-400 disabled:opacity-50"
            />
            <div className="mt-3 max-h-80 overflow-y-auto border border-[var(--rule)] rounded">
              {searchLoading && (
                <div className="px-3 py-3 text-sm text-[var(--muted)]">검색 중...</div>
              )}
              {!searchLoading && searchQuery.trim() && searchResults.length === 0 && (
                <div className="px-3 py-3 text-sm text-[var(--muted)]">검색 결과가 없습니다.</div>
              )}
              {!searchLoading && !searchQuery.trim() && (
                <div className="px-3 py-3 text-sm text-[var(--muted)]">검색어를 입력하세요.</div>
              )}
              {searchResults.map((place) => (
                <button
                  key={place.id}
                  type="button"
                  onClick={() => addBuildingFromKakao(place)}
                  disabled={addBuildingBusy}
                  className="w-full text-left px-3 py-2 hover:bg-sky-400/10 transition-colors border-t border-[var(--rule)] first:border-t-0 disabled:opacity-50"
                >
                  <div className="text-[var(--ink)] text-sm font-medium truncate">{place.place_name}</div>
                  <div className="text-[var(--muted)] text-xs mt-0.5 truncate">
                    {place.road_address_name || place.address_name || '주소 정보 없음'}
                  </div>
                </button>
              ))}
            </div>
            {addBuildingBusy && (
              <p className="mt-3 text-xs text-[var(--muted)]">등록 중...</p>
            )}
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-lg border border-[var(--rule)] bg-[var(--paper)] p-5 shadow-xl">
            <h3 className="text-base font-semibold text-[var(--ink)]">삭제 확인</h3>
            <p className="mt-3 text-sm text-red-300">
              {deleteWarningText(deleteTarget)}
            </p>
            <p className="mt-2 text-sm text-[var(--ink-2)] truncate">
              대상: {deleteTarget.label}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleDelete}
                disabled={busyKey === `delete:${deleteTarget.scope}:${deleteTarget.id}`}
                className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-[var(--ink)] hover:bg-red-700 disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)]"
              >
                {busyKey === `delete:${deleteTarget.scope}:${deleteTarget.id}` ? '삭제 중...' : '삭제'}
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={busyKey === `delete:${deleteTarget.scope}:${deleteTarget.id}`}
                className="rounded bg-[var(--paper)] border border-[var(--rule)] px-4 py-2 text-sm text-[var(--ink)] hover:bg-sky-400/10 disabled:opacity-50"
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
