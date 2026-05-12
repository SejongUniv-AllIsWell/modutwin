'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Building, BuildingMetadataOptions, MetadataFloorOption, Module } from '@/types';

export interface MetadataResult {
  building_id: string;
  building_name: string;
  floor_id: string;
  floor_number: number;
  module_id: string;
  module_name: string;
  /** SAM3 자유 텍스트 프롬프트. showSamPrompt=true 일 때만 채워짐. */
  sam_prompt?: string;
  /** 로컬 파일에서 문 설정 완료 시점에 register-local 로 새로 생성된 upload_id.
      서버 진입한 경우(이미 uploadId 가짐)는 비어있음. */
  upload_id?: string;
}

interface KakaoPlace {
  place_name: string;
  address_name: string;
  road_address_name: string;
  id: string;
}

interface Props {
  title?: string;
  description?: string;
  /** 초기값 — 정합 모드 진입 시 이미 선택된 메타가 있으면 미리 채움 */
  initial?: Partial<{ building_name: string; floor_number: number; module_name: string; sam_prompt: string }>;
  /** SAM3 프롬프트 입력란 동봉 여부 (현재 모든 흐름에서 false — SAM3 는 별도 팝업으로 분리됨). */
  showSamPrompt?: boolean;
  fixedContext?: {
    building_id?: string;
    building_name: string;
    floor_id?: string;
    floor_number: number;
    module_name?: string;
    kakao_place_id?: string;
    address_name?: string;
    road_address_name?: string;
    latitude?: number;
    longitude?: number;
  } | null;
  onConfirm: (result: MetadataResult) => Promise<void> | void;
  onClose: () => void;
}

function formatFloor(n: number): string {
  return n < 0 ? `B${Math.abs(n)}` : `${n}층`;
}

