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
    api.get<Building[]>('/buildings').then(setBuildings).catch(() => {});
  }, []);

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
    const KAKAO_KEY = process.env.NEXT_PUBLIC_KAKAO_REST_API_KEY;
    if (!KAKAO_KEY) return;
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=10`,
          { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } }
        );
        if (!res.ok) return;
        const data = await res.json();
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
    if (!selectedBuildingId) {
      setMetadataOptions(null);
      setSelectedFloorId('');
      setModuleName('');
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
  }, [initial?.floor_number, selectedBuildingId]);

  const selectedFloor: MetadataFloorOption | null =
    metadataOptions?.floors.find(f => f.id === selectedFloorId) ?? null;

  useEffect(() => {
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
    if (!selectedBuildingId || !selectedBuildingName || !selectedFloor || !moduleName.trim()) {
      setError('관리자가 등록한 건물, 층, 모듈을 모두 선택하세요.');
      return;
    }
    setSubmitting(true);
    try {
      const moduleId = await findOrCreateModule(selectedFloor.id, moduleName.trim());
      await onConfirm({
        building_id: selectedBuildingId,
        building_name: selectedBuildingName,
        floor_id: selectedFloor.id,
        floor_number: selectedFloor.floor_number,
        module_id: moduleId,
        module_name: moduleName.trim(),
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

        {/* 층 / 모듈 */}
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
