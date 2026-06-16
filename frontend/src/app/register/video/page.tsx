'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { floorLabelKo } from '@/lib/format/floor';
import { Button } from '@/components/ui/Button';
import ColmapRegisterUploader from '@/components/upload/ColmapRegisterUploader';
import { parseRegisterContext } from '@/lib/upload/registerContext';

function VideoContent() {
  const router = useRouter();
  const { user, loading } = useRequireAuth();
  const searchParams = useSearchParams();
  const ctx = parseRegisterContext(searchParams);

  if (loading || !user) {
    return (
      <div className="flex items-center justify-center h-64 bg-[var(--bg)] text-[var(--muted)]">로딩 중...</div>
    );
  }

  if (!ctx) {
    return (
      <div className="min-h-[calc(100vh-56px)] bg-[var(--bg)] text-[var(--ink)] px-4 py-16">
        <div
          className="max-w-2xl mx-auto text-center rounded-md border p-8"
          style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
        >
          <h1 className="text-2xl font-bold mb-3">영상 등록</h1>
          <p className="text-[var(--muted)] text-sm mb-6">
            등록은 건물 상세 페이지의 등록 버튼을 통해 시작할 수 있습니다.
          </p>
          <Button type="button" onClick={() => router.push('/explore')}>
            건물 둘러보기로 이동
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-56px)] bg-[var(--bg)] text-[var(--ink)] px-4 py-8">
      <div className="max-w-2xl mx-auto">
        <div className="rounded-md border p-6 mb-5" style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}>
          <h1 className="text-2xl font-bold mb-2">영상 등록</h1>
          <p className="text-[var(--muted)] text-sm mb-2">
            영상을 업로드하면 프레임 추출 · SfM · 3DGS 학습을 백그라운드에서 자동 진행합니다.
          </p>
          <p className="text-[var(--muted)] text-xs">
            {ctx.purpose === 'basemap' ? 'Basemap' : 'Module'} · {ctx.building_name} · {floorLabelKo(ctx.floor_number)}
            {ctx.module_name ? ` · ${ctx.module_name}` : ''}
          </p>
        </div>
        <ColmapRegisterUploader fixedContext={ctx} kind="video" />
      </div>
    </div>
  );
}

export default function RegisterVideoPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64 bg-[var(--bg)] text-[var(--muted)]">로딩 중...</div>
      }
    >
      <VideoContent />
    </Suspense>
  );
}
