'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { floorLabelKo } from '@/lib/format/floor';
import { Button } from '@/components/ui/Button';
import { parseRegisterContext } from '@/lib/upload/registerContext';

const OPTIONS: { sub: 'video' | 'assets' | 'images'; title: string; desc: string }[] = [
  {
    sub: 'video',
    title: '영상 등록',
    desc: '휴대폰·드론 영상 한 편을 올리면 프레임 추출 · SfM · 3DGS 학습을 자동으로 진행합니다.',
  },
  {
    sub: 'assets',
    title: '3DGS 에셋 등록',
    desc: '이미 학습한 .ply / .splat / .sog 에셋을 직접 업로드해 곧바로 다듬기 단계로 진행합니다.',
  },
  {
    sub: 'images',
    title: '이미지 + SfM 등록',
    desc: '직접 찍은 사진 묶음(.zip)을 올리면 SfM · 재구성을 자동으로 진행합니다.',
  },
];

function RegisterContent() {
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
          <h1 className="text-2xl font-bold mb-3">등록</h1>
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

  const qs = searchParams.toString();
  const go = (sub: string) => router.push(`/register/${sub}?${qs}`);

  return (
    <div className="min-h-[calc(100vh-56px)] bg-[var(--bg)] text-[var(--ink)] px-4 py-8">
      <div className="max-w-2xl mx-auto">
        <div className="rounded-md border p-6 mb-5" style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}>
          <h1 className="text-2xl font-bold mb-2">{ctx.purpose === 'basemap' ? 'Basemap 등록' : '모듈 등록'}</h1>
          <p className="text-[var(--muted)] text-sm mb-2">등록 방식을 선택하세요.</p>
          <p className="text-[var(--muted)] text-xs">
            {ctx.purpose === 'basemap' ? 'Basemap' : 'Module'} · {ctx.building_name} · {floorLabelKo(ctx.floor_number)}
            {ctx.module_name ? ` · ${ctx.module_name}` : ''}
          </p>
        </div>

        <div className="space-y-3">
          {OPTIONS.map((opt) => (
            <button
              key={opt.sub}
              type="button"
              onClick={() => go(opt.sub)}
              className="w-full text-left rounded-md border p-5 transition-colors hover:border-[var(--accent)]"
              style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-base font-semibold mb-1" style={{ color: 'var(--ink)' }}>
                    {opt.title}
                  </div>
                  <p className="text-sm" style={{ color: 'var(--muted)' }}>
                    {opt.desc}
                  </p>
                </div>
                <svg
                  className="w-5 h-5 shrink-0"
                  style={{ color: 'var(--muted)' }}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64 bg-[var(--bg)] text-[var(--muted)]">로딩 중...</div>
      }
    >
      <RegisterContent />
    </Suspense>
  );
}
