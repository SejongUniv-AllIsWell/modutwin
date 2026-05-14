'use client';

import { Suspense, useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import MultipartUploader from '@/components/upload/MultipartUploader';
import { useRouter, useSearchParams } from 'next/navigation';

function UploadContent() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const searchParams = useSearchParams();
  const purpose = searchParams.get('purpose');
  const buildingId = searchParams.get('building_id') ?? '';
  const buildingName = searchParams.get('building_name') ?? '';
  const floorId = searchParams.get('floor_id') ?? '';
  const floorNumberRaw = searchParams.get('floor_number');
  const floorNumber = floorNumberRaw === null ? NaN : Number(floorNumberRaw);
  const moduleName = searchParams.get('module_name') ?? '';

  // buildings 페이지를 통한 진입 여부 — 최소한 building_name + floor_number + module_name + purpose 가
  // 필요. (pending building 은 building_id 가 없을 수 있으므로 building_id 단독 검증은 부적합.)
  const hasContext =
    !!purpose && !!buildingName && Number.isFinite(floorNumber) && !!moduleName;

  const fixedContext = hasContext
    ? {
        purpose,
        building_id: buildingId,
        building_name: buildingName,
        floor_id: floorId,
        floor_number: floorNumber,
        module_name: moduleName,
        place_id: searchParams.get('place_id') ?? '',
        address_name: searchParams.get('address_name') ?? '',
        road_address_name: searchParams.get('road_address_name') ?? '',
        lat: searchParams.get('lat') ?? '',
        lng: searchParams.get('lng') ?? '',
      }
    : null;

  useEffect(() => {
    if (!loading && !user) {
      window.location.href = '/';
    }
  }, [user, loading]);

  if (loading || !user) return <div className="flex items-center justify-center h-64 text-gray-500">로딩 중...</div>;

  if (!fixedContext) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-3">업로드</h1>
        <p className="text-gray-400 text-sm mb-6">
          업로드는 건물 상세 페이지의 등록 버튼을 통해 시작할 수 있습니다.
        </p>
        <button
          type="button"
          onClick={() => router.push('/explore')}
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-2 rounded"
        >
          건물 둘러보기로 이동
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-2">업로드</h1>
      <p className="text-gray-400 text-sm mb-2">
        .ply / .splat / .sog 또는 사진 묶음(.zip) 파일을 업로드하세요.
      </p>
      <p className="text-gray-500 text-xs mb-8">
        {fixedContext.purpose === 'basemap' ? 'Basemap' : 'Module'} · {fixedContext.building_name} ·{' '}
        {fixedContext.floor_number < 0 ? `B${Math.abs(fixedContext.floor_number)}` : `${fixedContext.floor_number}`}층 ·{' '}
        {fixedContext.module_name}
      </p>
      <MultipartUploader fixedContext={fixedContext} />
    </div>
  );
}

export default function UploadPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64 text-gray-500">로딩 중...</div>}>
      <UploadContent />
    </Suspense>
  );
}
