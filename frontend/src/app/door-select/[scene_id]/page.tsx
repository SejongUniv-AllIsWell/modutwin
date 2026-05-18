'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import { ActiveBasemapResponse, DoorPosition, Module, Scene } from '@/types';
import dynamic from 'next/dynamic';

const SplatViewer = dynamic(() => import('@/components/viewer/SplatViewer'), { ssr: false });

export default function DoorSelectPage() {
  const params = useParams();
  const router = useRouter();
  const sceneId = params.scene_id as string;
  const { user, loading } = useAuth();
  const [sogUrl, setSogUrl] = useState<string | null>(null);
  const [doorPosition, setDoorPosition] = useState<DoorPosition | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!loading && !user) {
      window.location.href = '/';
      return;
    }
    if (sceneId) {
      api.get<{ url: string }>(`/scenes/${sceneId}/download`)
        .then(data => setSogUrl(data.url))
        .catch(() => setMessage('씬 파일을 불러올 수 없습니다.'));
    }
  }, [user, loading, sceneId]);

  const handleSelectionDone = useCallback((indices: number[]) => {
    setDoorPosition({ module_door_indices: indices });
    setMessage(`문 가우시안 ${indices.length}개 선택됨`);
  }, []);

  const handleSave = async () => {
    if (!doorPosition || doorPosition.module_door_indices.length === 0) {
      setMessage('브러쉬/박스로 문 영역의 가우시안을 선택한 뒤 "완료"를 눌러주세요.');
      return;
    }
    setSaving(true);
    try {
      // 정합 사전 검증 — 활성 basemap 존재 + basemap 의 모듈 문 등록 여부
      const scene = await api.get<Scene>(`/scenes/${sceneId}`);
      const moduleInfo = await api.get<Module>(`/modules/${scene.module_id}`);

      let basemap: ActiveBasemapResponse;
      try {
        basemap = await api.get<ActiveBasemapResponse>(
          `/basemaps/active?module_id=${scene.module_id}`,
        );
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          alert('basemap이 없습니다.');
          router.push('/dashboard');
          return;
        }
        throw e;
      }

      const doorsRes = await api.get<{ doors: Array<{ unitName?: string | null }> }>(
        `/basemaps/${basemap.basemap_id}/doors`,
      );
      const hasModuleDoor = doorsRes.doors.some(d => d.unitName === moduleInfo.name);
      if (!hasModuleDoor) {
        alert('basemap에 해당하는 모듈의 문이 설정되지 않았습니다. 관리자에게 문의하세요');
        router.push('/dashboard');
        return;
      }

      await api.post(`/scenes/${sceneId}/door-position`, doorPosition);
      setMessage('문 위치가 저장되었습니다. 정합 작업이 시작됩니다.');
    } catch (e: any) {
      setMessage(e.message || '저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !user) return <div className="flex items-center justify-center h-64 text-gray-500">로딩 중...</div>;

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <div className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800">
        <h1 className="text-lg font-bold">문 위치 지정</h1>
        <div className="flex items-center gap-3">
          {doorPosition && (
            <span className="text-sm text-gray-400">
              {doorPosition.module_door_indices.length}개 선택됨
            </span>
          )}
          {message && <span className="text-sm text-gray-400">{message}</span>}
          <button
            onClick={handleSave}
            disabled={!doorPosition || saving}
            className="bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm px-4 py-1.5 rounded transition"
          >
            {saving ? '저장 중...' : '정합 시작'}
          </button>
        </div>
      </div>

      <div className="flex-1">
        {sogUrl ? (
          <SplatViewer
            sogUrl={sogUrl}
            mode="edit"
            onSelectionDone={handleSelectionDone}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-600">
            SOG 파일 로딩 중...
          </div>
        )}
      </div>
    </div>
  );
}
