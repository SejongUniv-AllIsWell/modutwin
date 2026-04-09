'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Building, Floor } from '@/types';
import { useAuth } from '@/lib/auth';

declare global {
  interface Window { kakao: any; }
}

interface BuildingWithFloors extends Building {
  floorCount: number;
}

export default function ExplorePage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const markersRef = useRef<any[]>([]);

  const [buildings, setBuildings] = useState<BuildingWithFloors[]>([]);
  const [filteredBuildings, setFilteredBuildings] = useState<BuildingWithFloors[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

  // 건물 목록 로드
  useEffect(() => {
    api.get<Building[]>('/buildings?has_output=true').then(async (data) => {
      const withFloors: BuildingWithFloors[] = await Promise.all(
        data.map(async (b) => {
          try {
            const floors = await api.get<Floor[]>(`/buildings/${b.id}/floors`);
            return { ...b, floorCount: floors.length };
          } catch {
            return { ...b, floorCount: 0 };
          }
        })
      );
      setBuildings(withFloors);
      setFilteredBuildings(withFloors);
    }).catch(() => {});
  }, []);

  // 카카오맵 초기화
  useEffect(() => {
    if (loading) return;
    const kakaoKey = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY;
    if (!kakaoKey) return;

    const initMap = () => {
      if (!mapRef.current) return;
      const map = new window.kakao.maps.Map(mapRef.current, {
        center: new window.kakao.maps.LatLng(37.5665, 126.978),
        level: 5,
      });
      mapInstance.current = map;
      setMapLoaded(true);
    };

    if (window.kakao?.maps) {
      window.kakao.maps.load(() => initMap());
      return;
    }

    const existing = document.querySelector('script[src*="dapi.kakao.com"]');
    if (existing) {
      if (window.kakao) {
        // 스크립트는 로드됐지만 maps.load()가 아직 호출되지 않은 경우
        window.kakao.maps.load(() => initMap());
      } else {
        existing.addEventListener('load', () => window.kakao.maps.load(() => initMap()));
        existing.addEventListener('error', () => setMapError(true));
      }
      return;
    }

    const script = document.createElement('script');
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${kakaoKey}&autoload=false&libraries=services`;
    script.onload = () => window.kakao.maps.load(() => initMap());
    script.onerror = () => setMapError(true);
    document.head.appendChild(script);
  }, [loading]);

  // 마커 등록
  useEffect(() => {
    if (!mapLoaded || !mapInstance.current || buildings.length === 0) return;

    markersRef.current.forEach(m => m.setMap(null));
    markersRef.current = [];

    const map = mapInstance.current;
    const ps = new window.kakao.maps.services.Places();

    buildings.forEach((building) => {
      ps.keywordSearch(building.name, (result: any[], status: any) => {
        let lat = 37.5665;
        let lng = 126.978;

        if (status === window.kakao.maps.services.Status.OK && result.length > 0) {
          lat = parseFloat(result[0].y);
          lng = parseFloat(result[0].x);
        }

        const position = new window.kakao.maps.LatLng(lat, lng);
        const marker = new window.kakao.maps.Marker({ map, position, title: building.name });

        const infowindow = new window.kakao.maps.InfoWindow({
          content: `<div style="padding:8px 12px;font-size:13px;font-weight:600;white-space:nowrap;color:#111;">${building.name}<br/><span style="font-size:11px;font-weight:400;color:#666;">${building.floorCount}개 층</span></div>`,
        });

        window.kakao.maps.event.addListener(marker, 'mouseover', () => infowindow.open(map, marker));
        window.kakao.maps.event.addListener(marker, 'mouseout', () => infowindow.close());
        window.kakao.maps.event.addListener(marker, 'click', () => {
          router.push(`/buildings/${building.id}`);
        });

        markersRef.current.push(marker);
      });
    });
  }, [mapLoaded, buildings, router]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setFilteredBuildings(buildings);
      return;
    }
    const lower = query.toLowerCase();
    setFilteredBuildings(buildings.filter(b => b.name.toLowerCase().includes(lower)));
  };

  if (loading) return null;

  return (
    <div className="flex h-[calc(100vh-56px)]">
      {/* 좌측 패널 */}
      <div className="w-80 flex flex-col border-r border-gray-800 bg-gray-900 shrink-0">
        <div className="p-3 border-b border-gray-800">
          <div className="relative flex items-center">
            <svg className="absolute left-3 w-4 h-4 text-gray-500 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="건물 검색..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition"
            />
            {searchQuery && (
              <button onClick={() => handleSearch('')} className="absolute right-3 text-gray-500 hover:text-gray-300">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="px-4 py-2.5 border-b border-gray-800">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            건물 목록 {filteredBuildings.length > 0 && `(${filteredBuildings.length})`}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredBuildings.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-16 text-gray-600">
              <svg className="w-12 h-12 mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <p className="text-sm">
                {searchQuery ? '검색 결과가 없습니다' : '등록된 건물이 없습니다'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-800/60">
              {filteredBuildings.map((building) => (
                <button
                  key={building.id}
                  onClick={() => router.push(`/buildings/${building.id}`)}
                  className="w-full text-left px-4 py-3.5 hover:bg-gray-800/70 transition group"
                >
                  <div className="flex items-center gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-blue-600/15 text-blue-400 flex items-center justify-center group-hover:bg-blue-600/25 transition">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-200 truncate group-hover:text-white transition">
                        {building.name}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">{building.floorCount}개 층</p>
                    </div>
                    <svg className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 우측: 카카오 지도 */}
      <div className="flex-1 relative">
        <div ref={mapRef} className="w-full h-full" />
        {!mapLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900 text-gray-500">
            <div className="text-center">
              {mapError ? (
                <p className="text-sm text-red-400">지도를 불러오지 못했습니다</p>
              ) : !process.env.NEXT_PUBLIC_KAKAO_MAP_KEY ? (
                <p className="text-sm">카카오맵 API 키가 설정되지 않았습니다</p>
              ) : (
                <>
                  <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm">지도 로딩 중...</p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
