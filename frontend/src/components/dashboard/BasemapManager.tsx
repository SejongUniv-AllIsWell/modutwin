'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Basemap {
  id: string;
  floor_id: string;
  floor_number: number;
  building_id: string;
  building_name: string;
  version: number;
  status: string;
  is_active: boolean;
  created_at: string;
}

interface BasemapMetadataModule {
  id: string;
  name: string;
}

interface BasemapMetadataFloor {
  id: string;
  building_id: string;
  floor_number: number;
  modules: BasemapMetadataModule[];
}

interface BasemapMetadata {
  basemap_id: string;
  building_id: string;
  building_name: string;
  floors: BasemapMetadataFloor[];
}

const STATUS_LABEL: Record<string, string> = {
  pending: '대기',
  approved: '승인됨',
  rejected: '거부됨',
  superseded: '교체됨',
};

const INT32_MAX = 2147483647;
const INT32_MIN = -INT32_MAX;

function formatFloor(n: number): string {
  return n < 0 ? `B${Math.abs(n)}` : `${n}층`;
}

function normalizeFloorInput(value: string): string {
  const parsed = parseFloorInput(value);
  if (parsed === null) return value.trim();
  return parsed < 0 ? `B${Math.abs(parsed)}` : String(parsed);
}

function parseFloorInput(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  const bMatch = v.toUpperCase().match(/^B(\d+)$/);
  const raw = bMatch ? `-${bMatch[1]}` : v.replace(/층$/, '');
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < INT32_MIN || n > INT32_MAX || n === 0) return null;
  return n;
}

function sortFloorsDesc<T extends { floor_number: number }>(floors: T[]): T[] {
  return [...floors].sort((a, b) => b.floor_number - a.floor_number);
}

