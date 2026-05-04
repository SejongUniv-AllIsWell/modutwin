'use client';

import { useRef, useState, useCallback, useEffect, Suspense, lazy } from 'react';
import SplatViewerCore, { SplatViewerCoreRef } from './SplatViewerCore';
import { useGaussianSelector } from './tools/useGaussianSelector';
import { useRefinedMeshLoader } from './tools/useRefinedMeshLoader';
import type { FloorplanResult } from '@/lib/gs/floorplan';

const DoorAlignModal = lazy(() => import('./tools/DoorAlignModal'));
const Minimap = lazy(() => import('./tools/Minimap'));

interface SplatViewerProps {
  sogUrl: string;
  mode: 'edit' | 'readonly';
  uploadId?: string;
  onSelectionDone?: (indices: number[]) => void;
}

export default function SplatViewer({ sogUrl, mode, uploadId, onSelectionDone }: SplatViewerProps) {
  const coreRef = useRef<SplatViewerCoreRef>(null);
  const [currentUrl, setCurrentUrl] = useState(sogUrl);
  const [reloadKey, setReloadKey] = useState(0);
  const [doorAlignOpen, setDoorAlignOpen] = useState(false);

  const reloadWithUrl = useCallback((newUrl: string) => {
    setCurrentUrl(newUrl);
    setReloadKey(k => k + 1);
  }, []);
  const selector = useGaussianSelector(coreRef, { onSelectionDone });

  // ── 평면도 (정합 단계 미니맵 테스트) ──
  const [floorplan, setFloorplan] = useState<FloorplanResult | null>(null);
  const [splatReady, setSplatReady] = useState(false);
  // 천장 컷오프 — 미니맵 슬라이더로 실시간 조정. 변경 시 디바운스 후 재베이크.
  const [floorplanCutoff, setFloorplanCutoff] = useState(0.05);
  // selector 객체는 매 렌더 새로 생성되므로 ref 로 잡아 콜백 stable 유지.
  // (onSplatLoaded prop 이 매 렌더 변경되면 SplatViewerCore 가 splat 재로드 → 카메라 리셋 루프.)
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // SplatViewerCore 가 reloadKey 변경으로 unmount/remount 되면 floorplan 도 리셋
  useEffect(() => { setFloorplan(null); setSplatReady(false); }, [reloadKey]);

  const onSplatLoadedCombined = useCallback((data: any) => {
    selectorRef.current.onSplatLoaded(data);
    setSplatReady(true);
  }, []);

  // alignment(=edit) 모드 + uploadId 있을 때만 평면도 베이크. cutoff 변경 시 자동 재베이크.
  // 첫 베이크 500ms 디바운스, 이후 슬라이더 조작 시 300ms 디바운스.
  const firstBakeRef = useRef(true);
  useEffect(() => {
    if (!splatReady || mode !== 'edit' || !uploadId) return;
    let cancelled = false;
    const delay = firstBakeRef.current ? 500 : 300;
    const t = setTimeout(async () => {
      if (cancelled) return;
      const core = coreRef.current; if (!core) return;
      const sd = core.getSplatData(); if (!sd) return;
      const pc = core.getPC(); const app = core.getApp();
      if (!pc || !app) return;
      const { bakeFloorplan } = await import('@/lib/gs/floorplan');
      if (cancelled) return;
      // 평면도 베이크 동안 모든 wallMesh_* 엔티티 비활성화 — top-down 뷰가 메시 텍스처 (직전 세션의
      // 베이크 결과) 대신 가우시안 자체만 캡처하도록. 베이크 끝나면 원상복구.
      const collectWallMeshes = (root: any, results: any[] = []): any[] => {
        if (!root) return results;
        if (root.name?.startsWith('wallMesh_')) results.push(root);
        for (const c of root.children || []) collectWallMeshes(c, results);
        return results;
      };
      const wallEnts = collectWallMeshes(app.root);
      const prevEnabled = wallEnts.map(e => e.enabled);
      for (const e of wallEnts) e.enabled = false;

      let fp;
      try {
        fp = await bakeFloorplan(
          pc,
          app,
          {
            posX: sd.posX, posY: sd.posY, posZ: sd.posZ,
            numSplats: sd.numSplats,
            origColorData: sd.origColorData ?? null,
            splatEntity: sd.splatEntity,
          },
          core.half2Float,
          { cutoffOffsetMeters: floorplanCutoff },
        );
      } finally {
        for (let i = 0; i < wallEnts.length; i++) wallEnts[i].enabled = prevEnabled[i];
      }
      if (cancelled) return;
      if (fp) {
        setFloorplan(fp);
        firstBakeRef.current = false;
        console.log(`[SplatViewer] floorplan baked (cutoff=${(floorplanCutoff*100).toFixed(0)}cm): ${fp.width}×${fp.height} @ ${fp.ppm.toFixed(1)} px/m`);
      } else {
        console.warn('[SplatViewer] floorplan bake returned null');
      }
    }, delay);
    return () => { cancelled = true; clearTimeout(t); };
  }, [splatReady, mode, uploadId, floorplanCutoff]);
  // 정제된 wall mesh + 텍스처 자동 로드. uploadId 있으면 모든 모드 (align/readonly) 에서.
  // RefineViewer 는 SplatViewerCore 직접 쓰니 여기 안 영향.
  useRefinedMeshLoader(coreRef, uploadId, Boolean(uploadId));

  return (
    <SplatViewerCore key={reloadKey} ref={coreRef} sogUrl={currentUrl} onSplatLoaded={onSplatLoadedCombined}>
      {mode === 'edit' && (
        <>
          {selector.overlay}
          <div className="absolute top-3 left-16 z-40">
            {selector.panel}
          </div>
        </>
      )}
      {mode === 'edit' && uploadId && (
        <button
          onClick={() => setDoorAlignOpen(v => !v)}
          className={`absolute top-3 left-3 z-40 px-3 py-1.5 rounded cursor-pointer text-xs font-bold ${
            doorAlignOpen ? 'bg-yellow-500 text-black' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
          }`}
        >
          {doorAlignOpen ? '문 설정 닫기' : '문 설정'}
        </button>
      )}
      {doorAlignOpen && uploadId && (
        <Suspense fallback={null}>
          <DoorAlignModal
            coreRef={coreRef}
            uploadId={uploadId}
            currentUrl={currentUrl}
            onDone={(u) => { setDoorAlignOpen(false); reloadWithUrl(u); }}
            onClose={() => setDoorAlignOpen(false)}
          />
        </Suspense>
      )}
      {floorplan && (
        <Suspense fallback={null}>
          <Minimap
            floorplan={floorplan}
            cameraGetter={() => coreRef.current?.getCamera() ?? null}
            cutoff={floorplanCutoff}
            onCutoffChange={setFloorplanCutoff}
          />
        </Suspense>
      )}
    </SplatViewerCore>
  );
}
