'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { FloorOverviewManifest, FloorOverviewManifestEntry } from '@/types';

const floorLabel = (n: number) => (n >= 0 ? `F${n}` : `B${Math.abs(n)}`);

export default function BuildingOverviewPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const buildingId = params.name as string;
  const isPendingBuilding = buildingId === 'pending';
  const { user, loading } = useAuth();

  const [manifest, setManifest] = useState<FloorOverviewManifest | null>(null);
  const [hoveredFloorId, setHoveredFloorId] = useState<string | null>(null);
  const [brokenImageByFloorId, setBrokenImageByFloorId] = useState<Record<string, boolean>>({});
  const [openFloorMenuId, setOpenFloorMenuId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [registerPurpose, setRegisterPurpose] = useState<'basemap' | 'module' | null>(null);
  const [registerFloor, setRegisterFloor] = useState<FloorOverviewManifestEntry | null>(null);
  const [floorInputValue, setFloorInputValue] = useState('');
  const [nameInputValue, setNameInputValue] = useState('');
  const [floorInputError, setFloorInputError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (!buildingId) return;
    if (isPendingBuilding) {
      const pendingName = searchParams.get('building_name')?.trim() || 'Pending Building';
      setManifest({
        building_id: 'pending',
        building_name: pendingName,
        building_is_confirmed: false,
        generated_at: new Date().toISOString(),
        floors: [],
      });
      return;
    }
    api.get<FloorOverviewManifest>(`/buildings/${buildingId}/floor-overview`).then(setManifest).catch(() => {
      setManifest(null);
    });
  }, [buildingId, isPendingBuilding, searchParams]);

  const floors = useMemo(
    () => [...(manifest?.floors ?? [])].sort((a, b) => b.floor_number - a.floor_number),
    [manifest]
  );

  const parseFloorNumber = (raw: string): number | null => {
    const value = raw.trim();
    if (!value) return null;
    const basementMatch = value.match(/^B(\d+)$/i);
    if (basementMatch) {
      const n = Number(basementMatch[1]);
      if (!Number.isInteger(n) || n <= 0) return null;
      return -n;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed === 0) return null;
    return parsed;
  };

  const ensureFloor = async (floorNumber: number): Promise<{ id?: string; floor_number: number }> => {
    const existing = floors.find((f) => f.floor_number === floorNumber);
    if (existing) return { id: existing.floor_id, floor_number: existing.floor_number };
    return { floor_number: floorNumber };
  };

  const closeRegisterModal = () => {
    setRegisterPurpose(null);
    setRegisterFloor(null);
    setFloorInputValue('');
    setNameInputValue('');
    setFloorInputError(null);
  };

  const openRegisterModal = (purpose: 'basemap' | 'module', floor?: FloorOverviewManifestEntry) => {
    setAddMenuOpen(false);
    setOpenFloorMenuId(null);
    setRegisterPurpose(purpose);
    setRegisterFloor(floor ?? null);
    setFloorInputValue(floor ? floorLabel(floor.floor_number) : '');
    setNameInputValue('');
    setFloorInputError(null);
  };

  const handleRegisterFromPlus = async () => {
    if (!registerPurpose) return;
    const floorNumber = registerFloor?.floor_number ?? parseFloorNumber(floorInputValue);
    if (floorNumber === null) {
      setFloorInputError('유효한 층 번호를 입력하세요. 예: 1, -1, B1');
      return;
    }
    const registrationName = nameInputValue.trim();
    if (!registrationName) {
      setFloorInputError(registerPurpose === 'basemap' ? '저장할 이름을 입력하세요.' : '모듈 이름을 입력하세요.');
      return;
    }
    try {
      const floor = registerFloor
        ? { id: registerFloor.floor_id, floor_number: registerFloor.floor_number }
        : await ensureFloor(floorNumber);
      const qs = new URLSearchParams({
        purpose: registerPurpose,
        building_name: manifest?.building_name ?? 'Building',
        floor_number: String(floor.floor_number),
        module_name: registrationName,
      });
      if (!isPendingBuilding) qs.set('building_id', buildingId);
      if (floor.id) qs.set('floor_id', floor.id);
      if (isPendingBuilding) {
        const placeId = searchParams.get('place_id');
        const addressName = searchParams.get('address_name');
        const roadAddressName = searchParams.get('road_address_name');
        const lat = searchParams.get('lat');
        const lng = searchParams.get('lng');
        if (placeId) qs.set('place_id', placeId);
        if (addressName) qs.set('address_name', addressName);
        if (roadAddressName) qs.set('road_address_name', roadAddressName);
        if (lat) qs.set('lat', lat);
        if (lng) qs.set('lng', lng);
      }
      closeRegisterModal();
      router.push(`/viewer?${qs.toString()}`);
    } catch (error: any) {
      window.alert(error?.message || '뷰어 이동에 실패했습니다.');
    }
  };

  if (loading) return null;

  return (
    <div className="h-[calc(100vh-56px)] bg-gray-950 text-gray-100 flex">
      <aside className="w-80 border-r border-gray-800 bg-gray-900/70 p-4 flex flex-col shrink-0">
        <button type="button" onClick={() => router.push('/explore')} className="text-sm text-gray-400 hover:text-white transition self-start">
          Back to Explore
        </button>
        <div className="mt-4">
          <h1 className="text-base font-semibold truncate">{manifest?.building_name ?? 'Building'}</h1>
          <p className="mt-1 text-xs text-gray-500">Floors: {floors.length}</p>
          <p className="mt-1 text-xs text-gray-500">
            상태: {manifest?.building_is_confirmed ? '확정' : '미확정'}
          </p>
        </div>

        <div className="mt-4 flex-1 overflow-y-auto space-y-1">
          {floors.map((floor) => (
            <div key={floor.floor_id} className="rounded border border-gray-800 bg-gray-950">
              <div className="px-2 py-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => router.push(`/buildings/${buildingId}/floors/${floor.floor_number}`)}
                  className="flex-1 text-left text-sm text-gray-200 hover:text-white"
                >
                  {floorLabel(floor.floor_number)}
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setOpenFloorMenuId((prev) => (prev === floor.floor_id ? null : floor.floor_id))}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-white"
                  >
                    ⋮
                  </button>
                  {openFloorMenuId === floor.floor_id && (
                    <div className="absolute right-0 top-8 z-10 w-28 rounded border border-gray-700 bg-gray-900 shadow-lg p-1">
                      {!floor.has_active_basemap && (
                        <button
                          type="button"
                          onClick={() => {
                            openRegisterModal('basemap', floor);
                          }}
                          className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-gray-800"
                        >
                          basemap 등록
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          openRegisterModal('module', floor);
                        }}
                        className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-gray-800"
                      >
                        module 등록
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          <div className="space-y-2">
            <button
              type="button"
              disabled={manifest?.building_is_confirmed}
              onClick={() => setAddMenuOpen((prev) => !prev)}
              className="w-full rounded border border-gray-700 px-3 py-2 text-sm text-left hover:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              + 등록
            </button>
            {addMenuOpen && !manifest?.building_is_confirmed && (
              <div className="rounded border border-gray-700 bg-gray-900 p-1 space-y-1">
                <button
                  type="button"
                  onClick={() => {
                    openRegisterModal('basemap');
                  }}
                  className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-gray-800"
                >
                  basemap 등록
                </button>
                <button
                  type="button"
                  onClick={() => {
                    openRegisterModal('module');
                  }}
                  className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-gray-800"
                >
                  module 등록
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="flex-1 h-full overflow-y-auto px-4 pt-4 pb-8 lg:px-8 lg:pt-6 lg:pb-12 [perspective:1200px] [scrollbar-width:thin] [scrollbar-color:#374151_#11182766] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-gray-900/40 [&::-webkit-scrollbar-thumb]:bg-gray-700 [&::-webkit-scrollbar-thumb]:rounded-full">
        <div className="mx-auto max-w-5xl min-h-full pt-1 lg:pt-2 pr-1">
          {floors.map((floor, idx) => {
            const hovered = hoveredFloorId === floor.floor_id;
            const dimmed = hoveredFloorId !== null && !hovered;
            const fallbackSample = floor.floor_number === 1 ? "/data/1.webp" : floor.floor_number === 2 ? "/data/2.webp" : null;
            const imageUrl = !brokenImageByFloorId[floor.floor_id] ? floor.topdown_url || fallbackSample : null;
            return (
              <FloorSlab
                key={floor.floor_id}
                floor={floor}
                imageUrl={imageUrl}
                hovered={hovered}
                dimmed={dimmed}
                onHover={() => setHoveredFloorId(floor.floor_id)}
                onLeave={() => setHoveredFloorId(null)}
                onImageError={() => setBrokenImageByFloorId((prev) => ({ ...prev, [floor.floor_id]: true }))}
                onClick={() => router.push(`/buildings/${buildingId}/floors/${floor.floor_number}`)}
              />
            );
          })}
          {floors.length === 0 && (
            <div className="h-64 border border-gray-800 rounded-md bg-gray-900/70 flex items-center justify-center text-sm text-gray-500">
              No floor overview manifest found.
            </div>
          )}
        </div>
      </main>

      {registerPurpose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm rounded-md border border-gray-700 bg-gray-900 p-4 shadow-xl">
            <h2 className="text-sm font-semibold">
              {registerPurpose === 'basemap' ? 'Basemap 등록 정보' : 'Module 등록 정보'}
            </h2>
            <p className="mt-1 text-xs text-gray-400">
              {registerFloor ? `${floorLabel(registerFloor.floor_number)}에 등록합니다.` : '층은 예: 1, -1, B1 형식으로 입력하세요.'}
            </p>
            <input
              type="text"
              value={floorInputValue}
              onChange={(e) => {
                setFloorInputValue(e.target.value);
                if (floorInputError) setFloorInputError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRegisterFromPlus();
                if (e.key === 'Escape') closeRegisterModal();
              }}
              autoFocus={!registerFloor}
              disabled={!!registerFloor}
              className="mt-3 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500 disabled:opacity-50"
              placeholder="층 번호"
            />
            <input
              type="text"
              value={nameInputValue}
              onChange={(e) => {
                setNameInputValue(e.target.value);
                if (floorInputError) setFloorInputError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRegisterFromPlus();
                if (e.key === 'Escape') closeRegisterModal();
              }}
              autoFocus={!!registerFloor}
              className="mt-2 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500"
              placeholder={registerPurpose === 'basemap' ? '저장할 이름' : '모듈 이름'}
            />
            {floorInputError && <p className="mt-2 text-xs text-red-400">{floorInputError}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeRegisterModal}
                className="rounded border border-gray-700 px-3 py-1.5 text-xs hover:bg-gray-800"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleRegisterFromPlus}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FloorSlab({
  floor,
  imageUrl,
  hovered,
  dimmed,
  onHover,
  onLeave,
  onImageError,
  onClick,
}: {
  floor: FloorOverviewManifestEntry;
  imageUrl: string | null;
  hovered: boolean;
  dimmed: boolean;
  onHover: () => void;
  onLeave: () => void;
  onImageError: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
    className={`group relative w-full h-28 lg:h-32 overflow-hidden text-left transition duration-200 ${
        imageUrl ? 'rounded-sm' : 'rounded-md border'
      } ${
        hovered
          ? imageUrl
            ? 'ring-2 ring-blue-500/80 shadow-lg shadow-blue-900/30'
            : 'border-blue-500/80 shadow-lg shadow-blue-900/30'
          : imageUrl
            ? 'ring-1 ring-white/10'
            : 'border-gray-800'
      } ${dimmed ? 'opacity-40' : 'opacity-100'}`}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="floor overview"
          onError={onImageError}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="h-full w-full bg-gradient-to-b from-gray-700 to-gray-900" />
      )}
      <div className="pointer-events-none absolute left-2 bottom-2 z-10 text-[11px] font-medium text-white/90 drop-shadow">
        {floorLabel(floor.floor_number)}
      </div>
      {imageUrl && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/45 to-transparent" />}
    </button>
  );
}
