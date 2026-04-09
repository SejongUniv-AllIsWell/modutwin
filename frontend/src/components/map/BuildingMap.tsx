'use client';

import { useEffect, useRef, useState } from 'react';

interface Building {
  name: string;
  lat: number;
  lng: number;
  floors: number[];
}

interface BuildingMapProps {
  buildings: Building[];
  onBuildingSelect?: (building: Building) => void;
}

declare global {
  interface Window {
    kakao: any;
  }
}

export default function BuildingMap({ buildings, onBuildingSelect }: BuildingMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const kakaoKey = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY;
    if (!kakaoKey) {
      console.warn('NEXT_PUBLIC_KAKAO_MAP_KEY가 설정되지 않았습니다.');
      return;
    }

    // 카카오맵 SDK 로드
    if (window.kakao?.maps) {
      initMap();
      return;
    }

    const script = document.createElement('script');
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${kakaoKey}&autoload=false&libraries=services`;
    script.onload = () => {
      window.kakao.maps.load(() => {
        initMap();
      });
    };
    document.head.appendChild(script);
  }, []);

  const initMap = () => {
    if (!mapRef.current) return;

    const map = new window.kakao.maps.Map(mapRef.current, {
      center: new window.kakao.maps.LatLng(37.5665, 126.978),
      level: 5,
    });

    // 건물 마커 추가
    buildings.forEach((building) => {
      const marker = new window.kakao.maps.Marker({
        map,
        position: new window.kakao.maps.LatLng(building.lat, building.lng),
        title: building.name,
      });

      const infowindow = new window.kakao.maps.InfoWindow({
        content: `<div style="padding:5px;font-size:12px;">${building.name}</div>`,
      });

      window.kakao.maps.event.addListener(marker, 'click', () => {
        onBuildingSelect?.(building);
      });

      window.kakao.maps.event.addListener(marker, 'mouseover', () => {
        infowindow.open(map, marker);
      });

      window.kakao.maps.event.addListener(marker, 'mouseout', () => {
        infowindow.close();
      });
    });

    setMapLoaded(true);
  };

  const handleSearch = () => {
    if (!searchQuery || !window.kakao?.maps) return;

    const ps = new window.kakao.maps.services.Places();
    ps.keywordSearch(searchQuery, (data: any[], status: any) => {
      if (status === window.kakao.maps.services.Status.OK && data.length > 0) {
        const place = data[0];
        onBuildingSelect?.({
          name: place.place_name,
          lat: parseFloat(place.y),
          lng: parseFloat(place.x),
          floors: [],
        });
      }
    });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-2 p-2 bg-gray-800">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="건물 검색..."
          className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={handleSearch}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-1.5 rounded"
        >
          검색
        </button>
      </div>
      <div ref={mapRef} className="flex-1 min-h-[300px]">
        {!mapLoaded && (
          <div className="flex items-center justify-center h-full bg-gray-900 text-gray-500 text-sm">
            {process.env.NEXT_PUBLIC_KAKAO_MAP_KEY
              ? '지도 로딩 중...'
              : '카카오맵 API 키가 설정되지 않았습니다. (.env의 NEXT_PUBLIC_KAKAO_MAP_KEY)'}
          </div>
        )}
      </div>
    </div>
  );
}
