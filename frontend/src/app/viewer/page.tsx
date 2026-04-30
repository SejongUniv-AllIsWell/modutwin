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
  const initialMode = (searchParams.get('mode') as EditorMode) ?? null;

  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | undefined>();
  const [resolving, setResolving] = useState(!!uploadId);

  // upload_id가 있으면 해당 파일의 presigned URL fetch (정합 모드는 refined 우선)
  useEffect(() => {
    if (!uploadId) {
      setResolving(false);
      return;
    }
    setResolving(true);
    const variant = initialMode === 'align' ? 'refined' : '';
    const qs = variant ? `?variant=${variant}` : '';
    api.get<{ url: string; filename: string }>(`/uploads/${uploadId}/presigned-url${qs}`)
      .then(data => {
        setFileUrl(data.url);
        const name = data.filename ?? '';
        if (variant && name && !name.includes(variant)) {
          const dotIdx = name.lastIndexOf('.');
          const base = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
          const ext = dotIdx >= 0 ? name.slice(dotIdx) : '';
          setFilename(`${base}_${variant}${ext}`);
        } else {
          setFilename(name);
        }
      })
      .catch(() => setFileUrl(null))
      .finally(() => setResolving(false));
  }, [uploadId, initialMode]);

  if (resolving) {
    return (
      <div className="flex items-center justify-center h-[calc(100dvh-56px)] text-gray-500">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">파일 로딩 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-[calc(100dvh-56px)] bg-[#141414]">
      <UnifiedSplatEditor
        initialSogUrl={fileUrl}
        initialUploadId={uploadId}
        initialDisplayName={filename}
        initialMode={initialMode}
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
