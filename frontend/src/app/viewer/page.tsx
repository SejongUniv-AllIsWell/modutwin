'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Building, Scene } from '@/types';
import BuildingMap from '@/components/map/BuildingMap';
import dynamic from 'next/dynamic';

const SplatViewer = dynamic(() => import('@/components/viewer/SplatViewer'), { ssr: false });
const RefineViewer = dynamic(() => import('@/components/viewer/RefineViewer'), { ssr: false });

function ViewerContent() {
  const searchParams = useSearchParams();
  const uploadId = searchParams.get('upload_id');
  const viewMode = searchParams.get('mode');  // 'refine' | 'align' | null

  const [scenes, setScenes] = useState<Scene[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedScene, setSelectedScene] = useState<Scene | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [uploadFilename, setUploadFilename] = useState<string | null>(null);

  // upload_id가 있으면 해당 파일을 바로 로드
  // 정합(align) 모드면 refined 버전을 우선 요청
  useEffect(() => {
    if (!uploadId) return;
    setLoadingFile(true);
    const variant = viewMode === 'align' ? 'refined' : '';
    const qs = variant ? `?variant=${variant}` : '';
    api.get<{ url: string; filename: string }>(`/uploads/${uploadId}/presigned-url${qs}`)
      .then(data => {
        setFileUrl(data.url);
        // variant가 있으면 파일명에 반영
        const name = data.filename ?? '';
        if (variant && name && !name.includes(variant)) {
          const dotIdx = name.lastIndexOf('.');
          const base = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
          const ext = dotIdx >= 0 ? name.slice(dotIdx) : '';
          setUploadFilename(`${base}_${variant}${ext}`);
        } else {
          setUploadFilename(name);
        }
      })
      .catch(() => setFileUrl(null))
      .finally(() => setLoadingFile(false));
  }, [uploadId, viewMode]);

  useEffect(() => {
    if (uploadId) return; // upload_id 모드면 씬 목록 불필요
    api.get<Scene[]>('/scenes').then(setScenes).catch(() => {});
    api.get<Building[]>('/buildings').then(setBuildings).catch(() => {});
  }, [uploadId]);

  const handleSceneSelect = async (scene: Scene) => {
    setSelectedScene(scene);
    try {
      const data = await api.get<{ url: string }>(`/scenes/${scene.id}/download`);
      setFileUrl(data.url);
      setUploadFilename(null);
    } catch {
      setFileUrl(null);
    }
  };

  const mapBuildings = buildings.map(b => ({
    name: b.name,
    lat: 37.5665,
    lng: 126.978,
    floors: [] as number[],
  }));

  // upload_id 직접 로드 모드
  if (uploadId) {
    return (
      <div className="flex flex-col h-[calc(100dvh-56px)]">
        {/* 상단 파일 정보 바 */}
        <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
          <button
            onClick={() => window.history.back()}
            className="text-gray-400 hover:text-white transition"
            title="뒤로가기"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-sm text-gray-300 font-medium truncate">
            {uploadFilename ?? '파일 로딩 중...'}
          </span>
        </div>

        {/* 뷰어 */}
        <div className="flex-1">
          {loadingFile ? (
            <div className="flex items-center justify-center h-full text-gray-500">
              <div className="text-center">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                <p className="text-sm">파일 로딩 중...</p>
              </div>
            </div>
          ) : fileUrl ? (
            viewMode === 'refine' ? (
              <RefineViewer sogUrl={fileUrl} uploadId={uploadId ?? undefined} />
            ) : (
              <SplatViewer sogUrl={fileUrl} mode={viewMode === 'align' ? 'edit' : 'readonly'} uploadId={uploadId ?? undefined} />
            )
          ) : (
            <div className="flex items-center justify-center h-full text-gray-600">
              <p className="text-sm">파일을 불러올 수 없습니다.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 기본 씬 탐색 모드
  return (
    <div className="flex flex-col lg:flex-row h-[calc(100dvh-56px)]">
      {/* 왼쪽: 지도 + 씬 목록 */}
      <div className="lg:w-80 flex flex-col border-r border-gray-800">
        <div className="h-64 lg:h-1/2">
          <BuildingMap buildings={mapBuildings} />
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <h3 className="text-sm font-semibold text-gray-400 mb-2">씬 목록</h3>
          {scenes.length === 0 ? (
            <p className="text-xs text-gray-600">정합된 씬이 없습니다.</p>
          ) : (
            <div className="space-y-1">
              {scenes.map(scene => (
                <button
                  key={scene.id}
                  onClick={() => handleSceneSelect(scene)}
                  className={`w-full text-left p-2 rounded text-sm transition ${
                    selectedScene?.id === scene.id
                      ? 'bg-blue-600/20 text-blue-400 border border-blue-600/30'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  <div className="font-medium text-xs font-mono truncate">{scene.module_id}</div>
                  <div className="text-xs text-gray-500">
                    {new Date(scene.created_at).toLocaleDateString('ko-KR')}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 오른쪽: 3D 뷰어 */}
      <div className="flex-1">
        {fileUrl ? (
          <SplatViewer sogUrl={fileUrl} mode="readonly" />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-600">
            <p className="text-center">
              {selectedScene ? 'SOG 파일을 로딩 중...' : '왼쪽에서 씬을 선택하세요'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ViewerPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-[calc(100vh-56px)] text-gray-500">로딩 중...</div>}>
      <ViewerContent />
    </Suspense>
  );
}
