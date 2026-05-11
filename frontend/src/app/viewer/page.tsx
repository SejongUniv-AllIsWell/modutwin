'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import dynamic from 'next/dynamic';
import type { EditorMode } from '@/components/viewer/UnifiedSplatEditor';

const UnifiedSplatEditor = dynamic(
  () => import('@/components/viewer/UnifiedSplatEditor'),
  { ssr: false },
);

function ViewerContent() {
  const searchParams = useSearchParams();
  const uploadId = searchParams.get('upload_id') ?? undefined;
  // 초기 모드:
  //  - URL 에 mode 명시 (예: /viewer?upload_id=X&mode=align) 면 그것을 우선
  //  - upload_id 만 있으면 파일이 함께 로드되므로 'refine' (다듬기) 시작
  //  - 둘 다 없으면 null → "파일" 단계 (UnifiedSplatEditor 가 파일 선택 시 자동으로 'refine' 으로 전환)
  const explicitMode = searchParams.get('mode') as EditorMode | null;
  const initialMode: EditorMode = explicitMode ?? (uploadId ? 'refine' : null);

  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | undefined>();
  // 백엔드가 실제로 서빙한 variant — 메모리 PLY 가 raw 인지 회전 베이크된 refined 인지 구분.
  // SAM3 자동추출 prefill 변환이 좌표 frame 분기에 사용 (DoorAlignModal).
  const [servedVariant, setServedVariant] = useState<'original' | 'refined' | null>(null);
  const [resolving, setResolving] = useState(!!uploadId);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // upload_id가 있으면 해당 파일의 presigned URL fetch (정합 모드는 refined 우선)
  useEffect(() => {
    if (!uploadId) {
      setResolving(false);
      return;
    }
    setResolving(true);
    setResolveError(null);
    // 항상 refined 우선 요청 — 다듬기 산출물이 있으면 그 frame (A'+Y baked) 로 로드해
    // mesh.json / wallMesh / doors.json 등 다른 영속 자산과 frame 일관. refined 가 없으면
    // backend 가 자동으로 original 로 fallback (presigned-url 라우트 참조).
    const variant = 'refined';
    const qs = `?variant=${variant}`;
    api.get<{ url: string; filename: string; variant?: string }>(`/uploads/${uploadId}/presigned-url${qs}`)
      .then(data => {
        setFileUrl(data.url);
        const name = data.filename ?? '';
        // 백엔드가 실제로 서빙한 variant 가 요청 variant 와 다를 수 있음 (원본 부재 → refined fallback).
        const served = data.variant ?? '';
        setServedVariant(served === 'refined' ? 'refined' : 'original');
        const labelVariant = served === 'refined' ? 'refined' : '';
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
  }, [uploadId, initialMode]);

  if (resolving) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-56px)] text-gray-500">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">파일 로딩 중...</p>
        </div>
      </div>
    );
  }

  if (resolveError) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-56px)] text-gray-300">
        <div className="text-center max-w-md px-6">
          <p className="text-sm font-bold text-red-400 mb-2">파일을 열 수 없습니다</p>
          <p className="text-xs text-gray-500 leading-relaxed">{resolveError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-[calc(100vh-56px)] bg-[#141414]">
      <UnifiedSplatEditor
        initialSogUrl={fileUrl}
        initialUploadId={uploadId}
        initialDisplayName={filename}
        initialMode={initialMode}
        initialServedVariant={servedVariant}
      />
    </div>
  );
}

export default function ViewerPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-[calc(100vh-56px)] text-gray-500">로딩 중...</div>}>
      <ViewerContent />
    </Suspense>
  );
}
