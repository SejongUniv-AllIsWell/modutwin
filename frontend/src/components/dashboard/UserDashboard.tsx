'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { wsClient } from '@/lib/ws';
import { Upload, Notification, WsMessage } from '@/types';

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
  uploaded:      'text-gray-400',
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
  pending: 'text-gray-400',
  running: 'text-yellow-400',
  done: 'text-green-400',
  failed: 'text-red-400',
};

interface Props {
  showHeader?: boolean;
}

export default function UserDashboard({ showHeader = true }: Props) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Upload | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
            <Link href="/viewer" className="bg-gray-700 hover:bg-gray-600 text-white text-sm px-4 py-2 rounded">
              뷰어
            </Link>
            <Link href="/upload" className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-2 rounded">
              업로드
            </Link>
          </div>
        </div>
      )}

      {notifications.length > 0 && (
        <div className="mb-6 bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-sm font-semibold text-gray-300">알림 ({notifications.length})</h2>
            <button onClick={markAllRead} className="text-xs text-blue-400 hover:text-blue-300">모두 읽음</button>
          </div>
          {notifications.slice(0, 5).map(n => (
            <div key={n.id} className="text-sm text-gray-400 py-1 border-b border-gray-800 last:border-0">
              {n.message}
            </div>
          ))}
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-4">업로드 내역</h2>
        {uploads.length === 0 ? (
          <p className="text-gray-500 text-sm">아직 업로드한 파일이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-left border-b border-gray-800">
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
                  const isBasemap = !!u.is_basemap_source;
                  return (
                    <tr key={u.id} className="border-b border-gray-800/50">
                      <td className="py-3 pr-4">
                        {isViewable(u.original_filename) ? (
                          <Link
                            href={u.has_refined
                              ? `/viewer?upload_id=${u.id}&mode=align`
                              : `/viewer?upload_id=${u.id}`}
                            className="text-blue-400 hover:underline"
                          >
                            {u.original_filename}
                          </Link>
                        ) : (
                          <span className="text-gray-300">{u.original_filename}</span>
                        )}
                      </td>
                      <td className={`py-3 pr-4 ${STAGE_COLOR[stage]}`}>{STAGE_LABEL[stage]}</td>
                      <td className={`py-3 pr-4 ${sam ? SAM3_COLOR[sam] : 'text-gray-600'}`}>
                        {sam ? SAM3_LABEL[sam] : '—'}
                      </td>
                      <td className="py-3 pr-4 text-gray-500">{new Date(u.uploaded_at).toLocaleDateString('ko-KR')}</td>
                      <td className="py-3 pr-4 text-right">
                        {isBasemap ? (
                          <span className="relative inline-block group">
                            <button
                              type="button"
                              disabled
                              aria-label="basemap에 등록된 파일은 삭제할 수 없습니다"
                              className="w-6 h-6 inline-flex items-center justify-center text-gray-600 rounded cursor-not-allowed"
                            >
                              ×
                            </button>
                            <span
                              role="tooltip"
                              className="pointer-events-none absolute right-0 top-full mt-1 z-10 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-[10px] text-gray-200 opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              관리자에게 문의하세요
                            </span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(u)}
                            aria-label={`${u.original_filename} 삭제`}
                            title={`${u.original_filename} 삭제`}
                            className="w-6 h-6 inline-flex items-center justify-center text-gray-400 hover:text-white hover:bg-red-600 rounded"
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
          <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-5 shadow-xl">
            <h3 className="text-base font-semibold text-white">업로드 삭제</h3>
            <p className="mt-3 text-sm text-red-300">
              삭제 시 업로드한 파일과 관련된 모든 데이터가 삭제됩니다.
            </p>
            <p className="mt-2 text-sm text-gray-300 truncate">
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
                className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-gray-700 disabled:text-gray-400"
              >
                {deleting ? '삭제 중...' : '삭제'}
              </button>
              <button
                type="button"
                onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(null); } }}
                disabled={deleting}
                className="rounded bg-gray-700 px-4 py-2 text-sm text-gray-200 hover:bg-gray-600 disabled:opacity-50"
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
