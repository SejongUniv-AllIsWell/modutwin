'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Building, BuildingListItem } from '@/types';
import { useAuth } from '@/lib/auth';
import {
  comparePriorityPlaceCandidates,
  type PriorityCoordinateOverride,
  resolveCanonicalPlace,
  scorePriorityPlaceName,
  sejongUniversityPlacePriority,
  type PriorityPlaceScore,
} from '@/lib/map/placePriority';
import { loadKakaoMapsSdk } from '@/lib/map/loadKakaoMapsSdk';

declare global {
  interface Window {
    kakao: any;
    __kakaoMapsSdkPromise__?: Promise<any>;
  }
}

type BuildingWithFloors = BuildingListItem;

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
  responseIndex: number;
  distance: number;
}

const DEFAULT_MAP_CENTER = sejongUniversityPlacePriority.center;

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

interface KakaoKeywordSearchResult {
  documents: KakaoPlaceResult[];
  isEnd: boolean;
}

const searchKeywordViaBackend = async (
  {
    query,
    x,
    y,
    radius,
    page = 1,
    size = 10,
    sort = 'accuracy',
  }: KakaoKeywordSearchOptions): Promise<KakaoKeywordSearchResult> => {
  const trimmed = query?.trim() ?? '';
  if (!trimmed) return { documents: [], isEnd: true };
  const params = new URLSearchParams({
    query: trimmed,
    page: String(Math.min(Math.max(page, 1), 45)),
    size: String(Math.min(Math.max(size, 1), 15)),
    sort,
  });
  if (Number.isFinite(x)) params.set('x', String(x));
  if (Number.isFinite(y)) params.set('y', String(y));
  if (typeof radius === 'number') params.set('radius', String(Math.min(Math.max(radius, 0), 20000)));
  const result = await api.get<{
    documents?: KakaoPlaceResult[];
    meta?: { is_end?: boolean };
  }>(`/kakao/search/keyword?${params.toString()}`);
  return {
    documents: result.documents ?? [],
    isEnd: Boolean(result.meta?.is_end ?? true),
  };
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

interface AddressQuery {
  query: string;
  buildingName: string | null;
}

const keywordForAddress = (document: KakaoCoord2AddressDocument | null): AddressQuery | null => {
  const buildingName = document?.road_address?.building_name?.trim();
  if (buildingName) {
    return { query: buildingName, buildingName };
  }
  const roadAddress = document?.road_address?.address_name?.trim();
  if (roadAddress) return { query: roadAddress, buildingName: null };
  const address = document?.address?.address_name?.trim();
  if (address) return { query: address, buildingName: null };
  return null;
};

export default function ExplorePage() {
  const router = useRouter();
  const { loading } = useAuth();
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
  const [searchPage, setSearchPage] = useState(1);
  const [searchIsEnd, setSearchIsEnd] = useState(true);
  const [searchedQuery, setSearchedQuery] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
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

  // 건물 목록 로드 — 백엔드 has_output 필터는
  //   (관리자가 표시관리에서 추가한 건물) OR (표시 중인 floor/module 에 SceneOutput 등록)
  // 둘 중 하나라도 만족하는 visible 건물을 내려준다.
  // floor_count 는 응답에 포함되므로 추가 fetch 없음.
  const fetchBuildings = useCallback(async () => {
    try {
      const data = await api.get<BuildingListItem[]>('/buildings?has_output=true');
      setBuildings(data);
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

      const scorePlaceCandidate = (
        place: KakaoPlaceResult,
        latLng: any,
        responseIndex: number,
      ): KakaoPlaceCandidate => {
        const placeName = place.place_name.trim();
        return {
          place,
          placeName,
          responseIndex,
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

      const findNearestPlaceByAddress = async (
        address: KakaoCoord2AddressDocument | null,
        latLng: any,
      ): Promise<KakaoPlaceResult | null> => {
        const queryInfo = keywordForAddress(address);
        if (!queryInfo) return null;
        const { query, buildingName } = queryInfo;

        const collected: KakaoPlaceResult[] = [];
        const seenIds = new Set<string>();
        for (let page = 1; page <= 45; page += 1) {
          const { documents, isEnd } = await searchKeywordViaBackend({
            query,
            x: latLng.getLng(),
            y: latLng.getLat(),
            radius: sejongUniversityPlacePriority.addressSearchRadiusMeters,
            sort: 'distance',
            size: 15,
            page,
          }).catch((): KakaoKeywordSearchResult => ({ documents: [], isEnd: true }));
          for (const place of documents) {
            if (!seenIds.has(place.id)) {
              seenIds.add(place.id);
              collected.push(place);
            }
          }
          if (isEnd || documents.length === 0) break;
        }

        const filtered = buildingName
          ? collected.filter((place) => place.place_name.includes(buildingName))
          : collected;

        return filtered
          .map((place, index) => scorePlaceCandidate(place, latLng, index))
          // 캠퍼스 키워드 자체 ("세종대학교" 등) 만 매칭된 plain 항목은 건물 후보에서 제외 —
          // 구체적인 건물명 (예: "세종대학교 광개토관") 만 의미 있음.
          .filter(({ isCampusOnlyName }) => !isCampusOnlyName)
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
        const canonical = resolveCanonicalPlace(place.place_name);
        const displayName = canonical?.canonicalName ?? place.place_name;
        showSelectedMarker(displayName, lat, lng);
        showToast(`선택됨: ${displayName}`);
        await routeBuildingByLookup({
          building_name: displayName,
          lookup_names: canonical?.aliases,
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
        content: `<div style="padding:8px 12px;font-size:13px;font-weight:600;white-space:nowrap;color:#111;">${escapeHtml(building.name)}<br/><span style="font-size:11px;font-weight:400;color:#666;">${building.floor_count}개 층</span></div>`,
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
      setSearchedQuery('');
      setSearchPage(1);
      setSearchIsEnd(true);
      return;
    }
    const kakao = kakaoRef.current;
    if (!mapInstance.current || !kakao) {
      showToast('지도가 아직 준비되지 않았습니다.');
      return;
    }
    try {
      const { documents, isEnd } = await searchKeywordViaBackend({ query, size: 15, page: 1 });
      if (documents.length === 0) {
        setPlaceResults([]);
        setSearchedQuery(query);
        setSearchPage(1);
        setSearchIsEnd(true);
        showToast('검색 결과가 없습니다.');
        return;
      }
      setPlaceResults(documents);
      setSearchedQuery(query);
      setSearchPage(1);
      setSearchIsEnd(isEnd);
      const first = documents[0];
      const lat = Number(first.y);
      const lng = Number(first.x);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        mapInstance.current.setCenter(new kakao.maps.LatLng(lat, lng));
      }
    } catch (error: any) {
      setPlaceResults([]);
      setSearchedQuery(query);
      setSearchPage(1);
      setSearchIsEnd(true);
      showToast(error?.message || '검색에 실패했습니다.');
    }
  };

  const handleLoadMore = async () => {
    if (loadingMore || searchIsEnd || !searchedQuery) return;
    const nextPage = searchPage + 1;
    if (nextPage > 45) {
      setSearchIsEnd(true);
      return;
    }
    setLoadingMore(true);
    try {
      const { documents, isEnd } = await searchKeywordViaBackend({
        query: searchedQuery,
        size: 15,
        page: nextPage,
      });
      if (documents.length > 0) {
        setPlaceResults((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const appended = documents.filter((p) => !existingIds.has(p.id));
          return appended.length > 0 ? [...prev, ...appended] : prev;
        });
      }
      setSearchPage(nextPage);
      setSearchIsEnd(isEnd || documents.length === 0);
    } catch (error: any) {
      showToast(error?.message || '추가 결과를 불러오지 못했습니다.');
    } finally {
      setLoadingMore(false);
    }
  };

  const handlePlaceSelect = async (place: KakaoPlaceResult) => {
    try {
      const canonical = resolveCanonicalPlace(place.place_name);
      await routeBuildingByLookup({
        building_name: canonical?.canonicalName ?? place.place_name,
        lookup_names: canonical?.aliases,
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
      <div
        className="w-80 flex flex-col border-r shrink-0"
        style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
      >
        <div className="p-3 border-b" style={{ borderColor: 'var(--rule)' }}>
          <div className="relative flex items-center">
            <svg
              className="absolute left-3 w-4 h-4 pointer-events-none"
              style={{ color: 'var(--muted)' }}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              placeholder="건물 검색"
              className="w-full border rounded-sm pl-9 pr-3 py-2 text-sm focus:outline-none transition"
              style={{
                background: 'var(--bg)',
                borderColor: 'var(--rule)',
                color: 'var(--ink)',
              }}
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setPlaceResults([]);
                  setSearchedQuery('');
                  setSearchPage(1);
                  setSearchIsEnd(true);
                }}
                className="absolute right-3 hover:opacity-70"
                style={{ color: 'var(--muted)' }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="px-4 py-2.5 border-b" style={{ borderColor: 'var(--rule)' }}>
          <p
            className="text-xs font-medium uppercase tracking-wider"
            style={{ color: 'var(--muted)', fontFamily: 'ui-monospace, Menlo, monospace' }}
          >
            {placeResults.length > 0 ? `카카오 검색 결과 (${placeResults.length})` : '건물 목록'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {placeResults.length > 0 ? (
            <div className="divide-y" style={{ borderColor: 'var(--rule-soft)' }}>
              {placeResults.map((place) => (
                <button
                  key={place.id}
                  onClick={() => handlePlaceSelect(place)}
                  className="w-full text-left px-4 py-3.5 hover:bg-[var(--bg-soft)] transition group"
                  style={{ borderColor: 'var(--rule-soft)' }}
                >
                  <p
                    className="text-sm font-medium truncate"
                    style={{ color: 'var(--ink)' }}
                  >
                    {place.place_name}
                  </p>
                  <p
                    className="text-xs mt-0.5 truncate"
                    style={{ color: 'var(--muted)' }}
                  >
                    {place.road_address_name || place.address_name}
                  </p>
                </button>
              ))}
              {!searchIsEnd && (
                <button
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="w-full px-4 py-3 text-sm hover:bg-[var(--bg-soft)] transition disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ color: 'var(--muted)' }}
                >
                  {loadingMore ? '불러오는 중...' : '더 보기'}
                </button>
              )}
            </div>
          ) : displayBuildings.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center h-full py-16"
              style={{ color: 'var(--muted-2)' }}
            >
              <svg className="w-12 h-12 mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <p className="text-sm">
                등록된 건물이 없습니다
              </p>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--rule-soft)' }}>
              {displayBuildings.map((building) => (
                <button
                  key={building.id}
                  onClick={() => router.push(`/buildings/${building.id}`)}
                  className="w-full text-left px-4 py-3.5 hover:bg-[var(--bg-soft)] transition group"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="shrink-0 w-9 h-9 rounded-md flex items-center justify-center"
                      style={{ background: 'var(--bg-soft)', color: 'var(--ink)' }}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p
                        className="text-sm font-medium truncate"
                        style={{ color: 'var(--ink)' }}
                      >
                        {building.name}
                      </p>
                    </div>
                    <svg
                      className="w-4 h-4 transition shrink-0"
                      style={{ color: 'var(--muted-2)' }}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
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
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: 'var(--paper)', color: 'var(--muted)' }}
          >
            <div className="text-center">
              {mapError ? (
                <p className="text-sm" style={{ color: '#b04646' }}>지도를 불러오지 못했습니다</p>
              ) : !process.env.NEXT_PUBLIC_KAKAO_MAP_KEY ? (
                <p className="text-sm">카카오맵 API 키가 설정되지 않았습니다</p>
              ) : (
                <>
                  <div
                    className="w-8 h-8 border-2 rounded-full animate-spin mx-auto mb-3"
                    style={{ borderColor: 'var(--rule)', borderTopColor: 'transparent' }}
                  />
                  <p className="text-sm">지도 로딩 중...</p>
                </>
              )}
            </div>
          </div>
        )}
        {toast && (
          <div
            className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-sm border text-xs"
            style={{
              background: 'var(--paper)',
              borderColor: 'var(--rule)',
              color: 'var(--ink)',
            }}
          >
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
