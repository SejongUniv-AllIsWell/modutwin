'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { FloorOverviewManifest, FloorOverviewManifestEntry } from '@/types';
import { floorLabel } from '@/lib/format/floor';
import { useToast } from '@/components/ui/Toast';

export default function BuildingOverviewPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const buildingId = params.name as string;
  const isPendingBuilding = buildingId === 'pending';
  const { user, loading } = useAuth();
  const { show: showToast } = useToast();

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

  const loadOverview = useCallback(() => {
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

  useEffect(() => { loadOverview(); }, [loadOverview]);

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
    // basemap 등록은 호수별로 도어 unitName 부여 — basemap 전체 이름 입력 불필요. 빈 문자열로 진행.
    const registrationName = registerPurpose === 'basemap' ? '' : nameInputValue.trim();
    if (registerPurpose !== 'basemap' && !registrationName) {
      setFloorInputError('모듈 이름을 입력하세요.');
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
      showToast(error?.message || '뷰어 이동에 실패했습니다.', 'error');
    }
  };

  if (loading) return null;

  return (
    <div
      className="h-[calc(100vh-56px)] flex"
      style={{ background: 'var(--bg)', color: 'var(--ink)' }}
    >
      <aside
        className="w-80 border-r p-4 flex flex-col shrink-0"
        style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
      >
        <button
          type="button"
          onClick={() => router.push('/explore')}
          className="text-sm transition self-start hover:underline underline-offset-4"
          style={{ color: 'var(--muted)' }}
        >
          Back to Explore
        </button>
        <div className="mt-4">
          <h1 className="text-base font-semibold truncate" style={{ color: 'var(--ink)' }}>
            {manifest?.building_name ?? 'Building'}
          </h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>Floors: {floors.length}</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            상태: {manifest?.building_is_confirmed ? '확정' : '미확정'}
          </p>
        </div>

        <div className="mt-4 flex-1 overflow-y-auto space-y-1">
          {floors.map((floor) => (
            <div
              key={floor.floor_id}
              className="rounded-sm border"
              style={{ background: 'var(--bg)', borderColor: 'var(--rule)' }}
            >
              <div className="px-2 py-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => router.push(`/buildings/${buildingId}/floors/${floor.floor_number}`)}
                  className="flex-1 text-left text-sm hover:underline underline-offset-4"
                  style={{ color: 'var(--ink)' }}
                >
                  {floorLabel(floor.floor_number)}
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setOpenFloorMenuId((prev) => (prev === floor.floor_id ? null : floor.floor_id))}
                    className="w-7 h-7 flex items-center justify-center rounded-sm hover:bg-[var(--bg-soft)]"
                    style={{ color: 'var(--muted)' }}
                  >
                    ⋮
                  </button>
                  {openFloorMenuId === floor.floor_id && (
                    <div
                      className="absolute right-0 top-8 z-10 w-28 rounded-sm border shadow-lg p-1"
                      style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
                    >
                      {!floor.has_active_basemap && (
                        <button
                          type="button"
                          onClick={() => {
                            openRegisterModal('basemap', floor);
                          }}
                          className="w-full text-left text-xs px-2 py-1.5 rounded-sm hover:bg-[var(--bg-soft)]"
                          style={{ color: 'var(--ink)' }}
                        >
                          basemap 등록
                        </button>
                      )}
                      {floor.has_active_basemap && (
                        <button
                          type="button"
                          onClick={async () => {
                            setOpenFloorMenuId(null);
                            const ok = window.confirm(
                              `${floorLabel(floor.floor_number)} 의 활성 basemap 을 삭제하시겠습니까?\n` +
                              `해당 basemap 의 PLY/메시/도어 자산이 모두 사라지며, 이 층의 기존 정합된 모듈들은 부모 베이스맵을 잃습니다.`
                            );
                            if (!ok) return;
                            try {
                              const active = await api.get<{ basemap_id: string }>(
                                `/basemaps/active?floor_id=${floor.floor_id}`,
                              );
                              await api.delete(`/admin/basemaps/${active.basemap_id}`);
                              await loadOverview();
                            } catch (err: any) {
                              showToast(`basemap 삭제 실패: ${err?.message ?? err}`, 'error');
                            }
                          }}
                          className="w-full text-left text-xs px-2 py-1.5 rounded-sm hover:bg-red-500/10"
                          style={{ color: '#b04646' }}
                        >
                          basemap 삭제
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          <div className="space-y-2">
            <button
              type="button"
              disabled={manifest?.building_is_confirmed || !user}
              onClick={() => setAddMenuOpen((prev) => !prev)}
              title={!user ? '로그인 후 등록 가능합니다' : undefined}
              className="w-full rounded-sm border px-3 py-2 text-sm text-left disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--bg-soft)]"
              style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
            >
              + 등록
            </button>
            {addMenuOpen && !manifest?.building_is_confirmed && user && (
              <div
                className="rounded-sm border p-1 space-y-1"
                style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
              >
                <button
                  type="button"
                  onClick={() => {
                    openRegisterModal('basemap');
                  }}
                  className="w-full text-left text-xs px-2 py-1.5 rounded-sm hover:bg-[var(--bg-soft)]"
                  style={{ color: 'var(--ink)' }}
                >
                  basemap 등록
                </button>
                <button
                  type="button"
                  onClick={() => {
                    openRegisterModal('module');
                  }}
                  className="w-full text-left text-xs px-2 py-1.5 rounded-sm hover:bg-[var(--bg-soft)]"
                  style={{ color: 'var(--ink)' }}
                >
                  module 등록
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <main
        className="flex-1 h-full overflow-y-auto px-4 pt-4 pb-8 lg:px-8 lg:pt-6 lg:pb-12 [perspective:1200px]"
        style={{ background: 'var(--bg)' }}
      >
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
            <div
              className="h-64 border rounded-md flex items-center justify-center text-sm"
              style={{
                background: 'var(--paper)',
                borderColor: 'var(--rule)',
                color: 'var(--muted)',
              }}
            >
              No floor overview manifest found.
            </div>
          )}
        </div>
      </main>

      {registerPurpose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div
            className="w-full max-w-sm rounded-md border p-4 shadow-xl"
            style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
          >
            <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              {registerPurpose === 'basemap' ? 'Basemap 등록 정보' : 'Module 등록 정보'}
            </h2>
            <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
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
              className="mt-3 w-full rounded-sm border px-3 py-2 text-sm outline-none disabled:opacity-50"
              style={{
                background: 'var(--bg)',
                borderColor: 'var(--rule)',
                color: 'var(--ink)',
              }}
              placeholder="층 번호"
            />
            {/* basemap 등록은 호수별로 도어에 unitName 부여 — basemap 전체 이름 입력 불필요. */}
            {registerPurpose !== 'basemap' && (
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
                className="mt-2 w-full rounded-sm border px-3 py-2 text-sm outline-none"
                style={{
                  background: 'var(--bg)',
                  borderColor: 'var(--rule)',
                  color: 'var(--ink)',
                }}
                placeholder="모듈 이름"
              />
            )}
            {floorInputError && <p className="mt-2 text-xs" style={{ color: '#b04646' }}>{floorInputError}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeRegisterModal}
                className="rounded-sm border px-3 py-1.5 text-xs hover:bg-[var(--bg-soft)]"
                style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleRegisterFromPlus}
                className="rounded-sm px-3 py-1.5 text-xs font-medium border"
                style={{
                  background: 'var(--ink)',
                  color: 'var(--bg)',
                  borderColor: 'var(--ink)',
                }}
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
      } ${dimmed ? 'opacity-40' : 'opacity-100'}`}
      style={{
        borderColor: hovered ? 'var(--ink)' : imageUrl ? undefined : 'var(--rule)',
        boxShadow: hovered ? '0 10px 24px -12px rgba(0,0,0,0.25)' : undefined,
        outline: imageUrl ? (hovered ? '2px solid var(--ink)' : '1px solid var(--rule)') : undefined,
        outlineOffset: imageUrl ? '-1px' : undefined,
      }}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="floor overview"
          onError={onImageError}
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          className="h-full w-full"
          style={{
            background: 'linear-gradient(to bottom, var(--bg-soft), var(--paper))',
          }}
        />
      )}
      <div
        className="pointer-events-none absolute left-2 bottom-2 z-10 text-[11px] font-medium drop-shadow"
        style={{ color: imageUrl ? 'rgba(255,255,255,0.95)' : 'var(--ink)' }}
      >
        {floorLabel(floor.floor_number)}
      </div>
      {imageUrl && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/45 to-transparent" />}
    </button>
  );
}
