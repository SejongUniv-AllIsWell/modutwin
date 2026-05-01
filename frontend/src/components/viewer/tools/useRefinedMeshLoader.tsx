'use client';

import { RefObject, useEffect, useRef } from 'react';
import type { SplatViewerCoreRef } from '../SplatViewerCore';

/**
 * 정합/베이스 뷰어용: upload_id 의 정제 결과 (mesh.json + 텍스처 PNGs) 를 자동 로드해
 * wall mesh 엔티티를 씬에 추가한다.
 *
 * 로드 흐름:
 *  1. /refine/refined-bundle 호출 → presigned URLs 받음.
 *  2. mesh.json fetch → 메시 메타데이터 파싱.
 *  3. 텍스처 PNG 들을 HTMLImageElement 로 로드.
 *  4. 각 surface 마다 createWallMeshFromPersisted 호출 → 엔티티 생성.
 *
 * 정제된 결과가 없거나 mesh.json 이 없으면 조용히 무시 (PLY 만 표시되는 정상 동작).
 */
export function useRefinedMeshLoader(
  coreRef: RefObject<SplatViewerCoreRef | null>,
  uploadId: string | undefined,
  enabled: boolean,
): void {
  const entitiesRef = useRef<any[]>([]);

  useEffect(() => {
    if (!enabled || !uploadId) return;

    let cancelled = false;
    const cleanup = () => {
      for (const e of entitiesRef.current) {
        try { e.destroy(); } catch { /* ignore */ }
      }
      entitiesRef.current = [];
    };

    (async () => {
      try {
        const { api } = await import('@/lib/api');
        const bundle = await api.get<{
          ply_url: string;
          mesh_meta_url: string | null;
          textures: Record<string, string>;
          scene_id: string;
        }>(`/refine/refined-bundle?upload_id=${uploadId}`);

        if (cancelled) return;
        if (!bundle.mesh_meta_url) {
          console.log('[useRefinedMeshLoader] no mesh sidecar — skipping mesh load');
          return;
        }

        const metaResp = await fetch(bundle.mesh_meta_url);
        if (!metaResp.ok) throw new Error(`mesh.json fetch failed: ${metaResp.status}`);
        const meta = await metaResp.json();
        if (cancelled) return;

        // splatLoaded 까지 대기 — coreRef 의 PC/app 사용해야 하므로 splatEntity 가 살아있을 때 처리.
        let attempts = 0;
        while (!coreRef.current?.getApp() && attempts < 50) {
          if (cancelled) return;
          await new Promise(r => setTimeout(r, 100));
          attempts++;
        }
        if (cancelled) return;
        const pc = coreRef.current?.getPC();
        const app = coreRef.current?.getApp();
        if (!pc || !app) {
          console.warn('[useRefinedMeshLoader] PC/app not available, skipping');
          return;
        }

        const { createWallMeshFromPersisted } = await import('@/lib/gs/wallMesh');

        // 텍스처 PNG 로드 (병렬)
        const surfaces = meta.surfaces ?? [];
        const imgPromises = surfaces.map((surface: any) => {
          const surfaceId = surface.surfaceId;
          const url = bundle.textures[surfaceId];
          if (!url) return Promise.resolve(null);
          return new Promise<HTMLImageElement | null>((res) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => res(img);
            img.onerror = () => { console.warn(`[useRefinedMeshLoader] image load failed: ${surfaceId}`); res(null); };
            img.src = url;
          });
        });
        const images = await Promise.all(imgPromises);
        if (cancelled) return;

        for (let i = 0; i < surfaces.length; i++) {
          const surface = surfaces[i];
          const img = images[i];
          if (!img) continue;
          const ent = createWallMeshFromPersisted(pc, app, {
            surfaceId: surface.surfaceId,
            corners: surface.corners,
            uvs: surface.uvs,
            normalInward: surface.normalInward,
            textureImage: img,
          });
          entitiesRef.current.push(ent);
        }
        console.log(`[useRefinedMeshLoader] loaded ${entitiesRef.current.length} wall mesh entities`);
      } catch (e: any) {
        // 404 는 정상 (정제된 결과 없음). 그 외 에러만 로그.
        if (!String(e?.message ?? '').includes('404')) {
          console.warn('[useRefinedMeshLoader] failed:', e);
        }
      }
    })();

    return () => { cancelled = true; cleanup(); };
  }, [coreRef, uploadId, enabled]);
}
