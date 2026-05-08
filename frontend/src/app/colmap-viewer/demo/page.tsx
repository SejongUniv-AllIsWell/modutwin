'use client';

import { useState, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import type { ColmapResultData, TrainingBounds } from '@/components/colmap/ColmapViewer';
import BoundsPanel from '@/components/colmap/BoundsPanel';

const ColmapViewer = dynamic(() => import('@/components/colmap/ColmapViewer'), { ssr: false });

function makeTestData(): ColmapResultData {
  const points: number[][] = [];
  for (let x = -2; x <= 2; x += 0.08)
    for (let z = -2; z <= 2; z += 0.08) {
      const n = () => (Math.random() - 0.5) * 0.04;
      points.push([x + n(), -1 + n(), z + n(), 180, 160, 140]);
    }
  for (let x = -2; x <= 2; x += 0.12)
    for (let z = -2; z <= 2; z += 0.12) {
      const n = () => (Math.random() - 0.5) * 0.04;
      points.push([x + n(), 1 + n(), z + n(), 200, 200, 210]);
    }
  for (let x = -2; x <= 2; x += 0.08)
    for (let y = -1; y <= 1; y += 0.08) {
      const n = () => (Math.random() - 0.5) * 0.03;
      points.push([x + n(), y + n(), -2 + n(), 160, 140, 120]);
    }
  for (let z = -2; z <= 2; z += 0.08)
    for (let y = -1; y <= 1; y += 0.08) {
      const n = () => (Math.random() - 0.5) * 0.03;
      points.push([2 + n(), y + n(), z + n(), 150, 130, 110]);
    }
  for (let i = 0; i < 400; i++)
    points.push([(Math.random() - 0.5) * 0.8, -1 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8,
      100 + Math.random() * 80, 70 + Math.random() * 60, 50 + Math.random() * 40]);
  const cameras: ColmapResultData['cameras'] = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    const px = Math.cos(angle) * 2.5, pz = Math.sin(angle) * 2.5, py = -0.2 + Math.random() * 0.4;
    const flen = Math.sqrt(px * px + py * py + pz * pz);
    const fnx = -px / flen, fny = -py / flen, fnz = -pz / flen;
    const rlen = Math.sqrt(fnz * fnz + fnx * fnx) || 1;
    const rnx = fnz / rlen, rnz = -fnx / rlen;
    const ux = rnz * fny, uy = -(rnx * fnz - rnz * fnx), uz = rnx * fny;
    cameras.push({ name: `frame_${String(i).padStart(3, '0')}.jpg`, position: [px, py, pz],
      R: [[rnx, 0, rnz], [-ux, -uy, -uz], [fnx, fny, fnz]], fx: 800, fy: 800, cx: 960, cy: 540, width: 1920, height: 1080 });
  }
  return { num_points: points.length, num_cameras: cameras.length, points, cameras };
}

const DUMMY_DATA = makeTestData();

function computeBounds(points: number[][]): TrainingBounds {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, y, z] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

export default function ColmapViewerDemoPage() {
  const [data, setData] = useState<ColmapResultData>(DUMMY_DATA);
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [dataBounds, setDataBounds] = useState<TrainingBounds>(() => computeBounds(DUMMY_DATA.points));
  const [bounds, setBounds] = useState<TrainingBounds>(() => computeBounds(DUMMY_DATA.points));

  useEffect(() => {
    const db = computeBounds(data.points);
    setDataBounds(db);
    setBounds(db);
  }, [data]);

  const loadFile = useCallback((file: File) => {
    if (!file.name.endsWith('.json')) { setError('.json 파일만 불러올 수 있습니다.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string) as ColmapResultData;
        if (!json.points || !json.cameras) throw new Error('points 또는 cameras 필드가 없습니다.');
        setData(json); setFilename(file.name); setError(null);
      } catch (err: any) { setError(`JSON 파싱 실패: ${err.message}`); }
    };
    reader.readAsText(file);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const file = e.dataTransfer.files?.[0]; if (file) loadFile(file);
  }, [loadFile]);

  return (
    <div className="flex flex-col h-screen bg-gray-950">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-white font-semibold text-sm">COLMAP 뷰어 — 데모</h1>
          {filename
            ? <span className="text-xs bg-emerald-700/40 text-emerald-300 px-2 py-0.5 rounded">{filename}</span>
            : <span className="text-xs bg-yellow-600/30 text-yellow-400 px-2 py-0.5 rounded">더미 데이터</span>}
        </div>
        <label
          className={`flex items-center gap-2 cursor-pointer px-3 py-1.5 rounded text-xs font-medium transition
            ${isDragging ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)} onDrop={onDrop}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          colmap_result.json 불러오기
          <input type="file" accept=".json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) loadFile(f); }} />
        </label>
      </div>

      {error && <div className="px-4 py-2 bg-red-900/40 text-red-300 text-xs border-b border-red-800 shrink-0">{error}</div>}
      {!filename && (
        <div className="px-4 py-2 bg-blue-950/40 border-b border-blue-900/50 text-xs text-blue-300 flex items-center gap-2 shrink-0">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          실제 데이터: <code className="bg-blue-900/50 px-1 rounded mx-1">python scripts/bin_to_json.py ./sparse/0/</code> 실행 후 json 불러오기
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 relative">
          <ColmapViewer data={data} trainingBounds={bounds} />
        </div>
        <BoundsPanel
          dataBounds={dataBounds}
          bounds={bounds}
          onChange={setBounds}
          onReset={() => setBounds(dataBounds)}
          onStartTraining={() => {}}
          trainingDisabled={true}
          trainingDisabledReason="실제 업로드 후 사용 가능"
        />
      </div>

      <div className="flex items-center gap-6 px-4 py-2 bg-gray-900 border-t border-gray-800 text-xs text-gray-500 shrink-0">
        <span>포인트: <span className="text-white">{data.num_points.toLocaleString()}</span></span>
        <span>카메라: <span className="text-white">{data.num_cameras}</span></span>
        {!filename && <span className="text-gray-600">시뮬레이션 데이터</span>}
      </div>
    </div>
  );
}
