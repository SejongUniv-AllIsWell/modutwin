'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Basemap {
  id: string;
  floor_id: string;
  version: number;
  status: string;
  is_active: boolean;
  created_at: string;
}

interface BasemapCandidate {
  upload_id: string;
  original_filename: string;
  file_size: number;
  uploaded_at: string;
  uploaded_by_name: string;
  module_id: string;
  module_name: string;
  floor_id: string;
  floor_number: number;
  building_id: string;
  building_name: string;
  already_registered: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '대기',
  approved: '승인됨',
  rejected: '거부됨',
  superseded: '교체됨',
};

function formatFloor(n: number): string {
  return n < 0 ? `B${-n}` : `${n}층`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function BasemapManager() {
  const [basemaps, setBasemaps] = useState<Basemap[]>([]);
  const [candidates, setCandidates] = useState<BasemapCandidate[]>([]);
  const [registering, setRegistering] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    try {
      const [bms, cands] = await Promise.all([
        api.get<Basemap[]>('/admin/basemaps'),
        api.get<BasemapCandidate[]>('/admin/basemaps/candidates'),
      ]);
      setBasemaps(bms);
      setCandidates(cands);
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

  const handleRegister = async (uploadId: string) => {
    setRegistering(uploadId);
    try {
      await api.post('/admin/basemaps/register', { upload_id: uploadId });
      showMessage('basemap으로 등록되었습니다. 승인 후 활성화하세요.', 'ok');
      loadAll();
    } catch (e: any) {
      showMessage(e.message || '등록 실패', 'err');
    } finally {
      setRegistering(null);
    }
  };

  // 기존 등록된 basemap의 floor 라벨용 — 후보 목록의 floor 정보를 활용
  const floorLabel = (floorId: string): string => {
    const c = candidates.find(x => x.floor_id === floorId);
    if (!c) return floorId.slice(0, 8);
    return `${c.building_name} / ${formatFloor(c.floor_number)}`;
  };

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold mb-4">Basemap 관리</h2>

      {message && (
        <p className={`text-sm mb-4 ${message.kind === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
          {message.text}
        </p>
      )}

      {/* 후보 — 업로드된 PLY 파일들 */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">
          업로드된 PLY 파일 ({candidates.length})
        </h3>
        {candidates.length === 0 ? (
          <p className="text-gray-500 text-sm">업로드된 PLY 파일이 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {candidates.map(c => (
              <div key={c.upload_id} className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <div className="flex justify-between items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-200 font-medium truncate">{c.original_filename}</div>
                    <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-1">
                      <span>{c.building_name} / {formatFloor(c.floor_number)} / {c.module_name}</span>
                      <span>{formatBytes(c.file_size)}</span>
                      <span>{c.uploaded_by_name}</span>
                      <span>{new Date(c.uploaded_at).toLocaleString('ko-KR')}</span>
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    {c.already_registered ? (
                      <span className="text-xs bg-gray-800 text-gray-400 px-2 py-1 rounded">등록됨</span>
                    ) : (
                      <button
                        onClick={() => handleRegister(c.upload_id)}
                        disabled={registering === c.upload_id}
                        className="text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white px-3 py-1 rounded"
                      >
                        {registering === c.upload_id ? '등록 중...' : 'basemap으로 등록'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 등록된 basemap 목록 */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">
          등록된 Basemap ({basemaps.length})
        </h3>
        {basemaps.length === 0 ? (
          <p className="text-gray-500 text-sm">등록된 basemap이 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {basemaps.map(bm => (
              <div key={bm.id} className="bg-gray-950 border border-gray-800 rounded-lg p-3 flex justify-between items-center">
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-gray-300">{floorLabel(bm.floor_id)}</span>
                  <span className="text-gray-500">v{bm.version}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    bm.is_active ? 'bg-green-600/20 text-green-400' : 'bg-gray-800 text-gray-400'
                  }`}>
                    {bm.is_active ? '활성' : STATUS_LABEL[bm.status] ?? bm.status}
                  </span>
                </div>
                <div className="flex gap-2 items-center">
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
