'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';

interface Basemap {
  id: string;
  floor_id: string;
  version: number;
  status: string;
  is_active: boolean;
  created_at: string;
}

export default function AdminBasemapsPage() {
  const { user, loading } = useAuth();
  const [basemaps, setBasemaps] = useState<Basemap[]>([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!loading && (!user || user.role !== 'admin')) {
      window.location.href = '/dashboard';
      return;
    }
    loadBasemaps();
  }, [user, loading]);

  const loadBasemaps = async () => {
    try {
      const data = await api.get<Basemap[]>('/admin/basemaps');
      setBasemaps(data);
    } catch {
      // basemaps API가 아직 없을 수 있음
    }
  };

  const handleAction = async (id: string, action: 'approve' | 'reject' | 'activate') => {
    try {
      await api.put(`/admin/basemaps/${id}/${action}`);
      setMessage(`${action} 완료`);
      loadBasemaps();
    } catch (e: any) {
      setMessage(e.message);
    }
  };

  if (loading || !user) return <div className="flex items-center justify-center h-64 text-gray-500">로딩 중...</div>;

  const statusLabel: Record<string, string> = {
    pending: '대기',
    approved: '승인됨',
    rejected: '거부됨',
    superseded: '교체됨',
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Basemap 관리</h1>

      {message && <p className="text-sm text-green-400 mb-4">{message}</p>}

      {basemaps.length === 0 ? (
        <p className="text-gray-500">등록된 basemap이 없습니다.</p>
      ) : (
        <div className="space-y-3">
          {basemaps.map(bm => (
            <div key={bm.id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <div className="flex justify-between items-center">
                <div>
                  <span className="font-medium text-sm text-gray-300">floor: </span>
                  <span className="text-gray-400 text-sm font-mono">{bm.floor_id}</span>
                  <span className="text-gray-500 ml-3">v{bm.version}</span>
                  <span className={`ml-3 text-xs px-2 py-0.5 rounded ${
                    bm.is_active ? 'bg-green-600/20 text-green-400' : 'bg-gray-700 text-gray-400'
                  }`}>
                    {bm.is_active ? '활성' : statusLabel[bm.status]}
                  </span>
                </div>
                <div className="flex gap-2">
                  {bm.status === 'pending' && (
                    <>
                      <button onClick={() => handleAction(bm.id, 'approve')} className="text-xs bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded">승인</button>
                      <button onClick={() => handleAction(bm.id, 'reject')} className="text-xs bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded">거부</button>
                    </>
                  )}
                  {bm.status === 'approved' && !bm.is_active && (
                    <button onClick={() => handleAction(bm.id, 'activate')} className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded">활성화</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
