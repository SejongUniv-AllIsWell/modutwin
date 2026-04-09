'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '@/lib/api';
import { Building, Floor, Module, UploadInitResponse } from '@/types';

const PLY_EXTENSIONS = ['.ply'];

function isPlyFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return PLY_EXTENSIONS.includes(`.${ext}`);
}

// 브라우저가 file.type을 빈 문자열로 반환할 때 확장자 기반 보완
const EXT_TO_MIME: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', webm: 'video/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
  ply: 'application/octet-stream', splat: 'application/octet-stream',
  sog: 'application/octet-stream',
};

function resolveContentType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

// "1","2" → 1,2 / "B1","B2" → -1,-2 / invalid → null
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

// normalize on blur: "-1" or "-1층" → "B1", "b2" → "B2", etc.
function normalizeFloorInput(value: string): string {
  const v = value.trim();
  // "-숫자" or "-숫자층"
  const negMatch = v.match(/^-(\d+)층?$/);
  if (negMatch) {
    const n = parseInt(negMatch[1], 10);
    return n > 0 ? `B${n}` : '';
  }
  // "B숫자" (case insensitive)
  const bMatch = v.toUpperCase().match(/^B(\d+)$/);
  if (bMatch) {
    const n = parseInt(bMatch[1], 10);
    return n > 0 ? `B${n}` : '';
  }
  // 양의 정수
  if (/^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    return n > 0 ? String(n) : '';
  }
  return '';
}

interface KakaoPlace {
  place_name: string;
  address_name: string;
  road_address_name: string;
  id: string;
}

