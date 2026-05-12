'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Building, Floor } from '@/types';
import { useAuth } from '@/lib/auth';
import {
  comparePriorityPlaceCandidates,
  type PriorityCoordinateOverride,
  scorePriorityPlaceName,
  sejongUniversityPlacePriority,
  type PriorityPlaceScore,
} from '@/lib/map/placePriority';

declare global {
  interface Window {
    kakao: any;
    __kakaoMapsSdkPromise__?: Promise<any>;
  }
}

interface BuildingWithFloors extends Building {
  floorCount: number;
}

interface KakaoPlaceResult {
  id: string;
  place_name: string;
  address_name: string;
  road_address_name: string;
  x: string;
  y: string;
  distance?: string;
}

interface KakaoCoord2AddressDocument {
  address?: {
    address_name?: string;
    region_1depth_name?: string;
    region_2depth_name?: string;
    region_3depth_name?: string;
    main_address_no?: string;
  };
  road_address?: {
    address_name?: string;
    region_1depth_name?: string;
    region_2depth_name?: string;
    region_3depth_name?: string;
    road_name?: string;
    building_name?: string;
  };
}

interface BuildingLookupResponse {
  building: Building | null;
}

type KakaoKeywordSort = 'accuracy' | 'distance';

interface KakaoKeywordSearchOptions {
  query: string;
  x?: number;
  y?: number;
  radius?: number;
  page?: number;
  size?: number;
  sort?: KakaoKeywordSort;
}

interface MarkerBinding {
  marker: any;
  onMouseOver: () => void;
  onMouseOut: () => void;
  onClick: () => void;
}

interface Coordinate {
  lat: number;
  lng: number;
}

interface KakaoPlaceCandidate extends PriorityPlaceScore {
  place: KakaoPlaceResult;
  placeName: string;
  distance: number;
}