export default function MetadataPickerModal({
  title = '저장 정보 입력',
  description = '건물 / 층 / 모듈을 지정하세요.',
  initial,
  showSamPrompt = false,
  fixedContext = null,
  onConfirm,
  onClose,
}: Props) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedBuildingName, setSelectedBuildingName] = useState(initial?.building_name ?? '');
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<KakaoPlace[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [metadataOptions, setMetadataOptions] = useState<BuildingMetadataOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [selectedFloorId, setSelectedFloorId] = useState('');
  const [moduleName, setModuleName] = useState(initial?.module_name ?? '');
  const [samPrompt, setSamPrompt] = useState(initial?.sam_prompt ?? 'white wooden door');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fixedContext) {
      setSelectedBuildingName(fixedContext.building_name);
      setSelectedBuildingId(fixedContext.building_id ?? null);
      setSelectedFloorId(fixedContext.floor_id ?? '');
      setModuleName(fixedContext.module_name ?? initial?.module_name ?? '');
      return;
    }
    api.get<Building[]>('/buildings').then(setBuildings).catch(() => {});
  }, [fixedContext, initial?.module_name]);

  useEffect(() => {
    if (!searchOpen) return;
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [searchOpen]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const data = await api.get<{ documents: KakaoPlace[] }>(
          `/kakao/search/keyword?query=${encodeURIComponent(query)}&size=10`
        );
        setSearchResults(data.documents || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 400);
    return () => { clearTimeout(t); setSearchLoading(false); };
  }, [searchQuery]);

  useEffect(() => {
    if (!selectedBuildingName || selectedBuildingId) return;
    const existing = buildings.find(b => b.name === selectedBuildingName);
    if (existing) setSelectedBuildingId(existing.id);
  }, [buildings, selectedBuildingId, selectedBuildingName]);

  useEffect(() => {
    if (!selectedBuildingId || fixedContext) {
      setMetadataOptions(null);
      if (!fixedContext) {
        setSelectedFloorId('');
        setModuleName('');
      }
      setOptionsLoading(false);
      return;
    }

    let cancelled = false;
    setOptionsLoading(true);
    api.get<BuildingMetadataOptions>(`/buildings/${selectedBuildingId}/metadata-options`)
      .then(data => {
        if (cancelled) return;
        setMetadataOptions(data);
        setSelectedFloorId(prev => {
          if (prev && data.floors.some(f => f.id === prev)) return prev;
          const initialFloor = data.floors.find(f => f.floor_number === initial?.floor_number);
          return initialFloor?.id ?? data.floors[0]?.id ?? '';
        });
      })
      .catch(() => {
        if (!cancelled) {
          setMetadataOptions(null);
          setSelectedFloorId('');
          setModuleName('');
        }
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fixedContext, initial?.floor_number, selectedBuildingId]);

  const selectedFloor: MetadataFloorOption | null =
    metadataOptions?.floors.find(f => f.id === selectedFloorId) ?? null;

  useEffect(() => {
    if (fixedContext) return;
    if (!selectedFloor) {
      setModuleName('');
      return;
    }
    setModuleName(prev => {
      if (prev && selectedFloor.modules.some(m => m.name === prev)) return prev;
      const initialModule = selectedFloor.modules.find(m => m.name === initial?.module_name);
      return initialModule?.name ?? selectedFloor.modules[0]?.name ?? '';
    });
  }, [initial?.module_name, selectedFloor]);

  const selectBuilding = (name: string, id?: string | null) => {
    const existing = id ? null : buildings.find(b => b.name === name);
    setSelectedBuildingName(name);
    setSelectedBuildingId(id ?? existing?.id ?? null);
    setMetadataOptions(null);
    setSelectedFloorId('');
    setModuleName('');
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
  };

  const findOrCreateModule = async (floorId: string, name: string): Promise<string> => {
    const list = await api.get<Module[]>(`/floors/${floorId}/modules`);
    const existing = list.find(m => m.name === name);
    if (existing) return existing.id;
    const m = await api.post<Module>(`/floors/${floorId}/modules`, { name });
    return m.id;
  };

  const handleConfirm = async () => {
    setError(null);
    const targetBuildingId = fixedContext?.building_id ?? selectedBuildingId;
    const targetBuildingName = fixedContext?.building_name ?? selectedBuildingName;
    const targetFloorId = fixedContext?.floor_id ?? selectedFloor?.id;
    const targetFloorNumber = fixedContext?.floor_number ?? selectedFloor?.floor_number;
    const effectiveModuleName = fixedContext?.module_name ?? moduleName;
    if (!targetBuildingName || targetFloorNumber === undefined || !effectiveModuleName.trim()) {
      setError(fixedContext ? '모듈 이름을 입력하세요.' : '관리자가 등록한 건물, 층, 모듈을 모두 선택하세요.');
      return;
    }
    if (!fixedContext && (!targetBuildingId || !targetFloorId)) {
      setError('관리자가 등록한 건물, 층, 모듈을 모두 선택하세요.');
      return;
    }
    setSubmitting(true);
    try {
      let resolvedBuildingId = targetBuildingId ?? '';
      let resolvedFloorId = targetFloorId ?? '';
      let resolvedFloorNumber = targetFloorNumber;
      let moduleId = '';
      const trimmedModuleName = effectiveModuleName.trim();

      if (fixedContext) {
        const ensured = await api.post<{
          building_id: string;
          building_name: string;
          floor_id: string;
          floor_number: number;
          module_id: string | null;
          module_name: string | null;
        }>('/buildings/ensure-registration-context', {
          building_id: fixedContext.building_id,
          floor_id: fixedContext.floor_id,
          building_name: fixedContext.building_name,
          floor_number: fixedContext.floor_number,
          module_name: trimmedModuleName,
          kakao_place_id: fixedContext.kakao_place_id,
          address_name: fixedContext.address_name,
          road_address_name: fixedContext.road_address_name,
          latitude: fixedContext.latitude,
          longitude: fixedContext.longitude,
        });
        resolvedBuildingId = ensured.building_id;
        resolvedFloorId = ensured.floor_id;
        resolvedFloorNumber = ensured.floor_number;
        moduleId = ensured.module_id ?? '';
      } else {
        moduleId = await findOrCreateModule(targetFloorId as string, trimmedModuleName);
      }

      if (!resolvedBuildingId || !resolvedFloorId || !moduleId) {
        throw new Error('등록 컨텍스트를 확정하지 못했습니다.');
      }
      await onConfirm({
        building_id: resolvedBuildingId,
        building_name: targetBuildingName,
        floor_id: resolvedFloorId,
        floor_number: resolvedFloorNumber,
        module_id: moduleId,
        module_name: trimmedModuleName,
        sam_prompt: showSamPrompt ? samPrompt.trim() : undefined,
      });
    } catch (e: any) {
      setError(e?.message || '저장 중 오류가 발생했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg w-full max-w-md p-5 space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-100">{title}</h3>
          <p className="text-xs text-gray-400 mt-1">{description}</p>
        </div>

        {/* 건물 선택 */}
        {!fixedContext && (
        <div ref={dropdownRef} className="relative">
          <label className="block text-sm text-gray-400 mb-1">건물</label>
          <button
            type="button"
            onClick={() => !submitting && setSearchOpen(prev => !prev)}
            disabled={submitting}
            className="w-full text-left bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40 hover:border-gray-500"
          >
            {selectedBuildingName
              ? <span className="text-white">{selectedBuildingName}</span>
              : <span className="text-gray-500">건물 선택...</span>}
          </button>

          {searchOpen && (
            <div className="absolute z-10 top-full mt-1 w-full bg-gray-800 border border-gray-700 rounded shadow-lg">
              <div className="p-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="건물 이름 검색..."
                  autoFocus
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="max-h-60 overflow-y-auto">
                {/* 기존 등록된 건물 */}
                {!searchQuery.trim() && buildings.length > 0 && (
                  <div className="border-t border-gray-700">
                    <div className="px-3 py-1 text-[10px] text-gray-500 uppercase tracking-wide">등록된 건물</div>
                    {buildings.map(b => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => selectBuilding(b.name, b.id)}
                        className="w-full text-left px-3 py-2 hover:bg-gray-700 transition-colors text-white text-sm"
                      >
                        {b.name}
                      </button>
                    ))}
                  </div>
                )}
                {searchLoading && <div className="px-3 py-2 text-gray-400 text-sm">검색 중...</div>}
                {!searchLoading && searchQuery.trim() && searchResults.length === 0 && (
                  <div className="px-3 py-2 text-gray-400 text-sm">검색 결과가 없습니다.</div>
                )}
                {searchResults.map(place => (
                  <button
                    key={place.id}
                    type="button"
                    onClick={() => selectBuilding(place.place_name)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-700 transition-colors border-t border-gray-700 first:border-t-0"
                  >
                    <div className="text-white text-sm font-medium">{place.place_name}</div>
                    <div className="text-gray-400 text-xs mt-0.5">{place.road_address_name || place.address_name}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        )}

        {/* 층 / 모듈 */}
        {!fixedContext && (
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm text-gray-400 mb-1">층</label>
            <select
              value={selectedFloorId}
              onChange={e => setSelectedFloorId(e.target.value)}
              disabled={submitting || optionsLoading || !selectedBuildingId || !metadataOptions?.floors.length}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40"
            >
              <option value="">{optionsLoading ? '불러오는 중...' : '층 선택'}</option>
              {metadataOptions?.floors.map(floor => (
                <option key={floor.id} value={floor.id}>
                  {formatFloor(floor.floor_number)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-sm text-gray-400 mb-1">모듈</label>
            <select
              value={moduleName}
              onChange={e => setModuleName(e.target.value)}
              disabled={submitting || optionsLoading || !selectedFloor || selectedFloor.modules.length === 0}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40"
            >
              <option value="">{selectedFloor ? '모듈 선택' : '층 선택 필요'}</option>
              {selectedFloor?.modules.map(module => (
                <option key={module.id} value={module.name}>
                  {module.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        )}
        {fixedContext && !fixedContext.module_name && (
          <div>
            <label className="block text-sm text-gray-400 mb-1">모듈 이름</label>
            <input
              type="text"
              value={moduleName}
              onChange={e => setModuleName(e.target.value)}
              placeholder="모듈 이름"
              disabled={submitting}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40"
            />
          </div>
        )}
        {fixedContext?.module_name && (
          <div>
            <label className="block text-sm text-gray-400 mb-1">모듈 이름</label>
            <div className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm">
              {fixedContext.module_name}
            </div>
          </div>
        )}

        {showSamPrompt && (
          <div>
            <label className="block text-sm text-gray-400 mb-1">SAM3 프롬프트</label>
            <input
              type="text"
              value={samPrompt}
              onChange={e => setSamPrompt(e.target.value)}
              placeholder='예: "white wooden door"'
              disabled={submitting}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40"
            />
            <p className="text-[11px] text-gray-500 mt-1">
              GPU worker 가 이 프롬프트로 문 꼭짓점을 자동 검출합니다. 비워두면 기본 프롬프트로 진행합니다.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded disabled:opacity-40"
          >
            취소
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-40"
          >
            {submitting ? '저장 중...' : (showSamPrompt ? '완료' : '확인')}
          </button>
        </div>
      </div>
    </div>
  );
}