export default function MultipartUploader() {
  const fileRef = useRef<HTMLInputElement>(null);
  const buildingDropdownRef = useRef<HTMLDivElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  // Building state
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedBuildingName, setSelectedBuildingName] = useState('');
  const [buildingSearchOpen, setBuildingSearchOpen] = useState(false);
  const [buildingSearchQuery, setBuildingSearchQuery] = useState('');
  const [buildingSearchResults, setBuildingSearchResults] = useState<KakaoPlace[]>([]);
  const [buildingSearchLoading, setBuildingSearchLoading] = useState(false);

  // Floor and Module (direct input)
  const [floorNumber, setFloorNumber] = useState('');
  const [moduleName, setModuleName] = useState('');

  // PLY target
  const [plyTargetAlignment, setPlyTargetAlignment] = useState(false);

  // Load buildings on mount
  useEffect(() => {
    api.get<Building[]>('/buildings').then(setBuildings).catch(() => {});
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!buildingSearchOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (buildingDropdownRef.current && !buildingDropdownRef.current.contains(e.target as Node)) {
        setBuildingSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [buildingSearchOpen]);

  // Kakao search with debounce
  useEffect(() => {
    const query = buildingSearchQuery.trim();
    if (!query) {
      setBuildingSearchResults([]);
      setBuildingSearchLoading(false);
      return;
    }

    const KAKAO_KEY = process.env.NEXT_PUBLIC_KAKAO_REST_API_KEY;
    if (!KAKAO_KEY) return;

    setBuildingSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=10`,
          { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } }
        );
        if (!res.ok) return;
        const data = await res.json();
        setBuildingSearchResults(data.documents || []);
      } catch {
        setBuildingSearchResults([]);
      } finally {
        setBuildingSearchLoading(false);
      }
    }, 400);

    return () => {
      clearTimeout(timer);
      setBuildingSearchLoading(false);
    };
  }, [buildingSearchQuery]);

  const handleSelectBuilding = (place: KakaoPlace) => {
    setSelectedBuildingName(place.place_name);
    setBuildingSearchOpen(false);
    setBuildingSearchQuery('');
    setBuildingSearchResults([]);
  };

  // find-or-create helpers
  const findOrCreateBuilding = async (name: string): Promise<string> => {
    const existing = buildings.find(b => b.name === name);
    if (existing) return existing.id;
    const b = await api.post<Building>('/buildings', { name });
    setBuildings(prev => [...prev, b]);
    return b.id;
  };

  const findOrCreateFloor = async (buildingId: string, floorNum: number): Promise<string> => {
    const floorList = await api.get<Floor[]>(`/buildings/${buildingId}/floors`);
    const existing = floorList.find(f => f.floor_number === floorNum);
    if (existing) return existing.id;
    const f = await api.post<Floor>(`/buildings/${buildingId}/floors`, { floor_number: floorNum });
    return f.id;
  };

  const findOrCreateModule = async (floorId: string, name: string): Promise<string> => {
    const moduleList = await api.get<Module[]>(`/floors/${floorId}/modules`);
    const existing = moduleList.find(m => m.name === name);
    if (existing) return existing.id;
    const m = await api.post<Module>(`/floors/${floorId}/modules`, { name });
    return m.id;
  };

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (uploading) return;
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      setFile(dropped);
      if (!isPlyFile(dropped.name)) setPlyTargetAlignment(false);
    }
  }, [uploading]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!uploading) setIsDragging(true);
  }, [uploading]);

  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    setFile(f);
    if (f && !isPlyFile(f.name)) setPlyTargetAlignment(false);
  };

  const handleUpload = async () => {
    const floorInt = parseFloorToInt(floorNumber);
    if (!file || !selectedBuildingName || floorInt === null || !moduleName.trim()) {
      setMessage('파일, 건물, 층(양의 정수 또는 B1·B2 형식), 모듈을 모두 입력하세요.');
      return;
    }

    setUploading(true);
    setUploadStatus('uploading');
    setProgress(0);
    setMessage('');

    try {
      const buildingId = await findOrCreateBuilding(selectedBuildingName);
      const floorId = await findOrCreateFloor(buildingId, floorInt);
      const moduleId = await findOrCreateModule(floorId, moduleName.trim());

      const plyTarget = isPlyFile(file.name) ? 'gsplat' : undefined;

      // 1. 업로드 초기화
      const initRes = await api.post<UploadInitResponse>('/uploads/init', {
        filename: file.name,
        file_size: file.size,
        content_type: resolveContentType(file),
        building_id: buildingId,
        floor_id: floorId,
        module_id: moduleId,
        ...(plyTarget ? { ply_target: plyTarget } : {}),
      });

      const { upload_id, minio_upload_id, presigned_urls, part_size } = initRes;

      // 2. 파트별 업로드
      const parts: { part_number: number; etag: string }[] = [];

      for (let i = 0; i < presigned_urls.length; i++) {
        const start = i * part_size;
        const end = Math.min(start + part_size, file.size);
        const chunk = file.slice(start, end);

        const res = await fetch(presigned_urls[i], { method: 'PUT', body: chunk });
        if (!res.ok) throw new Error(`파트 ${i + 1} 업로드 실패`);

        const etag = res.headers.get('etag')?.replace(/"/g, '') || '';
        parts.push({ part_number: i + 1, etag });
        setProgress(Math.round(((i + 1) / presigned_urls.length) * 100));
      }

      // 3. 업로드 완료
      const completeRes = await api.post<{ message: string }>('/uploads/complete', {
        upload_id,
        minio_upload_id,
        parts,
      });

      setUploadStatus('done');
      setMessage(completeRes.message || '업로드 완료!');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (e: any) {
      setUploadStatus('error');
      setMessage(e.message || '업로드에 실패했습니다.');
    } finally {
      setUploading(false);
    }
  };

  const fileIsPly = file ? isPlyFile(file.name) : false;

  return (
    <div className="max-w-lg mx-auto space-y-4">
      {/* 파일 선택 */}
      <div>
        <label className="block text-sm text-gray-400 mb-2">파일</label>
        <div
          onClick={() => !uploading && fileRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={`flex flex-col items-center justify-center w-full h-40 rounded-lg border-2 border-dashed cursor-pointer transition-colors
            ${uploading ? 'cursor-not-allowed opacity-50' : ''}
            ${isDragging ? 'border-blue-400 bg-blue-950' : 'border-gray-600 bg-gray-800 hover:border-blue-500'}`}
        >
          <svg className="w-8 h-8 mb-2 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          {file ? (
            <p className="text-sm text-blue-400 font-medium px-4 text-center truncate max-w-full">{file.name}</p>
          ) : (
            <>
              <p className="text-sm text-gray-300">파일을 끌어다 놓거나 클릭하여 선택</p>
              <p className="text-xs text-gray-500 mt-1">video, image, .ply</p>
            </>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="video/*,image/*,.ply,.splat,.sog"
          onChange={handleFileChange}
          className="hidden"
          disabled={uploading}
        />
      </div>


      {/* 건물 선택 */}
      <div ref={buildingDropdownRef} className="relative">
        <label className="block text-sm text-gray-400 mb-1">건물</label>
        <button
          type="button"
          onClick={() => !uploading && setBuildingSearchOpen(prev => !prev)}
          disabled={uploading}
          className="w-full text-left bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40 transition-colors hover:border-gray-500"
        >
          {selectedBuildingName
            ? <span className="text-white">{selectedBuildingName}</span>
            : <span className="text-gray-500">건물 선택...</span>
          }
        </button>

        {buildingSearchOpen && (
          <div className="absolute z-10 top-full mt-1 w-full bg-gray-800 border border-gray-700 rounded shadow-lg">
            <div className="p-2">
              <input
                type="text"
                value={buildingSearchQuery}
                onChange={e => setBuildingSearchQuery(e.target.value)}
                placeholder="건물 이름 검색..."
                autoFocus
                className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="max-h-60 overflow-y-auto">
              {buildingSearchLoading && (
                <div className="px-3 py-2 text-gray-400 text-sm">검색 중...</div>
              )}
              {!buildingSearchLoading && buildingSearchQuery.trim() && buildingSearchResults.length === 0 && (
                <div className="px-3 py-2 text-gray-400 text-sm">검색 결과가 없습니다.</div>
              )}
              {buildingSearchResults.map(place => (
                <button
                  key={place.id}
                  type="button"
                  onClick={() => handleSelectBuilding(place)}
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
            disabled={uploading}
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
            disabled={uploading}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40"
          />
        </div>
      </div>

      {/* 업로드 진행률 */}
      {uploadStatus === 'uploading' && (
        <div>
          <div className="flex justify-between text-sm text-gray-400 mb-1">
            <span>업로드 중...</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2">
            <div className="bg-blue-500 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {/* 메시지 */}
      {message && (
        <p className={`text-sm ${uploadStatus === 'error' ? 'text-red-400' : uploadStatus === 'done' ? 'text-green-400' : 'text-yellow-400'}`}>
          {message}
        </p>
      )}

      {/* 업로드 버튼 */}
      <button
        onClick={handleUpload}
        disabled={uploading || !file || !selectedBuildingName || parseFloorToInt(floorNumber) === null || !moduleName.trim()}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white py-2 rounded text-sm font-medium transition"
      >
        {uploading ? '업로드 중...' : '업로드 시작'}
      </button>
    </div>
  );
}