const KAKAO_SDK_URL = 'https://dapi.kakao.com/v2/maps/sdk.js';
const DEFAULT_MAP_CENTER = sejongUniversityPlacePriority.center;

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const loadKakaoMapsSdk = (appKey: string) => {
  if (window.kakao?.maps) {
    return new Promise<any>((resolve) => {
      window.kakao.maps.load(() => resolve(window.kakao));
    });
  }
  if (window.__kakaoMapsSdkPromise__) return window.__kakaoMapsSdkPromise__;

  window.__kakaoMapsSdkPromise__ = new Promise<any>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src^="${KAKAO_SDK_URL}"]`);
    const onReady = () => {
      window.kakao.maps.load(() => resolve(window.kakao));
    };
    const onError = () => {
      window.__kakaoMapsSdkPromise__ = undefined;
      reject(new Error('Kakao Maps SDK load failed'));
    };

    if (existing) {
      if (window.kakao?.maps) {
        onReady();
        return;
      }
      existing.addEventListener('load', onReady, { once: true });
      existing.addEventListener('error', onError, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = `${KAKAO_SDK_URL}?appkey=${appKey}&autoload=false&libraries=services`;
    script.addEventListener('load', onReady, { once: true });
    script.addEventListener('error', onError, { once: true });
    document.head.appendChild(script);
  });

  return window.__kakaoMapsSdkPromise__;
};

const searchKeywordViaBackend = async (
  {
    query,
    x,
    y,
    radius,
    page = 1,
    size = 10,
    sort = 'accuracy',
  }: KakaoKeywordSearchOptions): Promise<KakaoPlaceResult[]> => {
  const trimmed = query?.trim() ?? '';
  if (!trimmed) return [];
  const params = new URLSearchParams({
    query: trimmed,
    page: String(Math.min(Math.max(page, 1), 45)),
    size: String(Math.min(Math.max(size, 1), 15)),
    sort,
  });
  if (Number.isFinite(x)) params.set('x', String(x));
  if (Number.isFinite(y)) params.set('y', String(y));
  if (typeof radius === 'number') params.set('radius', String(Math.min(Math.max(radius, 0), 20000)));
  const result = await api.get<{ documents?: KakaoPlaceResult[] }>(`/kakao/search/keyword?${params.toString()}`);
  return result.documents ?? [];
};

const coord2AddressViaBackend = async (x: number, y: number): Promise<KakaoCoord2AddressDocument[]> => {
  const params = new URLSearchParams({ x: String(x), y: String(y) });
  const result = await api.get<{ documents?: KakaoCoord2AddressDocument[] }>(`/kakao/geo/coord2address?${params.toString()}`);
  return result.documents ?? [];
};

const coordinateForBuilding = (building: Building): Coordinate | null => {
  const lat = Number(building.latitude);
  const lng = Number(building.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
};

const keywordForAddress = (document: KakaoCoord2AddressDocument | null): string | null => {
  const roadAddress = document?.road_address?.address_name?.trim();
  if (roadAddress) return roadAddress;
  const address = document?.address?.address_name?.trim();
  return address || null;
};

export default function ExplorePage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);
  const kakaoRef = useRef<any>(null);
  const markersRef = useRef<MarkerBinding[]>([]);
  const selectedMarkerRef = useRef<any>(null);
  const selectedInfoWindowRef = useRef<any>(null);
  const buildingsRef = useRef<BuildingWithFloors[]>([]);
  const mapClickInFlightRef = useRef(false);

  const [buildings, setBuildings] = useState<BuildingWithFloors[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [placeResults, setPlaceResults] = useState<KakaoPlaceResult[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    buildingsRef.current = buildings;
  }, [buildings]);

  const navigateFromMap = useCallback((path: string) => {
    router.push(path);
    window.setTimeout(() => {
      if (window.location.pathname === '/explore') {
        window.location.assign(path);
      }
    }, 150);
  }, [router]);

  const pushPendingBuilding = useCallback((payload: {
    building_name: string;
    place_id?: string | null;
    address_name?: string | null;
    road_address_name?: string | null;
    lat?: number | null;
    lng?: number | null;
  }) => {
    const qs = new URLSearchParams({ building_name: payload.building_name });
    if (payload.place_id) qs.set('place_id', payload.place_id);
    if (payload.address_name) qs.set('address_name', payload.address_name);
    if (payload.road_address_name) qs.set('road_address_name', payload.road_address_name);
    if (Number.isFinite(payload.lat)) qs.set('lat', String(payload.lat));
    if (Number.isFinite(payload.lng)) qs.set('lng', String(payload.lng));
    navigateFromMap(`/buildings/pending?${qs.toString()}`);
  }, [navigateFromMap]);

  const routeBuildingByLookup = useCallback(async (payload: {
    building_name: string;
    lookup_names?: string[];
    place_id?: string | null;
    address_name?: string | null;
    road_address_name?: string | null;
    lat?: number | null;
    lng?: number | null;
  }) => {
    const lookupNames = Array.from(new Set([
      payload.building_name,
      ...(payload.lookup_names ?? []),
    ].map((name) => name.trim()).filter(Boolean)));
    const qs = new URLSearchParams();
    if (payload.place_id) qs.set('kakao_place_id', payload.place_id);
    qs.set('name', lookupNames[0] ?? payload.building_name);
    const lookup = await api.get<BuildingLookupResponse>(`/buildings/lookup?${qs.toString()}`);
    if (lookup.building) {
      navigateFromMap(`/buildings/${lookup.building.id}`);
      return;
    }
    for (const lookupName of lookupNames.slice(1)) {
      const aliasQs = new URLSearchParams({ name: lookupName });
      const aliasLookup = await api.get<BuildingLookupResponse>(`/buildings/lookup?${aliasQs.toString()}`);
      if (aliasLookup.building) {
        navigateFromMap(`/buildings/${aliasLookup.building.id}`);
        return;
      }
    }
    pushPendingBuilding(payload);
  }, [navigateFromMap, pushPendingBuilding]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => {
      setToast((current) => (current === text ? null : current));
    }, 2200);
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

  // 건물 목록 로드 — 백엔드의 has_output 필터로 visible 조건을 만족하는 것만 내려옴
  const fetchBuildings = useCallback(async () => {
    try {
      const data = await api.get<Building[]>('/buildings?has_output=true');
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
    } catch {
      // 무시
    }
  }, []);

  useEffect(() => {
    fetchBuildings();
  }, [fetchBuildings]);

  // 다른 탭/관리자 대시보드에서 visibility 가 바뀌었을 수 있으므로
  // 창 포커스 또는 탭이 다시 보일 때 최신 목록으로 갱신.
  useEffect(() => {
    const onFocus = () => fetchBuildings();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchBuildings();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchBuildings]);

  const displayBuildings = useMemo(() => buildings, [buildings]);

  // 카카오맵 초기화
  useEffect(() => {
    if (loading) return;
    const kakaoKey = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY;
    if (!kakaoKey) return;

    let disposed = false;
    let clickHandler: ((mouseEvent: any) => Promise<void>) | null = null;
    let currentMap: any = null;

    const clearSelectedMarker = () => {
      selectedMarkerRef.current?.setMap(null);
      selectedInfoWindowRef.current?.close?.();
      selectedMarkerRef.current = null;
      selectedInfoWindowRef.current = null;
    };

    const initMap = (kakao: any) => {
      if (!mapRef.current || disposed) return;
      const map = new kakao.maps.Map(mapRef.current, {
        center: new kakao.maps.LatLng(DEFAULT_MAP_CENTER.lat, DEFAULT_MAP_CENTER.lng),
        level: 3,
      });
      mapInstance.current = map;
      kakaoRef.current = kakao;
      currentMap = map;

      const showSelectedMarker = (name: string, lat: number, lng: number) => {
        clearSelectedMarker();
        const position = new kakao.maps.LatLng(lat, lng);
        const marker = new kakao.maps.Marker({ map, position, title: name });
        const escapedName = escapeHtml(name);
        const infoWindow = new kakao.maps.InfoWindow({
          content: `<div style="padding:7px 10px;font-size:12px;font-weight:600;white-space:nowrap;color:#111;">선택됨: ${escapedName}</div>`,
        });
        infoWindow.open(map, marker);
        selectedMarkerRef.current = marker;
        selectedInfoWindowRef.current = infoWindow;
      };

      const coord2Address = (latLng: any) => (
        coord2AddressViaBackend(latLng.getLng(), latLng.getLat())
      );

      const distanceMeters = (place: KakaoPlaceResult, latLng: any) => {
        const explicit = Number(place.distance);
        if (Number.isFinite(explicit) && explicit >= 0) return explicit;
        const lat1 = latLng.getLat() * Math.PI / 180;
        const lat2 = Number(place.y) * Math.PI / 180;
        const dLat = lat2 - lat1;
        const dLng = (Number(place.x) - latLng.getLng()) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      const distanceFromCoordinate = (coordinate: Coordinate, latLng: any) => distanceMeters({
        id: 'coordinate',
        place_name: '',
        address_name: '',
        road_address_name: '',
        x: String(coordinate.lng),
        y: String(coordinate.lat),
      }, latLng);

      const scorePlaceCandidate = (place: KakaoPlaceResult, latLng: any): KakaoPlaceCandidate => {
        const placeName = place.place_name.trim();
        return {
          place,
          placeName,
          distance: distanceMeters(place, latLng),
          ...scorePriorityPlaceName(placeName),
        };
      };

      const findCoordinateOverrideAt = (latLng: any): PriorityCoordinateOverride | null => (
        sejongUniversityPlacePriority.coordinateOverrides
          ?.map((override) => ({
            override,
            distance: distanceFromCoordinate({ lat: override.lat, lng: override.lng }, latLng),
          }))
          .filter(({ override, distance }) => (
            Number.isFinite(distance)
            && distance <= override.radiusMeters
          ))
          .sort((a, b) => a.distance - b.distance)[0]?.override ?? null
      );

      const findNearestSejongUniversityPlace = async (latLng: any): Promise<KakaoPlaceResult | null> => {
        const campusDistance = distanceFromCoordinate(DEFAULT_MAP_CENTER, latLng);
        if (campusDistance > sejongUniversityPlacePriority.campusRadiusMeters) return null;

        const places = await searchKeywordViaBackend({
          query: sejongUniversityPlacePriority.campusKeyword,
          x: latLng.getLng(),
          y: latLng.getLat(),
          radius: sejongUniversityPlacePriority.placeSearchRadiusMeters,
          sort: 'distance',
          size: 15,
        }).catch((): KakaoPlaceResult[] => []);

        return places
          .map((place) => scorePlaceCandidate(place, latLng))
          .filter(({ placeName, distance }) => (
            placeName.includes(sejongUniversityPlacePriority.campusKeyword)
            && placeName.length >= 2
            && Number.isFinite(distance)
            && distance <= sejongUniversityPlacePriority.placeSearchRadiusMeters
          ))
          .sort(comparePriorityPlaceCandidates)[0]?.place ?? null;
      };

      const findNearestPlaceByAddress = async (
        address: KakaoCoord2AddressDocument | null,
        latLng: any,
      ): Promise<KakaoPlaceResult | null> => {
        const query = keywordForAddress(address);
        if (!query) return null;
        const places = await searchKeywordViaBackend({
          query,
          x: latLng.getLng(),
          y: latLng.getLat(),
          radius: sejongUniversityPlacePriority.addressSearchRadiusMeters,
          sort: 'distance',
          size: 15,
        }).catch((): KakaoPlaceResult[] => []);
        return places
          .map((place) => scorePlaceCandidate(place, latLng))
          .filter(({ placeName, distance }) => (
            placeName.length >= 2
            && Number.isFinite(distance)
            && distance <= sejongUniversityPlacePriority.addressSearchRadiusMeters
          ))
          .sort(comparePriorityPlaceCandidates)[0]?.place ?? null;
      };

      const findRegisteredBuildingAt = (latLng: any) => buildingsRef.current
        .map((building) => {
          const coordinate = coordinateForBuilding(building);
          if (!coordinate) return null;
          return {
            building,
            coordinate,
            distance: distanceFromCoordinate(coordinate, latLng),
          };
        })
        .filter((candidate): candidate is {
          building: BuildingWithFloors;
          coordinate: Coordinate;
          distance: number;
        } => Boolean(candidate && candidate.distance <= 45))
        .sort((a, b) => a.distance - b.distance)[0] ?? null;

      const openRegisteredBuilding = (candidate: {
        building: BuildingWithFloors;
        coordinate: Coordinate;
      }) => {
        showSelectedMarker(candidate.building.name, candidate.coordinate.lat, candidate.coordinate.lng);
        showToast(`선택됨: ${candidate.building.name}`);
        navigateFromMap(`/buildings/${candidate.building.id}`);
      };

      const createBuildingFromAddress = async (name: string, address: any, latLng: any) => {
        showSelectedMarker(name, latLng.getLat(), latLng.getLng());
        showToast(`선택됨: ${name}`);
        await routeBuildingByLookup({
          building_name: name,
          address_name: address?.address?.address_name ?? null,
          road_address_name: address?.road_address?.address_name ?? null,
          lat: latLng.getLat(),
          lng: latLng.getLng(),
        });
      };

      const createBuildingFromPlace = async (place: KakaoPlaceResult) => {
        const lat = Number(place.y);
        const lng = Number(place.x);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          showToast('선택한 건물의 좌표가 올바르지 않습니다.');
          return;
        }
        showSelectedMarker(place.place_name, lat, lng);
        showToast(`선택됨: ${place.place_name}`);
        await routeBuildingByLookup({
          building_name: place.place_name,
          place_id: place.id,
          address_name: place.address_name || null,
          road_address_name: place.road_address_name || null,
          lat,
          lng,
        });
      };

      const createBuildingFromCoordinateOverride = async (override: PriorityCoordinateOverride) => {
        showSelectedMarker(override.name, override.lat, override.lng);
        showToast(`선택됨: ${override.name}`);
        await routeBuildingByLookup({
          building_name: override.name,
          lookup_names: override.aliases,
          address_name: override.address_name ?? null,
          road_address_name: override.road_address_name ?? null,
          lat: override.lat,
          lng: override.lng,
        });
      };

      clickHandler = async (_mouseEvent: any) => {
        if (disposed) return;
        if (mapClickInFlightRef.current) return;
        mapClickInFlightRef.current = true;
        const latLng = _mouseEvent.latLng;
        try {
          const coordinateOverride = findCoordinateOverrideAt(latLng);
          if (coordinateOverride) {
            await createBuildingFromCoordinateOverride(coordinateOverride);
            return;
          }
          const registeredBuilding = findRegisteredBuildingAt(latLng);
          if (registeredBuilding) {
            openRegisteredBuilding(registeredBuilding);
            return;
          }
          const sejongPlace = await findNearestSejongUniversityPlace(latLng);
          if (sejongPlace) {
            await createBuildingFromPlace(sejongPlace);
            return;
          }
          const addresses = await coord2Address(latLng);
          const first = addresses[0] ?? null;
          const nearestPlace = await findNearestPlaceByAddress(first, latLng);
          if (nearestPlace) {
            await createBuildingFromPlace(nearestPlace);
            return;
          }
          const buildingName = first?.road_address?.building_name?.trim();
          if (buildingName && buildingName.length >= 2) {
            await createBuildingFromAddress(buildingName, first, latLng);
            return;
          }
          showToast('해당 위치의 건물명을 찾지 못했습니다.');
        } catch (error: any) {
          showToast(error?.message || '건물을 선택할 수 없습니다.');
        } finally {
          mapClickInFlightRef.current = false;
        }
      };
      kakao.maps.event.addListener(map, 'click', clickHandler);
      setMapLoaded(true);
    };

    loadKakaoMapsSdk(kakaoKey)
      .then((kakao) => {
        if (!disposed) {
          setMapError(false);
          initMap(kakao);
        }
      })
      .catch(() => {
        if (!disposed) {
          setMapError(true);
        }
      });

    return () => {
      disposed = true;
      if (currentMap && clickHandler) {
        window.kakao?.maps?.event?.removeListener(currentMap, 'click', clickHandler);
      }
      clearSelectedMarker();
      mapInstance.current = null;
      kakaoRef.current = null;
    };
  }, [loading, navigateFromMap, routeBuildingByLookup, showToast]);

  // 마커 등록
  useEffect(() => {
    const kakao = kakaoRef.current;
    if (!mapLoaded || !mapInstance.current || !kakao) return;

    markersRef.current.forEach(({ marker, onMouseOver, onMouseOut, onClick }) => {
      window.kakao.maps.event.removeListener(marker, 'mouseover', onMouseOver);
      window.kakao.maps.event.removeListener(marker, 'mouseout', onMouseOut);
      window.kakao.maps.event.removeListener(marker, 'click', onClick);
      marker.setMap(null);
    });
    markersRef.current = [];

    if (buildings.length === 0) return;

    const map = mapInstance.current;
    buildings.forEach((building) => {
      const coordinate = coordinateForBuilding(building);
      if (!coordinate) return;

      const position = new window.kakao.maps.LatLng(coordinate.lat, coordinate.lng);
      const marker = new window.kakao.maps.Marker({ map, position, title: building.name });

      const infowindow = new window.kakao.maps.InfoWindow({
        content: `<div style="padding:8px 12px;font-size:13px;font-weight:600;white-space:nowrap;color:#111;">${escapeHtml(building.name)}<br/><span style="font-size:11px;font-weight:400;color:#666;">${building.floorCount}개 층</span></div>`,
      });

      const onMouseOver = () => infowindow.open(map, marker);
      const onMouseOut = () => infowindow.close();
      const onClick = () => {
        navigateFromMap(`/buildings/${building.id}`);
      };
      window.kakao.maps.event.addListener(marker, 'mouseover', onMouseOver);
      window.kakao.maps.event.addListener(marker, 'mouseout', onMouseOut);
      window.kakao.maps.event.addListener(marker, 'click', onClick);

      markersRef.current.push({ marker, onMouseOver, onMouseOut, onClick });
    });

    return () => {
      markersRef.current.forEach(({ marker, onMouseOver, onMouseOut, onClick }) => {
        window.kakao.maps.event.removeListener(marker, 'mouseover', onMouseOver);
        window.kakao.maps.event.removeListener(marker, 'mouseout', onMouseOut);
        window.kakao.maps.event.removeListener(marker, 'click', onClick);
        marker.setMap(null);
      });
      markersRef.current = [];
    };
  }, [mapLoaded, buildings, navigateFromMap]);

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) {
      setPlaceResults([]);
      return;
    }
    const kakao = kakaoRef.current;
    if (!mapInstance.current || !kakao) {
      showToast('지도가 아직 준비되지 않았습니다.');
      return;
    }
    try {
      const result = await searchKeywordViaBackend({ query, size: 10 });
      if (result.length === 0) {
        setPlaceResults([]);
        showToast('검색 결과가 없습니다.');
        return;
      }
      setPlaceResults(result);
      const first = result[0];
      const lat = Number(first.y);
      const lng = Number(first.x);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        mapInstance.current.setCenter(new kakao.maps.LatLng(lat, lng));
      }
    } catch (error: any) {
      setPlaceResults([]);
      showToast(error?.message || '검색에 실패했습니다.');
    }
  };

  const handlePlaceSelect = async (place: KakaoPlaceResult) => {
    try {
      await routeBuildingByLookup({
        building_name: place.place_name,
        place_id: place.id,
        address_name: place.address_name || null,
        road_address_name: place.road_address_name || null,
        lat: Number(place.y),
        lng: Number(place.x),
      });
    } catch (error: any) {
      showToast(error?.message || '건물 확인에 실패했습니다.');
    }
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
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              placeholder="건물 검색..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition"
            />
            {searchQuery && (
              <button onClick={() => { setSearchQuery(''); setPlaceResults([]); }} className="absolute right-3 text-gray-500 hover:text-gray-300">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="px-4 py-2.5 border-b border-gray-800">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            {placeResults.length > 0 ? `카카오 검색 결과 (${placeResults.length})` : `건물 목록 (${displayBuildings.length})`}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {placeResults.length > 0 ? (
            <div className="divide-y divide-gray-800/60">
              {placeResults.map((place) => (
                <button
                  key={place.id}
                  onClick={() => handlePlaceSelect(place)}
                  className="w-full text-left px-4 py-3.5 hover:bg-gray-800/70 transition group"
                >
                  <p className="text-sm font-medium text-gray-200 truncate group-hover:text-white transition">
                    {place.place_name}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                    {place.road_address_name || place.address_name}
                  </p>
                </button>
              ))}
            </div>
          ) : displayBuildings.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-16 text-gray-600">
              <svg className="w-12 h-12 mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <p className="text-sm">
                등록된 건물이 없습니다
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-800/60">
              {displayBuildings.map((building) => (
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
        {toast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded bg-gray-900/95 border border-gray-700 text-xs text-gray-100">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
