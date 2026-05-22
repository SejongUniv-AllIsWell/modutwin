'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Floor, FloorOverviewManifest, FloorOverviewManifestEntry } from '@/types';
import { floorLabel, floorLabelKo } from '@/lib/format/floor';
import { useToast } from '@/components/ui/Toast';
import RoomWheelPicker, { FloorWheelPicker, roomNumberLabel } from '@/components/ui/RoomWheelPicker';
import type { Module } from '@/types';

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

  // "+ 등록" — 층 추가 모달 (휠 피커)
  const [addFloorOpen, setAddFloorOpen] = useState(false);
  const [addFloorPick, setAddFloorPick] = useState(1);
  const [addFloorError, setAddFloorError] = useState<string | null>(null);
  const [addFloorBusy, setAddFloorBusy] = useState(false);

  // 층 ⋮ → basemap/module 등록 모달
  const [registerTarget, setRegisterTarget] = useState<{
    floor: FloorOverviewManifestEntry;
    purpose: 'basemap' | 'module';
  } | null>(null);
  const [pickerRoomSuffix, setPickerRoomSuffix] = useState(1);
  const [registerNameError, setRegisterNameError] = useState<string | null>(null);
  const [registerBusy, setRegisterBusy] = useState(false);

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

  const openAddFloor = () => {
    setAddFloorOpen(true);
    // 첫 표시 시 가장 작은 미사용 양수 층을 기본 선택지로.
    const used = new Set(floors.map((f) => f.floor_number));
    let candidate = 1;
    while (used.has(candidate)) candidate += 1;
    setAddFloorPick(candidate);
    setAddFloorError(null);
  };

  const closeAddFloor = () => {
    if (addFloorBusy) return;
    setAddFloorOpen(false);
    setAddFloorError(null);
  };

  const handleAddFloor = async () => {
    const floorNumber = addFloorPick;
    if (!Number.isInteger(floorNumber) || floorNumber === 0) {
      setAddFloorError('유효한 층을 선택하세요.');
      return;
    }
    if (floors.some((f) => f.floor_number === floorNumber)) {
      setAddFloorError('이미 존재하는 층입니다.');
      return;
    }
    setAddFloorBusy(true);
    try {
      if (isPendingBuilding) {
        // 건물 자체가 아직 서버에 없음 — 로컬 manifest 에 임시 entry 만 추가.
        // 실제 floor 레코드는 basemap/module 등록의 viewer 흐름에서 생성됨.
        setManifest((prev) => prev && ({
          ...prev,
          floors: [
            ...prev.floors,
            {
              floor_id: `pending-${floorNumber}`,
              floor_number: floorNumber,
              overview_dirty: false,
              overview_version: null,
              topdown_url: null,
              meta_url: null,
              module_count: 0,
              has_active_basemap: false,
            },
          ],
        }));
      } else {
        const created = await api.post<Floor>(`/buildings/${buildingId}/floors`, {
          floor_number: floorNumber,
        });
        if (user?.role === 'admin') {
          try { await api.put(`/admin/floors/${created.id}/confirm`); } catch { /* 확정 실패 무시 */ }
        }
        const refreshed = await api.get<FloorOverviewManifest>(
          `/buildings/${buildingId}/floor-overview`,
        );
        setManifest(refreshed);
      }
      setAddFloorOpen(false);
      setAddFloorError(null);
    } catch (e: any) {
      setAddFloorError(e?.message || '층 추가에 실패했습니다.');
    } finally {
      setAddFloorBusy(false);
    }
  };

  const openRegisterModal = (floor: FloorOverviewManifestEntry, purpose: 'basemap' | 'module') => {
    setOpenFloorMenuId(null);
    setRegisterTarget({ floor, purpose });
    setPickerRoomSuffix(1);
    setRegisterNameError(null);
  };

  const closeRegisterModal = () => {
    if (registerBusy) return;
    setRegisterTarget(null);
    setPickerRoomSuffix(1);
    setRegisterNameError(null);
  };

  const handleRegister = async () => {
    if (!registerTarget) return;
    const { floor, purpose } = registerTarget;
    // basemap 은 호수별 도어에 unitName 부여 — basemap 전체 이름 입력 불필요.
    // module 은 휠 피커에서 선택한 호수가 이름이 됨 (예: 201호).
    const registrationName =
      purpose === 'basemap' ? '' : roomNumberLabel(floor.floor_number, pickerRoomSuffix);

    setRegisterBusy(true);
    try {
      // module 등록 — 동일 호수가 이미 있을 경우 사전 확인.
      if (
        purpose === 'module' &&
        floor.floor_id &&
        !floor.floor_id.startsWith('pending-')
      ) {
        const existing = await api.get<Array<Module>>(
          `/floors/${floor.floor_id}/modules`,
        );
        if (existing.some((m) => m.name === registrationName)) {
          const ok = window.confirm(
            `${registrationName} 은(는) 이미 등록되어 있습니다.\n계속 진행하면 정합 완료 시 기존 작업물은 삭제되고 새 작업물로 교체됩니다.\n\n진행하시겠습니까?`,
          );
          if (!ok) {
            setRegisterBusy(false);
            return;
          }
        }
      }
      const qs = new URLSearchParams({
        purpose,
        building_name: manifest?.building_name ?? 'Building',
        floor_number: String(floor.floor_number),
        module_name: registrationName,
      });
      if (!isPendingBuilding) qs.set('building_id', buildingId);
      if (floor.floor_id && !floor.floor_id.startsWith('pending-')) {
        qs.set('floor_id', floor.floor_id);
      }
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
      setRegisterTarget(null);
      setPickerRoomSuffix(1);
      setRegisterNameError(null);
      router.push(`/viewer?${qs.toString()}`);
    } catch (err: any) {
      setRegisterNameError(err?.message || '뷰어 이동에 실패했습니다.');
      setRegisterBusy(false);
    }
  };

  const handleDeleteBasemap = async (floor: FloorOverviewManifestEntry) => {
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
  };

  if (loading) return null;

  const addFloorDisabled =
    !user || (!isPendingBuilding && user?.role !== 'admin' && !!manifest?.building_is_confirmed);

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
          {floors.map((floor) => {
            const isPendingFloor = floor.floor_id.startsWith('pending-');
            return (
              <div
                key={floor.floor_id}
                className="rounded-sm border"
                style={{ background: 'var(--bg)', borderColor: 'var(--rule)' }}
              >
                <div className="px-2 py-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (isPendingFloor) return;
                      router.push(`/buildings/${buildingId}/floors/${floor.floor_number}`);
                    }}
                    disabled={isPendingFloor}
                    className="flex-1 text-left text-sm hover:underline underline-offset-4 disabled:opacity-60 disabled:cursor-default disabled:hover:no-underline"
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
                            onClick={() => openRegisterModal(floor, 'basemap')}
                            className="w-full text-left text-xs px-2 py-1.5 rounded-sm hover:bg-[var(--bg-soft)]"
                            style={{ color: 'var(--ink)' }}
                          >
                            basemap 등록
                          </button>
                        )}
                        {floor.has_active_basemap && !isPendingFloor && (
                          <button
                            type="button"
                            onClick={() => handleDeleteBasemap(floor)}
                            className="w-full text-left text-xs px-2 py-1.5 rounded-sm hover:bg-red-500/10"
                            style={{ color: '#b04646' }}
                          >
                            basemap 삭제
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openRegisterModal(floor, 'module')}
                          className="w-full text-left text-xs px-2 py-1.5 rounded-sm hover:bg-[var(--bg-soft)]"
                          style={{ color: 'var(--ink)' }}
                        >
                          module 등록
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            disabled={addFloorDisabled}
            onClick={openAddFloor}
            title={!user ? '로그인 후 등록 가능합니다' : undefined}
            className="w-full rounded-sm border px-3 py-2 text-sm text-left disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--bg-soft)]"
            style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
          >
            + 등록
          </button>
        </div>
      </aside>

      <main
        className="flex-1 h-full overflow-y-auto px-4 pt-4 pb-8 lg:px-8 lg:pt-6 lg:pb-12 [perspective:1200px]"
        style={{ background: 'var(--bg)' }}
      >
        <div className="mx-auto max-w-5xl min-h-full pt-1 lg:pt-2 pr-1">
          {floors.map((floor) => {
            const hovered = hoveredFloorId === floor.floor_id;
            const dimmed = hoveredFloorId !== null && !hovered;
            const fallbackSample = floor.floor_number === 1 ? "/data/1.webp" : floor.floor_number === 2 ? "/data/2.webp" : null;
            const imageUrl = !brokenImageByFloorId[floor.floor_id] ? floor.topdown_url || fallbackSample : null;
            const isPendingFloor = floor.floor_id.startsWith('pending-');
            return (
              <FloorSlab
                key={floor.floor_id}
                floor={floor}
                imageUrl={imageUrl}
                hovered={hovered}
                dimmed={dimmed}
                interactive={!isPendingFloor}
                onHover={() => setHoveredFloorId(floor.floor_id)}
                onLeave={() => setHoveredFloorId(null)}
                onImageError={() => setBrokenImageByFloorId((prev) => ({ ...prev, [floor.floor_id]: true }))}
                onClick={() => {
                  if (isPendingFloor) return;
                  router.push(`/buildings/${buildingId}/floors/${floor.floor_number}`);
                }}
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

      {addFloorOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={closeAddFloor}
        >
          <div
            className="w-[320px] rounded-xl border p-5 shadow-2xl"
            style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-center" style={{ color: 'var(--ink)' }}>
              층을 선택하세요
            </h2>
            <p className="text-xs text-center mt-1" style={{ color: 'var(--muted)' }}>
              지하(B)와 지상(층) 모두 선택 가능합니다.
            </p>
            <div className="mt-4">
              <FloorWheelPicker
                value={addFloorPick}
                onChange={(next) => {
                  setAddFloorPick(next);
                  setAddFloorError(null);
                }}
              />
            </div>

            {addFloorError && (
              <p className="mt-3 text-xs text-center" style={{ color: '#b04646' }}>{addFloorError}</p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={closeAddFloor}
                disabled={addFloorBusy}
                className="flex-1 rounded-sm border hover:bg-[var(--bg-soft)] disabled:opacity-50 py-2 text-sm"
                style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleAddFloor}
                disabled={addFloorBusy}
                className="flex-1 rounded-sm border disabled:opacity-60 py-2 text-sm font-semibold"
                style={{
                  background: 'var(--ink)',
                  color: 'var(--bg)',
                  borderColor: 'var(--ink)',
                }}
              >
                {addFloorBusy ? '추가 중...' : `${floorLabelKo(addFloorPick)} 추가`}
              </button>
            </div>
          </div>
        </div>
      )}

      {registerTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={closeRegisterModal}
        >
          <div
            className="w-[320px] rounded-xl border p-5 shadow-2xl"
            style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {registerTarget.purpose === 'module' ? (
              <>
                <h2 className="text-base font-semibold text-center" style={{ color: 'var(--ink)' }}>
                  호수를 선택하세요
                </h2>
                <p className="text-xs text-center mt-1" style={{ color: 'var(--muted)' }}>
                  Floor {registerTarget.floor.floor_number}
                </p>
                <div className="mt-4">
                  <RoomWheelPicker
                    floorNumber={registerTarget.floor.floor_number}
                    value={pickerRoomSuffix}
                    onChange={(next) => {
                      setPickerRoomSuffix(next);
                      setRegisterNameError(null);
                    }}
                  />
                </div>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold text-center" style={{ color: 'var(--ink)' }}>
                  Basemap 등록
                </h2>
                <p className="text-xs text-center mt-1" style={{ color: 'var(--muted)' }}>
                  {floorLabel(registerTarget.floor.floor_number)}에 basemap 을 등록합니다.
                </p>
              </>
            )}

            {registerNameError && (
              <p className="mt-3 text-xs text-center" style={{ color: '#b04646' }}>{registerNameError}</p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                disabled={registerBusy}
                onClick={closeRegisterModal}
                className="flex-1 rounded-sm border hover:bg-[var(--bg-soft)] disabled:opacity-50 py-2 text-sm"
                style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}
              >
                취소
              </button>
              <button
                type="button"
                disabled={registerBusy}
                onClick={handleRegister}
                className="flex-1 rounded-sm border disabled:opacity-60 py-2 text-sm font-semibold"
                style={{
                  background: 'var(--ink)',
                  color: 'var(--bg)',
                  borderColor: 'var(--ink)',
                }}
              >
                {registerBusy
                  ? '확인 중...'
                  : registerTarget.purpose === 'module'
                  ? `${roomNumberLabel(registerTarget.floor.floor_number, pickerRoomSuffix)} 등록`
                  : '확인'}
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
  interactive,
  onHover,
  onLeave,
  onImageError,
  onClick,
}: {
  floor: FloorOverviewManifestEntry;
  imageUrl: string | null;
  hovered: boolean;
  dimmed: boolean;
  interactive: boolean;
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
      disabled={!interactive}
      className={`group relative w-full h-28 lg:h-32 overflow-hidden text-left transition duration-200 ${
        imageUrl ? 'rounded-sm' : 'rounded-md border'
      } ${dimmed ? 'opacity-40' : 'opacity-100'} ${!interactive ? 'cursor-default' : ''}`}
      style={{
        borderColor: hovered && interactive ? 'var(--ink)' : imageUrl ? undefined : 'var(--rule)',
        boxShadow: hovered && interactive ? '0 10px 24px -12px rgba(0,0,0,0.25)' : undefined,
        outline: imageUrl ? (hovered && interactive ? '2px solid var(--ink)' : '1px solid var(--rule)') : undefined,
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
