'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { wsClient } from '@/lib/ws';
import { Upload, Notification, WsMessage } from '@/types';
import { useToast } from '@/components/ui/Toast';

const VIEWABLE_EXTENSIONS = new Set(['.ply', '.splat', '.sog']);

function isViewable(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return VIEWABLE_EXTENSIONS.has(ext);
}

// 파이프라인 진행 단계 라벨 — 업로드(MinIO) 상태가 아니라 사용자가 어디까지 진행했는지 표시.
//   failed → 실패
//   has_alignment → 정합 완료 (정합 행렬 저장됨)
//   has_doors_json → 문 꼭짓점 지정 (정합 진행 중)
//   has_refined → 다듬기 완료
//   completed (refined 없음) → 업로드 완료
//   uploaded / processing → 그대로
type ProgressStage =
  | 'failed' | 'aligned' | 'doors' | 'refined'
  | 'uploaded_only' | 'uploaded' | 'processing';

const STAGE_LABEL: Record<ProgressStage, string> = {
  failed:        '실패',
  aligned:       '정합 완료',
  doors:         '문 꼭짓점 지정',
  refined:       '다듬기 완료',
  uploaded_only: '업로드 완료',
  uploaded:      '업로드됨',
  processing:    '처리 중',
};

const STAGE_COLOR: Record<ProgressStage, string> = {
  failed:        'text-red-400',
  aligned:       'text-cyan-400',
  doors:         'text-purple-400',
  refined:       'text-blue-400',
  uploaded_only: 'text-green-400',
  uploaded:      'text-[var(--muted)]',
  processing:    'text-yellow-400',
};

function progressStage(u: { status: string; has_refined?: boolean; has_doors_json?: boolean; has_alignment?: boolean }): ProgressStage {
  if (u.status === 'failed') return 'failed';
  if (u.status === 'processing') return 'processing';
  if (u.status === 'uploaded') return 'uploaded';
  // status === 'completed': 다듬기/정합 진행 단계로 더 세분화.
  if (u.has_alignment) return 'aligned';
  if (u.has_doors_json) return 'doors';
  if (u.has_refined) return 'refined';
  return 'uploaded_only';
}

const SAM3_LABEL: Record<string, string> = {
  pending: '대기',
  running: 'SAM3 작동 중',
  done: '완료',
  failed: '실패',
};

const SAM3_COLOR: Record<string, string> = {
  pending: 'text-[var(--muted)]',
  running: 'text-yellow-400',
  done: 'text-green-400',
  failed: 'text-red-400',
};

interface Props {
  showHeader?: boolean;
}

