'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Building, Floor, Module } from '@/types';

export interface MetadataResult {
  building_id: string;
  building_name: string;
  floor_id: string;
  floor_number: number;
  module_id: string;
  module_name: string;
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
  initial?: Partial<{ building_name: string; floor_number: number; module_name: string }>;
  onConfirm: (result: MetadataResult) => Promise<void> | void;
  onClose: () => void;
}

function parseFloorToInt(value: string): number | null {
  const v = value.trim().toUpperCase();
  if (/^B(\d+)$/.test(v)) {
    const n = parseInt(v.slice(1), 10);
    return n > 0 ? -n : null;
  }
  if (/^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    return n > 0 ? n : null;
  }
  return null;
}

function normalizeFloorInput(value: string): string {
  const v = value.trim();
  const negMatch = v.match(/^-(\d+)층?$/);
  if (negMatch) {
    const n = parseInt(negMatch[1], 10);
    return n > 0 ? `B${n}` : '';
  }
  const bMatch = v.toUpperCase().match(/^B(\d+)$/);
  if (bMatch) {
    const n = parseInt(bMatch[1], 10);
    return n > 0 ? `B${n}` : '';
  }
  if (/^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    return n > 0 ? String(n) : '';
  }
  return '';
}

export default function MetadataPickerModal({
  title = '저장 정보 입력',
  description = '건물 / 층 / 모듈을 지정하세요.',
  initial,
  onConfirm,
  onClose,
}: Props) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedBuildingName, setSelectedBuildingName] = useState(initial?.building_name ?? '');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<KakaoPlace[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [floorNumber, setFloorNumber] = useState(
    initial?.floor_number !== undefined
      ? (initial.floor_number < 0 ? `B${Math.abs(initial.floor_number)}` : String(initial.floor_number))
      : ''
  );
  const [moduleName, setModuleName] = useState(initial?.module_name ?? '');

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

  const findOrCreateBuilding = async (name: string): Promise<{ id: string; name: string }> => {
    const existing = buildings.find(b => b.name === name);
    if (existing) return { id: existing.id, name: existing.name };
    const b = await api.post<Building>('/buildings', { name });
    setBuildings(prev => [...prev, b]);
    return { id: b.id, name: b.name };
  };

  const findOrCreateFloor = async (buildingId: string, floorNum: number): Promise<string> => {
    const list = await api.get<Floor[]>(`/buildings/${buildingId}/floors`);
    const existing = list.find(f => f.floor_number === floorNum);
    if (existing) return existing.id;
    const f = await api.post<Floor>(`/buildings/${buildingId}/floors`, { floor_number: floorNum });
    return f.id;
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
    const floorInt = parseFloorToInt(floorNumber);
    if (!selectedBuildingName || floorInt === null || !moduleName.trim()) {
      setError('건물, 층(양의 정수 또는 B1·B2), 모듈을 모두 입력하세요.');
      return;
    }
    setSubmitting(true);
    try {
      const building = await findOrCreateBuilding(selectedBuildingName);
      const floorId = await findOrCreateFloor(building.id, floorInt);
      const moduleId = await findOrCreateModule(floorId, moduleName.trim());
      await onConfirm({
        building_id: building.id,
        building_name: building.name,
        floor_id: floorId,
        floor_number: floorInt,
        module_id: moduleId,
        module_name: moduleName.trim(),
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
                        onClick={() => {
                          setSelectedBuildingName(b.name);
                          setSearchOpen(false);
                          setSearchQuery('');
                        }}
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
                    onClick={() => {
                      setSelectedBuildingName(place.place_name);
                      setSearchOpen(false);
                      setSearchQuery('');
                      setSearchResults([]);
                    }}
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
            <input
              type="text"
              value={floorNumber}
              onChange={e => setFloorNumber(e.target.value)}
              onBlur={e => setFloorNumber(normalizeFloorInput(e.target.value))}
              placeholder="1, 2 또는 B1, B2"
              disabled={submitting}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40"
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm text-gray-400 mb-1">모듈</label>
            <input
              type="text"
              value={moduleName}
              onChange={e => setModuleName(e.target.value)}
              placeholder="모듈 이름"
              disabled={submitting}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40"
            />
          </div>
        </div>

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
            {submitting ? '저장 중...' : '확인'}
          </button>
        </div>
      </div>
    </div>
  );
}