export default function BasemapManager() {
  const [basemaps, setBasemaps] = useState<Basemap[]>([]);
  const [openBasemapId, setOpenBasemapId] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<BasemapMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [floorInput, setFloorInput] = useState('');
  const [moduleFloorId, setModuleFloorId] = useState('');
  const [moduleInput, setModuleInput] = useState('');
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    try {
      const bms = await api.get<Basemap[]>('/admin/basemaps');
      setBasemaps(bms);
    } catch (e: any) {
      showMessage(e.message || '로딩 실패', 'err');
    }
  };

  const showMessage = (text: string, kind: 'ok' | 'err') => {
    setMessage({ text, kind });
    setTimeout(() => setMessage(null), 4000);
  };

  const handleAction = async (id: string, action: 'approve' | 'reject' | 'activate') => {
    try {
      await api.put(`/admin/basemaps/${id}/${action}`);
      showMessage(`${action} 완료`, 'ok');
      loadAll();
    } catch (e: any) {
      showMessage(e.message || `${action} 실패`, 'err');
    }
  };

  const handleUnregister = async (id: string) => {
    if (!confirm('이 basemap 등록을 취소합니다. 원본 PLY는 다시 등록 가능 상태로 돌아갑니다.')) return;
    try {
      await api.delete(`/admin/basemaps/${id}`);
      showMessage('등록이 취소되었습니다.', 'ok');
      loadAll();
    } catch (e: any) {
      showMessage(e.message || '취소 실패', 'err');
    }
  };

  const loadMetadata = async (basemapId: string) => {
    setMetadataLoading(true);
    try {
      const data = await api.get<BasemapMetadata>(`/admin/basemaps/${basemapId}/metadata`);
      setMetadata(data);
      setModuleFloorId(prev => {
        if (prev && data.floors.some(f => f.id === prev)) return prev;
        return sortFloorsDesc(data.floors)[0]?.id ?? '';
      });
    } catch (e: any) {
      setMetadata(null);
      showMessage(e.message || 'Basemap 설정 로딩 실패', 'err');
    } finally {
      setMetadataLoading(false);
    }
  };

  const toggleMetadata = (basemapId: string) => {
    if (openBasemapId === basemapId) {
      setOpenBasemapId(null);
      setMetadata(null);
      return;
    }
    setOpenBasemapId(basemapId);
    setFloorInput('');
    setModuleInput('');
    loadMetadata(basemapId);
  };

  const handleAddFloor = async (basemapId: string) => {
    const floorNumber = parseFloorInput(floorInput);
    if (floorNumber === null) {
      showMessage('층은 -2147483647~2147483647 사이의 0이 아닌 정수로 입력하세요.', 'err');
      return;
    }
    setMetadataBusy(true);
    try {
      const data = await api.post<BasemapMetadata>(`/admin/basemaps/${basemapId}/metadata/floors`, {
        floor_number: floorNumber,
      });
      setMetadata(data);
      setModuleFloorId(data.floors.find(f => f.floor_number === floorNumber)?.id || sortFloorsDesc(data.floors)[0]?.id || '');
      setFloorInput('');
      showMessage(`${formatFloor(floorNumber)} 추가 완료`, 'ok');
    } catch (e: any) {
      showMessage(e.message || '층 추가 실패', 'err');
    } finally {
      setMetadataBusy(false);
    }
  };

  const handleAddModules = async (basemapId: string) => {
    if (!moduleFloorId || !moduleInput.trim()) {
      showMessage('층과 모듈을 입력하세요.', 'err');
      return;
    }
    setMetadataBusy(true);
    try {
      const data = await api.post<BasemapMetadata>(`/admin/basemaps/${basemapId}/metadata/modules`, {
        floor_id: moduleFloorId,
        module_input: moduleInput.trim(),
      });
      setMetadata(data);
      setModuleInput('');
      showMessage('모듈 추가 완료', 'ok');
    } catch (e: any) {
      showMessage(e.message || '모듈 추가 실패', 'err');
    } finally {
      setMetadataBusy(false);
    }
  };

  const handleDeleteFloor = async (basemapId: string, floor: BasemapMetadataFloor) => {
    if (!confirm(`${formatFloor(floor.floor_number)}과 해당 층의 모듈 목록을 삭제합니다.`)) return;
    setMetadataBusy(true);
    try {
      const data = await api.delete<BasemapMetadata>(`/admin/basemaps/${basemapId}/metadata/floors/${floor.id}`);
      setMetadata(data);
      setModuleFloorId(prev => {
        const sorted = sortFloorsDesc(data.floors);
        if (prev && data.floors.some(f => f.id === prev)) return prev;
        return sorted[0]?.id ?? '';
      });
      setModuleInput('');
      showMessage(`${formatFloor(floor.floor_number)} 삭제 완료`, 'ok');
    } catch (e: any) {
      showMessage(e.message || '층 삭제 실패', 'err');
    } finally {
      setMetadataBusy(false);
    }
  };

  const handleDeleteModule = async (basemapId: string, module: BasemapMetadataModule) => {
    setMetadataBusy(true);
    try {
      const data = await api.delete<BasemapMetadata>(`/admin/basemaps/${basemapId}/metadata/modules/${module.id}`);
      setMetadata(data);
      setModuleInput('');
      showMessage(`${module.name} 삭제 완료`, 'ok');
    } catch (e: any) {
      showMessage(e.message || '모듈 삭제 실패', 'err');
    } finally {
      setMetadataBusy(false);
    }
  };

  const floorLabel = (bm: Basemap): string => {
    return `${bm.building_name} / ${formatFloor(bm.floor_number)}`;
  };

  const sortedMetadataFloors = metadata ? sortFloorsDesc(metadata.floors) : [];
  const selectedMetadataFloor = sortedMetadataFloors.find(f => f.id === moduleFloorId) ?? null;

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-4">Basemap 관리</h2>

      {message && (
        <p className={`text-sm mb-4 ${message.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
          {message.text}
        </p>
      )}

      {/* 등록된 basemap 목록 */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">
          Basemap 신청/등록 목록 ({basemaps.length})
        </h3>
        {basemaps.length === 0 ? (
          <p className="text-gray-500 text-sm">등록된 basemap이 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {basemaps.map(bm => {
              const isOpen = openBasemapId === bm.id;
              return (
                <div key={bm.id} className="bg-gray-950 border border-gray-800 rounded-lg">
                  <div className="p-3 flex justify-between items-center gap-3">
                    <button
                      type="button"
                      onClick={() => toggleMetadata(bm.id)}
                      className="flex-1 flex items-center gap-3 text-sm min-w-0 text-left hover:text-white"
                    >
                      <svg
                        className={`w-4 h-4 text-gray-500 transition-transform shrink-0 ${isOpen ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="text-gray-300 truncate">{floorLabel(bm)}</span>
                      <span className="text-gray-500 shrink-0">v{bm.version}</span>
                      <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                        bm.is_active ? 'bg-green-600/20 text-green-400' : 'bg-gray-800 text-gray-400'
                      }`}>
                        {bm.is_active ? '활성' : STATUS_LABEL[bm.status] ?? bm.status}
                      </span>
                    </button>
                    <div className="flex gap-2 items-center shrink-0">
                      {bm.status === 'pending' && (
                        <>
                          <button onClick={() => handleAction(bm.id, 'approve')} className="text-xs bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded">승인</button>
                          <button onClick={() => handleAction(bm.id, 'reject')} className="text-xs bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded">거부</button>
                        </>
                      )}
                      {bm.status === 'approved' && !bm.is_active && (
                        <button onClick={() => handleAction(bm.id, 'activate')} className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded">활성화</button>
                      )}
                      <button
                        onClick={() => handleUnregister(bm.id)}
                        title="등록 취소"
                        aria-label="등록 취소"
                        className="ml-1 w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white hover:bg-red-600 rounded"
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="border-t border-gray-800 p-3 space-y-3">
                      {metadataLoading ? (
                        <p className="text-gray-500 text-sm">불러오는 중...</p>
                      ) : metadata ? (
                        <>
                          <div className="space-y-1">
                            <label className="block text-xs text-gray-400">층 추가</label>
                            <div className="flex gap-2 max-w-sm">
                              <input
                                value={floorInput}
                                onChange={e => setFloorInput(e.target.value)}
                                onBlur={e => setFloorInput(normalizeFloorInput(e.target.value))}
                                disabled={metadataBusy}
                                placeholder="-1, B1, 1"
                                className="min-w-0 flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40"
                              />
                              <button
                                onClick={() => handleAddFloor(bm.id)}
                                disabled={metadataBusy}
                                className="text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white px-3 py-1 rounded shrink-0"
                              >
                                추가
                              </button>
                            </div>
                          </div>

                          <div className="space-y-2 max-h-64 overflow-y-auto">
                            {sortedMetadataFloors.length === 0 ? (
                              <p className="text-xs text-gray-600">등록된 층이 없습니다.</p>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {sortedMetadataFloors.map(floor => {
                                  const selected = floor.id === moduleFloorId;
                                  return (
                                    <div
                                      key={floor.id}
                                      className={`flex items-center rounded border overflow-hidden ${
                                        selected
                                          ? 'bg-blue-600 border-blue-500 text-white'
                                          : 'bg-gray-900 border-gray-800 text-gray-300 hover:border-gray-600'
                                      }`}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => setModuleFloorId(floor.id)}
                                        disabled={metadataBusy}
                                        className="text-xs px-2.5 py-1 disabled:opacity-40"
                                      >
                                        {formatFloor(floor.floor_number)}
                                        <span className="ml-1 text-[10px] opacity-70">{floor.modules.length}</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteFloor(bm.id, floor)}
                                        disabled={metadataBusy}
                                        title={`${formatFloor(floor.floor_number)} 삭제`}
                                        aria-label={`${formatFloor(floor.floor_number)} 삭제`}
                                        className={`w-5 self-stretch text-xs disabled:opacity-40 ${
                                          selected
                                            ? 'text-blue-100 hover:bg-blue-700 hover:text-white'
                                            : 'text-gray-500 hover:bg-red-600 hover:text-white'
                                        }`}
                                      >
                                        ×
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>

                          {selectedMetadataFloor && (
                            <div className="border border-gray-800 rounded p-3 space-y-2">
                              <div className="text-xs text-gray-300">
                                {formatFloor(selectedMetadataFloor.floor_number)} · {selectedMetadataFloor.modules.length}개 모듈
                              </div>
                              <div className="flex gap-2">
                                <input
                                  value={moduleInput}
                                  onChange={e => setModuleInput(e.target.value)}
                                  disabled={metadataBusy}
                                  placeholder="모듈명 또는 1~10"
                                  className="min-w-0 flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40"
                                />
                                <button
                                  onClick={() => handleAddModules(bm.id)}
                                  disabled={metadataBusy}
                                  className="text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white px-3 py-1 rounded shrink-0"
                                >
                                  추가
                                </button>
                              </div>
                              {selectedMetadataFloor.modules.length === 0 ? (
                                <p className="text-xs text-gray-600">모듈이 없습니다.</p>
                              ) : (
                                <div className="flex flex-wrap gap-1">
                                  {selectedMetadataFloor.modules.map(module => (
                                    <span key={module.id} className="inline-flex items-center overflow-hidden rounded bg-gray-800 text-xs text-gray-300">
                                      <span className="px-2 py-0.5">{module.name}</span>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteModule(bm.id, module)}
                                        disabled={metadataBusy}
                                        title={`${module.name} 삭제`}
                                        aria-label={`${module.name} 삭제`}
                                        className="self-stretch px-1.5 text-gray-500 hover:bg-red-600 hover:text-white disabled:opacity-40"
                                      >
                                        ×
                                      </button>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-gray-500 text-sm">Basemap 설정을 불러오지 못했습니다.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
