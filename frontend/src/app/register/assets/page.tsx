'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

// 3DGS 에셋(.ply / .splat / .sog) 등록은 기존 basemap/module 등록 흐름을 그대로 사용한다.
// 그 흐름은 /viewer 가 파일 선택 → 다듬기 단계를 처리하므로, 컨텍스트 qs 를 그대로 넘겨 리다이렉트한다.
function AssetsRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const qs = searchParams.toString();
    router.replace(qs ? `/viewer?${qs}` : '/viewer');
  }, [router, searchParams]);

  return (
    <div className="flex items-center justify-center h-[calc(100vh-56px)] bg-[var(--bg)] text-[var(--muted)]">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm">에디터로 이동 중...</p>
      </div>
    </div>
  );
}

export default function RegisterAssetsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64 bg-[var(--bg)] text-[var(--muted)]">로딩 중...</div>
      }
    >
      <AssetsRedirect />
    </Suspense>
  );
}
