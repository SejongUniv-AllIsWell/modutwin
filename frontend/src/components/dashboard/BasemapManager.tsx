'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Basemap {
  id: string;
  floor_id: string;
  floor_number: number;
  building_id: string;
  building_name: string;
  version: number;
  status: string;
  is_active: boolean;
  created_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '대기',
  approved: '승인됨',
  rejected: '거부됨',
  superseded: '교체됨',
};

function formatFloor(n: number): string {
  return n < 0 ? `B${Math.abs(n)}` : `${n}층`;
}

export default function BasemapManager() {
  const [basemaps, setBasemaps] = useState<Basemap[]>([]);
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    try {
      const bms = await api.get<Basemap[]>('/admin/basemaps');
      setBasemaps(bms);
    } catch (e: any) {
      showMessage(e.message || '로딩 실패', 'err');
    }
  };

  const showMessage = (text: string, kind: 'ok' | 'err') => {
    setMessage({ text, kind });
    setTimeout(() => setMessage(null), 4000);
  };

  const handleAction = async (id: string, action: 'approve' | 'reject' | 'activate') => {
    try {
      await api.put(`/admin/basemaps/${id}/${action}`);
      showMessage(`${action} 완료`, 'ok');
      loadAll();
    } catch (e: any) {
      showMessage(e.message || `${action} 실패`, 'err');
    }
  };

  const handleUnregister = async (id: string) => {
    if (!confirm('이 basemap 등록을 취소합니다. 원본 PLY는 다시 등록 가능 상태로 돌아갑니다.')) return;
    try {
      await api.delete(`/admin/basemaps/${id}`);
      showMessage('등록이 취소되었습니다.', 'ok');
      loadAll();
    } catch (e: any) {
      showMessage(e.message || '취소 실패', 'err');
    }
  };

  const floorLabel = (bm: Basemap): string => {
    return `${bm.building_name} / ${formatFloor(bm.floor_number)}`;
  };

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-4">Basemap 관리</h2>

      {message && (
        <p className={`text-sm mb-4 ${message.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
          {message.text}
        </p>
      )}

      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">
          Basemap 신청/등록 목록 ({basemaps.length})
        </h3>
        {basemaps.length === 0 ? (
          <p className="text-gray-500 text-sm">등록된 basemap이 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {basemaps.map(bm => (
              <div
                key={bm.id}
                className="bg-gray-950 border border-gray-800 rounded-lg p-3 flex justify-between items-center gap-3"
              >
                <div className="flex-1 flex items-center gap-3 text-sm min-w-0">
                  <span className="text-gray-300 truncate">{floorLabel(bm)}</span>
                  <span className="text-gray-500 shrink-0">v{bm.version}</span>
                  <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                    bm.is_active ? 'bg-green-600/20 text-green-400' : 'bg-gray-800 text-gray-400'
                  }`}>
                    {bm.is_active ? '활성' : STATUS_LABEL[bm.status] ?? bm.status}
                  </span>
                </div>
                <div className="flex gap-2 items-center shrink-0">
                  {bm.status === 'pending' && (
                    <>
                      <button onClick={() => handleAction(bm.id, 'approve')} className="text-xs bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded">승인</button>
                      <button onClick={() => handleAction(bm.id, 'reject')} className="text-xs bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded">거부</button>
                    </>
                  )}
                  {bm.status === 'approved' && !bm.is_active && (
                    <button onClick={() => handleAction(bm.id, 'activate')} className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded">활성화</button>
                  )}
                  <button
                    onClick={() => handleUnregister(bm.id)}
                    title="등록 취소"
                    aria-label="등록 취소"
                    className="ml-1 w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white hover:bg-red-600 rounded"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
