'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import dynamic from 'next/dynamic';
import type { EditorMode, RegistrationContext, RegistrationPurpose } from '@/components/viewer/UnifiedSplatEditor';
import { clearPendingLocalPly, readPendingLocalPly, type PendingLocalPlyPayload } from '@/lib/upload/pendingLocalPly';

const UnifiedSplatEditor = dynamic(
  () => import('@/components/viewer/UnifiedSplatEditor'),
  { ssr: false },
);

function buildRegistrationContextFromPayload(p: PendingLocalPlyPayload): RegistrationContext | null {
  const purpose: RegistrationPurpose | null =
    p.purpose === 'basemap' || p.purpose === 'module' ? p.purpose : null;
  if (!purpose) return null;
  if (!Number.isFinite(p.floor_number)) return null;
  return {
    purpose,
    building_id: p.building_id,
    building_name: p.building_name,
    floor_id: p.floor_id,
    floor_number: p.floor_number,
    module_name: p.module_name,
    kakao_place_id: p.place_id,
    address_name: p.address_name,
    road_address_name: p.road_address_name,
    latitude: p.lat,
    longitude: p.lng,
  };
}

function ViewerContent() {
  const searchParams = useSearchParams();

  // /upload 에서 blob URL 로 핸드오프된 로컬 파일이 있는지 1회 픽업.
  // 픽업 즉시 sessionStorage 를 비워, 새로고침/뒤로가기로 인한 stale handoff 재사용을 막는다.
  const pendingLocal = useMemo<PendingLocalPlyPayload | null>(() => {
    const p = readPendingLocalPly();
    if (p) clearPendingLocalPly();
    return p;
  }, []);

  const uploadId = searchParams.get('upload_id') ?? undefined;

  // 등록 컨텍스트: 로컬 핸드오프가 있으면 그것을 우선, 없으면 URL 쿼리 파라미터 (서버 진입용) 사용.
  const initialRegistrationContext: RegistrationContext | null = useMemo(() => {
    if (pendingLocal) return buildRegistrationContextFromPayload(pendingLocal);
    const purposeParam = searchParams.get('purpose');
    const purpose: RegistrationPurpose | null =
      purposeParam === 'basemap' || purposeParam === 'module' ? purposeParam : null;
    const buildingName = searchParams.get('building_name') ?? '';
    const floorNumber = Number(searchParams.get('floor_number') ?? NaN);
    const lat = Number(searchParams.get('lat') ?? NaN);
    const lng = Number(searchParams.get('lng') ?? NaN);
    if (!purpose || !Number.isFinite(floorNumber)) return null;
    return {
      purpose,
      building_id: searchParams.get('building_id') ?? undefined,
      building_name: buildingName,
      floor_id: searchParams.get('floor_id') ?? undefined,
      floor_number: floorNumber,
      module_name: searchParams.get('module_name') ?? undefined,
      kakao_place_id: searchParams.get('place_id') ?? undefined,
      address_name: searchParams.get('address_name') ?? undefined,
      road_address_name: searchParams.get('road_address_name') ?? undefined,
      latitude: Number.isFinite(lat) ? lat : undefined,
      longitude: Number.isFinite(lng) ? lng : undefined,
    };
  }, [pendingLocal, searchParams]);

  // 초기 모드:
  //  - 로컬 핸드오프 진입 → refine
  //  - URL 에 mode 명시 (예: /viewer?upload_id=X&mode=align) 면 그것을 우선
  //  - upload_id 만 있으면 파일이 함께 로드되므로 'refine' (다듬기) 시작
  //  - 셋 다 없으면 null → "파일" 단계 (UnifiedSplatEditor 가 파일 선택 시 자동으로 'refine' 으로 전환)
  const explicitMode = searchParams.get('mode') as EditorMode | null;
  const initialMode: EditorMode = pendingLocal
    ? 'refine'
    : explicitMode ?? (uploadId ? 'refine' : null);

  const [fileUrl, setFileUrl] = useState<string | null>(pendingLocal?.blobUrl ?? null);
  const [filename, setFilename] = useState<string | undefined>(pendingLocal?.filename);
  const [resolving, setResolving] = useState(!pendingLocal && !!uploadId);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // upload_id가 있으면 해당 파일의 presigned URL fetch (정합 모드는 refined 우선).
  // 로컬 핸드오프가 있으면 그것을 우선하므로 서버 fetch 는 건너뛴다.
  useEffect(() => {
    if (pendingLocal) {
      setResolving(false);
      return;
    }
    if (!uploadId) {
      setResolving(false);
      return;
    }
    setResolving(true);
    setResolveError(null);
    const variant = initialMode === 'align' ? 'refined' : '';
    const qs = variant ? `?variant=${variant}` : '';
    api.get<{ url: string; filename: string; variant?: string }>(`/uploads/${uploadId}/presigned-url${qs}`)
      .then(data => {
        setFileUrl(data.url);
        const name = data.filename ?? '';
        const servedVariant = data.variant ?? '';
        const labelVariant = servedVariant === 'refined' ? 'refined' : '';
        if (labelVariant && name && !name.includes(labelVariant)) {
          const dotIdx = name.lastIndexOf('.');
          const base = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
          const ext = dotIdx >= 0 ? name.slice(dotIdx) : '';
          setFilename(`${base}_${labelVariant}${ext}`);
        } else {
          setFilename(name);
        }
      })
      .catch((e: any) => {
        setFileUrl(null);
        setResolveError(e?.message || '파일 URL 을 가져오지 못했습니다.');
      })
      .finally(() => setResolving(false));
  }, [uploadId, initialMode, pendingLocal]);

  if (resolving) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-56px)] text-[var(--muted)]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">파일 로딩 중...</p>
        </div>
      </div>
    );
  }

  if (resolveError) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-56px)] text-[var(--ink-2)]">
        <div className="text-center max-w-md px-6">
          <p className="text-sm font-bold text-red-400 mb-2">파일을 열 수 없습니다</p>
          <p className="text-xs text-[var(--muted)] leading-relaxed">{resolveError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer-dark relative h-[calc(100vh-56px)] bg-[var(--bg)]">
      <UnifiedSplatEditor
        initialSogUrl={fileUrl}
        initialUploadId={uploadId}
        initialDisplayName={filename}
        initialMode={initialMode}
        initialRegistrationContext={initialRegistrationContext}
        initialLocalFileSize={pendingLocal?.fileSize ?? 0}
      />
    </div>
  );
}

export default function ViewerPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-[calc(100vh-56px)] text-[var(--muted)]">로딩 중...</div>}>
      <ViewerContent />
    </Suspense>
  );
}
