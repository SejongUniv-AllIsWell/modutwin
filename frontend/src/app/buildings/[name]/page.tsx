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

const INACTIVE_FLOOR_BG_TOP = '#222428';
const INACTIVE_FLOOR_BG = '#17191d';

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

  useEffect(() => {
    if (!openFloorMenuId) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-floor-menu-root="true"]')) return;
      setOpenFloorMenuId(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [openFloorMenuId]);

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
              has_pending_basemap: false,
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
        if (existing.some((m) => m.name === registrationName && !!m.alignment_transform)) {
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

  const handleEditBasemap = async (floor: FloorOverviewManifestEntry) => {
    setOpenFloorMenuId(null);
    try {
      const active = await api.get<{ basemap_id: string; source_upload_id: string | null }>(
        `/basemaps/active?floor_id=${floor.floor_id}`,
      );
      if (!active.source_upload_id) {
        showToast('basemap 원본 upload 정보를 찾을 수 없습니다.', 'error');
        return;
      }
      const qs = new URLSearchParams({
        upload_id: active.source_upload_id,
        basemap_id: active.basemap_id,
        mode: 'door',
        purpose: 'basemap',
        basemap_edit: '1',
        building_id: buildingId,
        building_name: manifest?.building_name ?? 'Building',
        floor_id: floor.floor_id,
        floor_number: String(floor.floor_number),
      });
      router.push(`/viewer?${qs.toString()}`);
    } catch (err: any) {
      showToast(`basemap 수정 진입 실패: ${err?.message ?? err}`, 'error');
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

  const handleDeleteFloor = async (floor: FloorOverviewManifestEntry) => {
    setOpenFloorMenuId(null);
    if (floor.floor_id.startsWith('pending-')) {
      setManifest((prev) => prev && ({
        ...prev,
        floors: prev.floors.filter((f) => f.floor_id !== floor.floor_id),
      }));
      return;
    }
    const ok = window.confirm(
      `${floorLabel(floor.floor_number)} 을(를) 삭제하시겠습니까?\n` +
      `이 층의 basemap, 모듈, 업로드/씬 데이터와 관련 파일이 함께 삭제됩니다.`,
    );
    if (!ok) return;
    try {
      await api.delete(`/admin/floors/${floor.floor_id}`);
      await loadOverview();
    } catch (err: any) {
      showToast(`층 삭제 실패: ${err?.message ?? err}`, 'error');
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
        </div>

        <div className="mt-4 text-[11px] font-semibold" style={{ color: 'var(--muted)', letterSpacing: 0 }}>
          FLOORS ({floors.length})
        </div>

        <div className="mt-3 flex-1 overflow-y-auto space-y-2">
          {floors.map((floor) => {
            const isPendingFloor = floor.floor_id.startsWith('pending-');
            const hasBasemapWarning = !floor.has_active_basemap;
            const activeFloor = floor.has_active_basemap && !isPendingFloor;
            const warningText = floor.has_pending_basemap
              ? 'basemap 관리자 승인 대기중입니다.'
              : '등록된 basemap 이 없습니다.';
            const iconColor = floor.has_pending_basemap ? '#8f6f12' : '#9d3f3f';
            const iconBg = floor.has_pending_basemap ? '#f1dfae' : '#ead1cc';
            const iconBorder = floor.has_pending_basemap ? '#c4a343' : '#c9897d';
            return (
              <div
                key={floor.floor_id}
                className="relative rounded-md overflow-visible"
                data-floor-menu-root="true"
              >
                <button
                  type="button"
                  onClick={() => {
                    if (isPendingFloor) return;
                    router.push(`/buildings/${buildingId}/floors/${floor.floor_number}`);
                  }}
                  disabled={isPendingFloor}
                  className="w-full px-4 py-3 pr-16 text-left transition border rounded-md disabled:cursor-default hover:brightness-125 hover:shadow-[0_0_0_1px_rgba(56,189,248,0.32)]"
                  style={{
                    borderColor: activeFloor ? 'rgba(56,189,248,0.35)' : 'var(--rule)',
                    background: activeFloor ? 'rgba(56,189,248,0.08)' : 'rgba(255,255,255,0.025)',
                    color: activeFloor ? 'var(--ink)' : 'var(--muted)',
                    opacity: hasBasemapWarning ? 0.7 : 1,
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-base font-semibold truncate">{floorLabel(floor.floor_number)}</div>
                      <div
                        className="text-[11px] mt-0.5"
                        style={{ color: activeFloor ? 'var(--accent)' : 'var(--muted)' }}
                      >
                        {floor.module_count}개 모듈
                      </div>
                    </div>
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center">
                      {hasBasemapWarning && (
                        <span
                          className="group/warn relative inline-flex h-6 w-6 items-center justify-center rounded-md border shadow-sm"
                          style={{ background: iconBg, borderColor: iconBorder, color: iconColor }}
                          aria-label={warningText}
                        >
                          <svg
                            className="h-3.5 w-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.4}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                            <path d="M12 9v4" />
                            <path d="M12 17h.01" />
                          </svg>
                          <span
                            className="pointer-events-none absolute right-0 top-8 z-20 w-max max-w-[220px] rounded-sm border px-2 py-1 text-[11px] font-medium opacity-0 shadow-lg transition-opacity delay-300 duration-100 group-hover/warn:opacity-100"
                            style={{
                              background: 'var(--paper)',
                              borderColor: 'var(--rule)',
                              color: 'var(--ink)',
                            }}
                          >
                            {warningText}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                </button>
                <div className="absolute right-2 top-1/2 -translate-y-1/2">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenFloorMenuId((prev) => (prev === floor.floor_id ? null : floor.floor_id));
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-sm hover:bg-sky-400/10"
                    style={{ color: activeFloor ? 'var(--accent)' : 'var(--muted)' }}
                    aria-label={`${floorLabel(floor.floor_number)} 메뉴`}
                  >
                    ⋮
                  </button>
                    {openFloorMenuId === floor.floor_id && (
                      <div
                        className="absolute right-0 top-9 z-10 w-28 rounded-sm border shadow-lg p-1"
                        style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
                      >
                        {!floor.has_active_basemap && (
                          <button
                            type="button"
                            onClick={() => {
                              setOpenFloorMenuId(null);
                              openRegisterModal(floor, 'basemap');
                            }}
                            className="w-full text-left text-xs px-2 py-1.5 rounded-sm hover:bg-sky-400/10"
                            style={{ color: 'var(--ink)' }}
                          >
                            basemap 등록
                          </button>
                        )}
                        {floor.has_active_basemap && !isPendingFloor && (
                          <>
                            <button
                              type="button"
                              disabled={user?.role !== 'admin'}
                              title={user?.role !== 'admin' ? '관리자만 수정할 수 있습니다.' : undefined}
                              onClick={() => handleEditBasemap(floor)}
                              className="w-full text-left text-xs px-2 py-1.5 rounded-sm transition disabled:cursor-not-allowed disabled:opacity-40 disabled:grayscale hover:bg-sky-400/10 disabled:hover:bg-transparent"
                              style={{
                                color: user?.role === 'admin' ? 'var(--ink)' : 'var(--muted)',
                                textDecoration: user?.role === 'admin' ? undefined : 'line-through',
                                textDecorationThickness: user?.role === 'admin' ? undefined : '1px',
                              }}
                            >
                              basemap 수정
                            </button>
                            <button
                              type="button"
                              disabled={user?.role !== 'admin'}
                              title={user?.role !== 'admin' ? '관리자만 삭제할 수 있습니다.' : undefined}
                              onClick={() => {
                                setOpenFloorMenuId(null);
                                handleDeleteBasemap(floor);
                              }}
                              className="w-full text-left text-xs px-2 py-1.5 rounded-sm transition disabled:cursor-not-allowed disabled:opacity-40 disabled:grayscale hover:bg-red-500/10 disabled:hover:bg-transparent"
                              style={{
                                color: user?.role === 'admin' ? '#b04646' : 'var(--muted)',
                                textDecoration: user?.role === 'admin' ? undefined : 'line-through',
                                textDecorationThickness: user?.role === 'admin' ? undefined : '1px',
                              }}
                            >
                              basemap 삭제
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          disabled={user?.role !== 'admin'}
                          title={user?.role !== 'admin' ? '관리자만 삭제할 수 있습니다.' : undefined}
                          onClick={() => handleDeleteFloor(floor)}
                          className="w-full text-left text-xs px-2 py-1.5 rounded-sm transition disabled:cursor-not-allowed disabled:opacity-40 disabled:grayscale hover:bg-red-500/10 disabled:hover:bg-transparent"
                          style={{
                            color: user?.role === 'admin' ? '#b04646' : 'var(--muted)',
                            textDecoration: user?.role === 'admin' ? undefined : 'line-through',
                            textDecorationThickness: user?.role === 'admin' ? undefined : '1px',
                          }}
                        >
                          층 삭제
                        </button>
                      </div>
                    )}
                </div>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          disabled={addFloorDisabled}
          onClick={openAddFloor}
          title={!user ? '로그인 후 등록 가능합니다' : undefined}
          className="mt-4 shrink-0 w-full inline-flex items-center justify-center gap-2 rounded-sm border py-3 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: 'var(--accent)',
            color: '#04131f',
            borderColor: 'var(--accent)',
          }}
          aria-label="층 추가"
        >
          <span
            className="inline-flex items-center justify-center w-6 h-6 rounded-full text-lg leading-none font-bold"
            style={{ background: 'rgba(255,255,255,0.15)' }}
          >
            +
          </span>
          <span>층 추가</span>
        </button>
      </aside>

      <main
        className="flex-1 h-full overflow-y-auto px-4 pt-4 pb-8 lg:px-8 lg:pt-6 lg:pb-12 [perspective:1200px]"
        style={{ background: 'var(--bg)' }}
      >
        <div className="mx-auto max-w-5xl min-h-full pt-1 lg:pt-2 pr-1">
          {floors.map((floor) => {
            const hovered = hoveredFloorId === floor.floor_id;
            const dimmed = hoveredFloorId !== null && !hovered;
            const imageUrl = !brokenImageByFloorId[floor.floor_id] ? floor.topdown_url : null;
            const isPendingFloor = floor.floor_id.startsWith('pending-');
            const hasBasemapWarning = !floor.has_active_basemap;
            return (
              <FloorSlab
                key={floor.floor_id}
                floor={floor}
                imageUrl={imageUrl}
                hovered={hovered}
                dimmed={dimmed}
                inactive={hasBasemapWarning}
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
                className="flex-1 rounded-sm border hover:bg-sky-400/10 disabled:opacity-50 py-2 text-sm"
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
                  background: 'var(--accent)',
                  color: '#04131f',
                  borderColor: 'var(--accent)',
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
                className="flex-1 rounded-sm border hover:bg-sky-400/10 disabled:opacity-50 py-2 text-sm"
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
                  background: 'var(--accent)',
                  color: '#04131f',
                  borderColor: 'var(--accent)',
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
  inactive,
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
  inactive: boolean;
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
      } ${dimmed ? 'opacity-40' : inactive ? 'opacity-55 grayscale' : 'opacity-100'} ${!interactive ? 'cursor-default' : ''}`}
      style={{
        borderColor: hovered && interactive ? 'var(--accent)' : imageUrl ? undefined : 'var(--rule)',
        boxShadow: hovered && interactive ? '0 12px 26px -14px rgba(56,189,248,0.42)' : undefined,
        outline: imageUrl ? (hovered && interactive ? '2px solid var(--accent)' : '1px solid var(--rule)') : undefined,
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
            background: inactive
              ? `linear-gradient(to bottom, ${INACTIVE_FLOOR_BG_TOP}, ${INACTIVE_FLOOR_BG})`
              : 'linear-gradient(to bottom, var(--bg-soft), var(--paper))',
          }}
        />
      )}
      <div
        className="pointer-events-none absolute left-2 bottom-2 z-10 text-[11px] font-medium drop-shadow"
        style={{ color: imageUrl ? 'rgba(255,255,255,0.95)' : 'var(--ink)' }}
      >
        {floorLabel(floor.floor_number)}
      </div>
      {inactive && (
        <div className="pointer-events-none absolute inset-0 bg-black/10" />
      )}
      {imageUrl && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/45 to-transparent" />}
    </button>
  );
}
