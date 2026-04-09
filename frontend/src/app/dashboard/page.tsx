'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { wsClient } from '@/lib/ws';
import { Upload, Task, Notification, WsMessage } from '@/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const VIEWABLE_EXTENSIONS = new Set(['.ply', '.splat', '.sog']);

function isViewable(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return VIEWABLE_EXTENSIONS.has(ext);
}

export default function DashboardPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    if (!loading && !user) {
      window.location.href = '/';
    }
  }, [user, loading]);

  useEffect(() => {
    if (!user) return;

    api.get<Upload[]>('/uploads').then(setUploads).catch(() => {});
    api.get<Task[]>('/tasks').then(setTasks).catch(() => {});
    api.get<Notification[]>('/notifications').then(setNotifications).catch(() => {});

    const unsub = wsClient.subscribe((msg: WsMessage) => {
      if (msg.type === 'progress' && msg.task_id) {
        setTasks(prev => prev.map(t =>
          t.id === msg.task_id
            ? { ...t, progress: msg.progress || 0, status: 'running' as const }
            : t
        ));
      }
      if (msg.type === 'task_complete' || msg.type === 'task_failed') {
        api.get<Task[]>('/tasks').then(setTasks).catch(() => {});
        api.get<Notification[]>('/notifications').then(setNotifications).catch(() => {});
      }
    });

    return () => { unsub(); };
  }, [user]);

  const markAllRead = async () => {
    await api.post('/notifications/read-all');
    setNotifications([]);
  };

  if (loading || !user) return <div className="flex items-center justify-center h-64 text-gray-500">로딩 중...</div>;

  const statusLabel: Record<string, string> = {
    uploaded: '업로드됨',
    processing: '처리 중',
    completed: '완료',
    failed: '실패',
    pending: '대기',
    running: '실행 중',
  };

  const statusColor: Record<string, string> = {
    uploaded: 'text-gray-400',
    processing: 'text-yellow-400',
    completed: 'text-green-400',
    failed: 'text-red-400',
    pending: 'text-gray-400',
    running: 'text-yellow-400',
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">대시보드</h1>
        <Link href="/upload" className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-2 rounded">
          새 업로드
        </Link>
      </div>

      {/* 알림 */}
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

      {/* 태스크 */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-4">태스크</h2>
        {tasks.length === 0 ? (
          <p className="text-gray-500 text-sm">아직 태스크가 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {tasks.map(task => (
              <div key={task.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <div className="flex justify-between items-center">
                  <div>
                    <span className="text-sm font-medium">{task.task_type}</span>
                    <span className={`ml-3 text-xs ${statusColor[task.status]}`}>{statusLabel[task.status]}</span>
                  </div>
                  <span className="text-xs text-gray-500">
                    {new Date(task.created_at).toLocaleString('ko-KR')}
                  </span>
                </div>
                {task.status === 'running' && (
                  <div className="mt-2">
                    <div className="w-full bg-gray-700 rounded-full h-1.5">
                      <div className="bg-blue-500 h-1.5 rounded-full transition-all" style={{ width: `${task.progress}%` }} />
                    </div>
                    <span className="text-xs text-gray-500 mt-1">{task.progress}%</span>
                  </div>
                )}
                {task.error_message && (
                  <p className="text-xs text-red-400 mt-2">{task.error_message}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 업로드 목록 */}
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
                  <th className="py-2 pr-4">저장 위치</th>
                  <th className="py-2 pr-4">상태</th>
                  <th className="py-2 pr-4">날짜</th>
                  <th className="py-2 pr-4">다듬기</th>
                  <th className="py-2">정합</th>
                </tr>
              </thead>
              <tbody>
                {uploads.map(u => (
                  <tr key={u.id} className="border-b border-gray-800/50">
                    <td className="py-3 pr-4 text-gray-300">{u.original_filename}</td>
                    <td className="py-3 pr-4 text-gray-400 text-xs">
                      {u.ply_target ? (
                        <span className={`px-1.5 py-0.5 rounded ${u.ply_target === 'alignment' ? 'bg-orange-500/20 text-orange-400' : 'bg-blue-500/20 text-blue-400'}`}>
                          {u.ply_target}
                        </span>
                      ) : 'web_input'}
                    </td>
                    <td className={`py-3 pr-4 ${statusColor[u.status]}`}>{statusLabel[u.status]}</td>
                    <td className="py-3 pr-4 text-gray-500">{new Date(u.uploaded_at).toLocaleDateString('ko-KR')}</td>
                    <td className="py-3 pr-4">
                      {isViewable(u.original_filename) && (
                        <button
                          onClick={() => router.push(`/viewer?upload_id=${u.id}&mode=refine`)}
                          title="다듬기"
                          className="text-gray-500 hover:text-orange-400 transition"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                          </svg>
                        </button>
                      )}
                    </td>
                    <td className="py-3">
                      {isViewable(u.original_filename) && (
                        <button
                          onClick={() => router.push(`/viewer?upload_id=${u.id}&mode=align`)}
                          title="정합"
                          className="text-gray-500 hover:text-blue-400 transition"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                          </svg>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
