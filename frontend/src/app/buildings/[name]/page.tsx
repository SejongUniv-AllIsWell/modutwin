'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Building, Floor, Module, Scene } from '@/types';
import { useAuth } from '@/lib/auth';
import dynamic from 'next/dynamic';

const SplatViewer = dynamic(() => import('@/components/viewer/SplatViewer'), { ssr: false });

interface ModuleWithScene extends Module {
  scene?: Scene;
}

interface FloorWithModules extends Floor {
  modules: ModuleWithScene[];
}

export default function BuildingDetailPage() {
  const router = useRouter();
  const params = useParams();
  // route param is building UUID
  const buildingId = params.name as string;

  const { user, loading } = useAuth();
  const [building, setBuilding] = useState<Building | null>(null);
  const [floors, setFloors] = useState<FloorWithModules[]>([]);
  const [selectedScene, setSelectedScene] = useState<Scene | null>(null);
  const [selectedModule, setSelectedModule] = useState<Module | null>(null);
  const [sogUrl, setSogUrl] = useState<string | null>(null);
  const [loadingScene, setLoadingScene] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.push('/');
  }, [user, loading, router]);

  const handleSceneSelect = useCallback(async (scene: Scene, module: Module) => {
    setSelectedScene(scene);
    setSelectedModule(module);
    setLoadingScene(true);
    setSogUrl(null);
    try {
      const data = await api.get<{ url: string }>(`/scenes/${scene.id}/download`);
      setSogUrl(data.url);
    } catch {
      setSogUrl(null);
    } finally {
      setLoadingScene(false);
    }
  }, []);

  useEffect(() => {
    if (!buildingId) return;

    // 건물 정보 로드
    api.get<Building>(`/buildings/${buildingId}`).then(setBuilding).catch(() => {});

    // 층 목록 로드
    api.get<Floor[]>(`/buildings/${buildingId}/floors`).then(async (floorList) => {
      const withModules: FloorWithModules[] = await Promise.all(
        floorList.map(async (floor) => {
          try {
            const mods = await api.get<Module[]>(`/floors/${floor.id}/modules`);
            // 각 모듈의 씬 조회
            const modulesWithScene: ModuleWithScene[] = await Promise.all(
              mods.map(async (mod) => {
                try {
                  const scenes = await api.get<Scene[]>(`/scenes?module_id=${mod.id}`);
                  return { ...mod, scene: scenes[0] };
                } catch {
                  return { ...mod };
                }
              })
            );
            return { ...floor, modules: modulesWithScene };
          } catch {
            return { ...floor, modules: [] };
          }
        })
      );
      setFloors(withModules);

      // 첫 번째 씬 자동 선택 + 해당 층 열기
      for (const floor of withModules) {
        for (const mod of floor.modules) {
          if (mod.scene) {
            setOpenFloors(new Set([floor.id]));
            handleSceneSelect(mod.scene, mod);
            return;
          }
        }
      }
    }).catch(() => {});
  }, [buildingId, handleSceneSelect]);

  const totalScenes = floors.reduce((sum, f) => sum + f.modules.filter(m => m.scene).length, 0);

  // 지상 내림차순 → 지하 내림차순 정렬
  const sortedFloors = [...floors].sort((a, b) => b.floor_number - a.floor_number);

  const floorLabel = (n: number) => n >= 0 ? `${n}층` : `B${Math.abs(n)}`;

  const [openFloors, setOpenFloors] = useState<Set<string>>(new Set());
  const toggleFloor = (id: string) =>
    setOpenFloors(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (loading) return null;

  return (
    <div className="flex h-[calc(100vh-56px)]">
      {/* 좌측 패널 */}
      <div className="w-72 flex flex-col border-r border-gray-800 bg-gray-900 shrink-0">
        <div className="p-4 border-b border-gray-800">
          <button
            onClick={() => router.push('/explore')}
            className="flex items-center gap-1.5 text-gray-400 hover:text-white text-sm mb-4 transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            목록으로 돌아가기
          </button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-white leading-tight truncate">
                {building?.name ?? '...'}
              </h1>
              <p className="text-xs text-gray-500 mt-0.5">{totalScenes}개 씬 등록됨</p>
            </div>
          </div>
        </div>

        {/* 층/모듈 목록 */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-2.5 border-b border-gray-800">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">층 / 모듈 목록</p>
          </div>

          {floors.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-600">
              <svg className="w-10 h-10 mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              <p className="text-sm">씬 데이터가 없습니다</p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {sortedFloors.map(floor => {
                const isOpen = openFloors.has(floor.id);
                const hasSelected = floor.modules.some(m => m.id === selectedModule?.id);
                return (
                  <div key={floor.id}>
                    <button
                      onClick={() => toggleFloor(floor.id)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-semibold transition ${
                        hasSelected ? 'text-blue-400' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                      }`}
                    >
                      <span>{floorLabel(floor.floor_number)}</span>
                      <svg
                        className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isOpen && (
                      <div className="mt-1 mb-1 ml-2 space-y-1">
                        {floor.modules.map(mod => (
                          <button
                            key={mod.id}
                            onClick={() => mod.scene && handleSceneSelect(mod.scene, mod)}
                            disabled={!mod.scene}
                            className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition ${
                              selectedModule?.id === mod.id
                                ? 'bg-blue-600/20 text-blue-300 border border-blue-600/40'
                                : mod.scene
                                  ? 'text-gray-300 hover:bg-gray-800 border border-transparent'
                                  : 'text-gray-600 border border-transparent cursor-default'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium truncate">{mod.name}</span>
                              {!mod.scene && (
                                <span className="text-xs text-gray-600 ml-2 shrink-0">씬 없음</span>
                              )}
                            </div>
                            {mod.scene && (
                              <p className="text-xs text-gray-500 mt-1">
                                {new Date(mod.scene.created_at).toLocaleDateString('ko-KR', {
                                  year: 'numeric', month: 'long', day: 'numeric',
                                })}
                              </p>
                            )}
                          </button>
                        ))}
                        {floor.modules.length === 0 && (
                          <p className="text-xs text-gray-600 px-3 py-2">모듈 없음</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 우측: 3D 뷰어 */}
      <div className="flex-1 relative bg-gray-950">
        {sogUrl ? (
          <SplatViewer sogUrl={sogUrl} mode="readonly" />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-600">
            <div className="text-center">
              {loadingScene ? (
                <>
                  <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                  <p className="text-sm text-gray-400">씬 로딩 중...</p>
                </>
              ) : (
                <>
                  <svg className="w-20 h-20 mx-auto mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                  <p className="text-sm">
                    {totalScenes === 0 ? '이 건물에 등록된 씬이 없습니다' : '왼쪽에서 모듈을 선택하세요'}
                  </p>
                </>
              )}
            </div>
          </div>
        )}

        {/* 선택된 씬 정보 오버레이 */}
        {selectedModule && sogUrl && (
          <div className="absolute top-4 left-4 bg-gray-900/80 backdrop-blur-sm border border-gray-700/50 rounded-xl px-4 py-3 pointer-events-none">
            <p className="text-xs text-gray-400">{building?.name}</p>
            <p className="text-sm font-semibold text-white mt-0.5">
              {floors.find(f => f.modules.some(m => m.id === selectedModule.id))?.floor_number}층 · {selectedModule.name}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
