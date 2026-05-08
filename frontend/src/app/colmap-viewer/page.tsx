'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import type { ColmapResultData, TrainingBounds } from '@/components/colmap/ColmapViewer';
import BoundsPanel from '@/components/colmap/BoundsPanel';

const ColmapViewer = dynamic(() => import('@/components/colmap/ColmapViewer'), { ssr: false });

interface ColmapResultResponse {
  upload_id: string;
  status: string;
  result_url?: string;
  error?: string;
}

function computeBounds(points: number[][]): TrainingBounds {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, y, z] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function ColmapViewerContent() {
  const searchParams = useSearchParams();
  const uploadId = searchParams.get('upload_id');

  const [apiStatus, setApiStatus] = useState<string>('idle');
  const [data, setData]           = useState<ColmapResultData | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [polling, setPolling]     = useState(false);

  const [dataBounds, setDataBounds]         = useState<TrainingBounds | null>(null);
  const [bounds, setBounds]                 = useState<TrainingBounds | null>(null);
  const [trainingLoading, setTrainingLoading] = useState(false);
  const [trainingStatus, setTrainingStatus]   = useState<'idle' | 'dispatched' | 'error'>('idle');

  const fetchResult = useCallback(async () => {
    if (!uploadId) return;
    try {
      const res = await api.get<ColmapResultResponse>(`/uploads/${uploadId}/colmap-result`);
      setApiStatus(res.status);
      if (res.status === 'completed' && res.result_url) {
        const jsonRes = await fetch(res.result_url);
        if (!jsonRes.ok) throw new Error('결과 파일 로드 실패');
        const json: ColmapResultData = await jsonRes.json();
        setData(json);
        const db = computeBounds(json.points);
        setDataBounds(db);
        setBounds(db);
        setPolling(false);
      } else if (res.status === 'failed') {
        setError(res.error ?? 'COLMAP 처리에 실패했습니다.');
        setPolling(false);
      } else {
        setPolling(true);
      }
    } catch (e: any) {
      setError(e.message || '결과 조회 실패');
      setPolling(false);
    }
  }, [uploadId]);

  useEffect(() => { fetchResult(); }, [fetchResult]);
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(fetchResult, 5000);
    return () => clearInterval(id);
  }, [polling, fetchResult]);

  const startTraining = useCallback(async () => {
    if (!uploadId || !bounds) return;
    setTrainingLoading(true);
    try {
      await api.post(`/uploads/${uploadId}/start-training`, { bounds });
      setTrainingStatus('dispatched');
    } catch (e: any) {
      setTrainingStatus('error');
      setError(e.message || '학습 시작 실패');
    } finally {
      setTrainingLoading(false);
    }
  }, [uploadId, bounds]);

  if (!uploadId) {
    return (
      <div className="flex items-center justify-center h-screen text-gray-400">
        upload_id 파라미터가 필요합니다.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800 shrink-0">
        <h1 className="text-white font-semibold text-sm">COLMAP 결과 뷰어</h1>
        <div className="flex items-center gap-3">
          {trainingStatus === 'dispatched' && (
            <span className="text-xs bg-blue-700/40 text-blue-300 px-2 py-0.5 rounded">학습 요청됨</span>
          )}
          <div className="text-xs text-gray-500">upload: {uploadId}</div>
        </div>
      </div>

      {error && <div className="px-4 py-2 bg-red-900/40 text-red-300 text-xs border-b border-red-800 shrink-0">{error}</div>}

      <div className="flex flex-1 min-h-0">
        {/* 뷰어 */}
        <div className="flex-1 relative">
          {!error && !data && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-gray-400">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <div className="text-center">
                <p className="text-sm font-medium">
                  {apiStatus === 'pending'    && 'COLMAP 대기 중...'}
                  {apiStatus === 'processing' && 'COLMAP 처리 중...'}
                  {apiStatus === 'idle'       && '결과 조회 중...'}
                </p>
                <p className="text-xs mt-1 text-gray-600">Feature extraction → Matching → Sparse reconstruction</p>
              </div>
            </div>
          )}
          {data && <ColmapViewer data={data} trainingBounds={bounds} />}
        </div>

        {/* 학습 범위 패널 (COLMAP 완료 후 표시) */}
        {data && dataBounds && bounds && (
          <BoundsPanel
            dataBounds={dataBounds}
            bounds={bounds}
            onChange={setBounds}
            onReset={() => setBounds(dataBounds)}
            onStartTraining={startTraining}
            trainingLoading={trainingLoading}
            trainingDisabled={trainingStatus === 'dispatched'}
            trainingDisabledReason={trainingStatus === 'dispatched' ? '이미 학습 요청됨' : undefined}
          />
        )}
      </div>

      {data && (
        <div className="flex items-center gap-6 px-4 py-2 bg-gray-900 border-t border-gray-800 text-xs text-gray-500 shrink-0">
          <span>포인트: <span className="text-white">{data.num_points.toLocaleString()}</span></span>
          <span>카메라: <span className="text-white">{data.num_cameras}</span></span>
        </div>
      )}
    </div>
  );
}

export default function ColmapViewerPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <ColmapViewerContent />
    </Suspense>
  );
}
