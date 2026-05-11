'use client';

import { Suspense, useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import MultipartUploader from '@/components/upload/MultipartUploader';
import { useSearchParams } from 'next/navigation';

function UploadContent() {
  const { user, loading } = useAuth();
  const searchParams = useSearchParams();
  const buildingId = searchParams.get('building_id') ?? '';
  const buildingName = searchParams.get('building_name') ?? '';
  const floorId = searchParams.get('floor_id') ?? '';
  const floorNumber = Number(searchParams.get('floor_number') ?? NaN);
  const fixedContext =
    buildingId && buildingName && floorId && Number.isFinite(floorNumber)
      ? { building_id: buildingId, building_name: buildingName, floor_id: floorId, floor_number: floorNumber }
      : null;

  useEffect(() => {
    if (!loading && !user) {
      window.location.href = '/';
    }
  }, [user, loading]);

  if (loading || !user) return <div className="flex items-center justify-center h-64 text-gray-500">로딩 중...</div>;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-2">업로드</h1>
      <p className="text-gray-400 text-sm mb-8">건물 내부 이미지 / 영상 / 3DGS 결과 파일(.ply / .splat / .sog / .zip)을 업로드하세요.</p>
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
