'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { Upload } from '@/types';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import type { SplatEntry } from '@/components/viewer/SplatViewerCore';

const SplatViewerCore = dynamic(
  () => import('@/components/viewer/SplatViewerCore'),
  { ssr: false },
);

const VIEWABLE_EXT = new Set(['.ply', '.splat', '.sog']);

function isViewable(filename: string) {
  return VIEWABLE_EXT.has(filename.slice(filename.lastIndexOf('.')).toLowerCase());
}

interface LoadedSplat {
  uploadId: string;
  url: string;
  visible: boolean;
}

export default function MultiViewerPage() {
  const { user, loading } = useRequireAuth();
  const router = useRouter();

  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loadingUploads, setLoadingUploads] = useState(true);
  const [loadedSplats, setLoadedSplats] = useState<LoadedSplat[]>([]);
  const [fetchingIds, setFetchingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;
    api.get<Upload[]>('/uploads')
      .then(data => setUploads(data.filter(u => isViewable(u.original_filename))))
      .catch(() => {})
      .finally(() => setLoadingUploads(false));
  }, [user]);

  const isLoaded = (id: string) => loadedSplats.some(s => s.uploadId === id);

  const handleLoad = async (upload: Upload) => {
    if (isLoaded(upload.id) || fetchingIds.has(upload.id)) return;

    setFetchingIds(prev => new Set(prev).add(upload.id));
    try {
      const data = await api.get<{ url: string }>(`/uploads/${upload.id}/presigned-url`);
      setLoadedSplats(prev => [...prev, { uploadId: upload.id, url: data.url, visible: true }]);
    } catch { /* 실패 무시 */ } finally {
      setFetchingIds(prev => { const n = new Set(prev); n.delete(upload.id); return n; });
    }
  };

  const handleToggle = (uploadId: string) =>
    setLoadedSplats(prev => prev.map(s => s.uploadId === uploadId ? { ...s, visible: !s.visible } : s));

  const handleRemove = (uploadId: string) =>
    setLoadedSplats(prev => prev.filter(s => s.uploadId !== uploadId));

  const splats: SplatEntry[] = loadedSplats.map(s => ({
    id: s.uploadId,
    url: s.url,
    visible: s.visible,
  }));

  const visibleCount = loadedSplats.filter(s => s.visible).length;

  if (loading || !user) {
    return <div className="flex items-center justify-center h-[calc(100dvh-56px)] text-[var(--muted)]">로딩 중...</div>;
  }

  return (
    <div className="flex h-[calc(100dvh-56px)]">
      {/* ── 왼쪽 패널 ── */}
      <div className="w-64 flex flex-col border-r border-[var(--rule)] bg-[var(--paper)] shrink-0">
        {/* 헤더 */}
        <div className="px-4 py-3 border-b border-[var(--rule)]">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--ink-2)] transition mb-2"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            대시보드
          </button>
          <h2 className="text-sm font-semibold text-[var(--ink)]">내 파일</h2>
          <p className="text-[11px] text-[var(--muted)] mt-0.5">+ 버튼으로 뷰어에 추가</p>
        </div>

        {/* 파일 목록 */}
        <div className="flex-1 overflow-y-auto">
          {loadingUploads ? (
            <div className="flex items-center justify-center h-24 text-[var(--muted-2)] text-xs">불러오는 중...</div>
          ) : uploads.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-[var(--muted-2)] text-xs">파일 없음</div>
          ) : (
            <div className="divide-y divide-gray-800/50">
              {uploads.map(u => {
                const loaded = loadedSplats.find(s => s.uploadId === u.id);
                const fetching = fetchingIds.has(u.id);
                return (
                  <div key={u.id} className="px-3 py-2.5 flex items-center gap-2">
                    {/* 파일명 */}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-[var(--ink-2)] truncate" title={u.original_filename}>
                        {u.original_filename}
                      </p>
                      <p className="text-[10px] text-[var(--muted-2)] mt-0.5">
                        {new Date(u.uploaded_at).toLocaleDateString('ko-KR')}
                      </p>
                    </div>

                    {/* 액션 버튼 */}
                    {loaded ? (
                      <div className="flex items-center gap-0.5 shrink-0">
                        {/* 가시성 토글 */}
                        <button
                          onClick={() => handleToggle(u.id)}
                          title={loaded.visible ? '숨기기' : '보이기'}
                          className={`p-1.5 rounded transition ${
                            loaded.visible
                              ? 'text-blue-400 hover:text-blue-300'
                              : 'text-[var(--muted-2)] hover:text-[var(--muted)]'
                          }`}
                        >
                          {loaded.visible ? (
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                          ) : (
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                            </svg>
                          )}
                        </button>
                        {/* 제거 */}
                        <button
                          onClick={() => handleRemove(u.id)}
                          title="제거"
                          className="p-1.5 rounded text-[var(--muted-2)] hover:text-red-400 transition"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleLoad(u)}
                        disabled={fetching}
                        title="뷰어에 추가"
                        className="shrink-0 p-1.5 rounded text-[var(--muted)] hover:text-green-400 transition disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {fetching ? (
                          <div className="w-3.5 h-3.5 border border-blue-400 border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 하단 상태 표시 */}
        <div className="px-4 py-2 border-t border-[var(--rule)] text-[11px] text-[var(--muted)]">
          {loadedSplats.length === 0
            ? '표시 중인 파일 없음'
            : `${visibleCount} / ${loadedSplats.length}개 표시 중`}
        </div>
      </div>

      {/* ── 오른쪽: 3D 뷰어 ── */}
      <div className="flex-1 min-w-0">
        <SplatViewerCore splats={splats} />
      </div>
    </div>
  );
}
