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

const STATUS_LABEL: Record<string, string> = {
  uploaded: '업로드됨',
  processing: '처리 중',
  completed: '완료',
  failed: '실패',
};

const STATUS_COLOR: Record<string, string> = {
  uploaded: 'text-gray-400',
  processing: 'text-yellow-400',
  completed: 'text-green-400',
  failed: 'text-red-400',
};

interface Props {
  showHeader?: boolean;
}

export default function UserDashboard({ showHeader = true }: Props) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);

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
                  <th className="py-2">날짜</th>
                </tr>
              </thead>
              <tbody>
                {uploads.map(u => (
                  <tr key={u.id} className="border-b border-gray-800/50">
                    <td className="py-3 pr-4">
                      {isViewable(u.original_filename) ? (
                        <Link
                          href={`/viewer?upload_id=${u.id}`}
                          className="text-blue-400 hover:underline"
                        >
                          {u.original_filename}
                        </Link>
                      ) : (
                        <span className="text-gray-300">{u.original_filename}</span>
                      )}
                    </td>
                    <td className={`py-3 pr-4 ${STATUS_COLOR[u.status]}`}>{STATUS_LABEL[u.status]}</td>
                    <td className="py-3 text-gray-500">{new Date(u.uploaded_at).toLocaleDateString('ko-KR')}</td>
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