export default function UserDashboard({ showHeader = true }: Props) {
  const router = useRouter();
  const { show: showToast } = useToast();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Upload | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // COLMAP 결과 PLY 를 PC 로 다운로드 + viewer 이동 처리 중인 업로드 id (중복 클릭 방지).
  const [fetchingColmapId, setFetchingColmapId] = useState<string | null>(null);

  // 사용자 PC 에 다운로드 트리거 후 같은 upload_id 로 /viewer 이동 (refine 모드 자동 시작).
  // presigned URL 을 받아 <a download> 로 저장 → router.push 로 viewer 진입.
  const handleColmapSelect = async (uploadId: string) => {
    if (fetchingColmapId) return;
    setFetchingColmapId(uploadId);
    try {
      const data = await api.get<{ url: string; filename: string }>(
        `/uploads/${uploadId}/presigned-url`,
      );
      const a = document.createElement('a');
      a.href = data.url;
      const fname = data.filename || 'gsplat.ply';
      a.download = fname.endsWith('.ply') ? fname : `${fname}.ply`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      router.push(`/viewer?upload_id=${uploadId}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`파일을 가져오지 못했습니다: ${msg}`, 'error');
      setFetchingColmapId(null);
    }
  };

  useEffect(() => {
    api.get<Upload[]>('/uploads').then(setUploads).catch(() => {});
    api.get<Notification[]>('/notifications').then(setNotifications).catch(() => {});

    const unsub = wsClient.subscribe((msg: WsMessage) => {
      if (msg.type === 'task_complete' || msg.type === 'task_failed') {
        api.get<Upload[]>('/uploads').then(setUploads).catch(() => {});
        api.get<Notification[]>('/notifications').then(setNotifications).catch(() => {});
      }
    });

    return () => { unsub(); };
  }, []);

  const markAllRead = async () => {
    await api.post('/notifications/read-all');
    setNotifications([]);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.delete(`/uploads/${deleteTarget.id}`);
      setUploads(prev => prev.filter(u => u.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (e: any) {
      setDeleteError(e?.message || '업로드 삭제 실패');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      {showHeader && (
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold">대시보드</h1>
          <div className="flex items-center gap-2">
            <Link href="/viewer" className="bg-[var(--bg-soft)] hover:bg-[var(--rule)] text-[var(--ink)] text-sm px-4 py-2 rounded">
              뷰어
            </Link>
            <Link href="/upload" className="bg-blue-600 hover:bg-blue-700 text-[var(--ink)] text-sm px-4 py-2 rounded">
              업로드
            </Link>
          </div>
        </div>
      )}

      {notifications.length > 0 && (
        <div className="mb-6 bg-[var(--paper)] border border-[var(--rule)] rounded-lg p-4">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-sm font-semibold text-[var(--ink-2)]">알림 ({notifications.length})</h2>
            <button onClick={markAllRead} className="text-xs text-blue-400 hover:text-blue-300">모두 읽음</button>
          </div>
          {notifications.slice(0, 5).map(n => (
            <div key={n.id} className="text-sm text-[var(--muted)] py-1 border-b border-[var(--rule)] last:border-0">
              {n.message}
            </div>
          ))}
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-4">업로드 내역</h2>
        {uploads.length === 0 ? (
          <p className="text-[var(--muted)] text-sm">아직 업로드한 파일이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)] text-left border-b border-[var(--rule)]">
                  <th className="py-2 pr-4">파일명</th>
                  <th className="py-2 pr-4">상태</th>
                  <th className="py-2 pr-4">SAM3</th>
                  <th className="py-2 pr-4">날짜</th>
                  <th className="py-2 pr-4 text-right">삭제</th>
                </tr>
              </thead>
              <tbody>
                {uploads.map(u => {
                  const sam = u.sam3_status ?? null;
                  const stage = progressStage(u);
                  const isColmap = u.ply_target === 'colmap';
                  const colmapDone = isColmap && u.status === 'completed' && !!u.has_gsplat_ply;
                  const colmapProcessing = isColmap && u.status === 'processing';
                  const colmapFailed = isColmap && u.status === 'failed';
                  const filenameClickable = isViewable(u.original_filename) || colmapDone;
                  const isBasemap = !!u.is_basemap_source;
                  const canAlign = !isColmap && (!!u.has_refined || !!u.has_doors_json);
                  return (
                    <tr key={u.id} className="border-b border-[var(--rule)]/50">
                      <td className="py-3 pr-4">
                        {isColmap && colmapDone ? (
                          <button
                            type="button"
                            disabled={fetchingColmapId === u.id}
                            onClick={() => handleColmapSelect(u.id)}
                            className="text-blue-400 hover:underline disabled:opacity-60 disabled:cursor-wait"
                          >
                            {u.original_filename}
                          </button>
                        ) : filenameClickable ? (
                          <Link
                            href={u.has_refined
                              ? `/viewer?upload_id=${u.id}&mode=align`
                              : `/viewer?upload_id=${u.id}`}
                            className="text-blue-400 hover:underline"
                          >
                            {u.original_filename}
                          </Link>
                        ) : (
                          <span className="text-[var(--ink-2)]">{u.original_filename}</span>
                        )}
                      </td>
                      <td className={`py-3 pr-4 ${
                        isColmap
                          ? (colmapFailed ? 'text-red-400' : (colmapDone ? 'text-blue-400' : 'text-emerald-400'))
                          : STAGE_COLOR[stage]
                      }`}>
                        {isColmap
                          ? (colmapFailed
                              ? 'COLMAP 실패'
                              : colmapDone
                                ? '학습 완료'
                                : colmapProcessing
                                  ? 'COLMAP 처리 중'
                                  : 'COLMAP 대기')
                          : STAGE_LABEL[stage]}
                      </td>
                      <td className={`py-3 pr-4 ${sam ? SAM3_COLOR[sam] : 'text-[var(--muted-2)]'}`}>
                        {isColmap ? '—' : (sam ? SAM3_LABEL[sam] : '—')}
                      </td>
                      <td className="py-3 pr-4 text-[var(--muted)]">{new Date(u.uploaded_at).toLocaleDateString('ko-KR')}</td>
                      <td className="py-3 pr-4 text-right">
                        {isColmap ? (
                          colmapDone ? (
                            <button
                              type="button"
                              disabled={fetchingColmapId === u.id}
                              onClick={() => handleColmapSelect(u.id)}
                              className="inline-block px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] text-[var(--ink)] text-xs font-bold"
                              title="PLY를 PC에 저장하고 다듬기 단계로 이동"
                            >
                              {fetchingColmapId === u.id ? '준비 중...' : '파일 선택'}
                            </button>
                          ) : (
                            <Link
                              href={`/colmap-viewer?upload_id=${u.id}`}
                              className="inline-block px-3 py-1 rounded bg-[var(--bg-soft)] hover:bg-[var(--rule)] text-[var(--ink)] text-xs font-bold"
                            >
                              처리 중...
                            </Link>
                          )
                        ) : isBasemap ? (
                          <span className="relative inline-block group">
                            <button
                              type="button"
                              disabled
                              aria-label="basemap에 등록된 파일은 삭제할 수 없습니다"
                              className="w-6 h-6 inline-flex items-center justify-center text-[var(--muted-2)] rounded cursor-not-allowed"
                            >
                              ×
                            </button>
                            <span
                              role="tooltip"
                              className="pointer-events-none absolute right-0 top-full mt-1 z-10 whitespace-nowrap rounded bg-[var(--bg-soft)] px-2 py-1 text-[10px] text-[var(--ink)] opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              관리자에게 문의하세요
                            </span>
                          </span>
                        ) : canAlign ? (
                          <Link
                            href={`/viewer?upload_id=${u.id}&mode=align`}
                            className="inline-block px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-[var(--ink)] text-xs font-bold"
                            title={sam === 'done' ? 'SAM3 결과로 정합 시작' : '수동으로 문 꼭짓점을 지정해 정합'}
                          >
                            정합하기
                          </Link>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(u)}
                            aria-label={`${u.original_filename} 삭제`}
                            title={`${u.original_filename} 삭제`}
                            className="w-6 h-6 inline-flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] hover:bg-red-600 rounded"
                          >
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-lg border border-[var(--rule)] bg-[var(--paper)] p-5 shadow-xl">
            <h3 className="text-base font-semibold text-[var(--ink)]">업로드 삭제</h3>
            <p className="mt-3 text-sm text-red-300">
              삭제 시 업로드한 파일과 관련된 모든 데이터가 삭제됩니다.
            </p>
            <p className="mt-2 text-sm text-[var(--ink-2)] truncate">
              대상: {deleteTarget.original_filename}
            </p>
            {deleteError && (
              <p className="mt-2 text-xs text-red-400">{deleteError}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-[var(--ink)] hover:bg-red-700 disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)]"
              >
                {deleting ? '삭제 중...' : '삭제'}
              </button>
              <button
                type="button"
                onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(null); } }}
                disabled={deleting}
                className="rounded bg-[var(--bg-soft)] px-4 py-2 text-sm text-[var(--ink)] hover:bg-[var(--rule)] disabled:opacity-50"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
