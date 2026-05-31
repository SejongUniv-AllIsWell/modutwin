'use client';

import { RefObject, useEffect, useRef } from 'react';
import type { SplatViewerCoreRef } from '../SplatViewerCore';
import type { AdditionalGsplatsApi } from './useAdditionalGsplats';
import type { DoorHandle } from '@/lib/gs/doorInteraction';

/**
 * 정합/베이스 뷰어용: upload_id 의 정제 결과를 자동 로드해 door 자산과 wall mesh 를 씬에 추가한다.
 *
 * 로드 흐름:
 *  1. /refine/refined-bundle 호출 → presigned URLs 받음.
 *  2. door mesh/splat 을 먼저 시작해 정합 단계에서 대상 문이 빠르게 보이게 함.
 *  3. mesh.json fetch → 메시 메타데이터 파싱.
 *  4. 텍스처 PNG 들을 HTMLImageElement 로 로드.
 *  5. 각 surface 마다 createWallMeshFromPersisted 호출 → 엔티티 생성.
 *
 * 정제된 결과가 없거나 mesh.json 이 없으면 조용히 무시 (PLY 만 표시되는 정상 동작).
 */
export function useRefinedMeshLoader(
  coreRef: RefObject<SplatViewerCoreRef | null>,
  uploadId: string | undefined,
  enabled: boolean,
  /**
   * 옵션: 도어 splat (basemap 다중 도어용) 을 추가 splat 레이어로 등록할 때 사용할 additional API.
   * 제공되면 응답의 doors[].door_splat.url 마다 additional.add() 호출 → 도어별 가우시안 표시.
   * 없으면 도어 splat 은 무시 (mesh quad 만 로드).
   */
  additionalForDoorSplats?: AdditionalGsplatsApi,
  /**
   * 옵션: 특정 호수의 도어 (= unitName 일치) 만 로드. 정합 단계에서 다른 호수의 도어 wrapper/splat 이
   * 씬에 안 나타나도록 필터링. 미지정이면 모든 도어 로드 (전체 뷰어 기본 동작).
   */
  onlyDoorUnitName?: string | null,
  /**
   * true: 텍스처를 CPU ImageData 로 복사해 이후 alpha punch 같은 편집이 가능하게 로드.
   * false: 보기 전용 화면에서 GPU texture source 로 바로 올려 큰 메모리 복사를 피함.
   */
  mutableTextures = true,
  /**
   * mutable texture 로드 시 복원한 CPU RGBA 를 호출자 cache 에 등록한다.
   * basemap 수정 모드에서 DoorRefine alpha punch 가 서버 저장 PNG 에도 반영되도록 사용.
   */
  onWallTextureData?: (surface: {
    surfaceId: string;
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    corners: number[][];
    uvs: number[][];
    normalInward: [number, number, number];
  }) => void,
  /**
   * 옵션: 도어 wrapper 생성 시 호출 — 층 뷰어의 문 hover/열기·닫기 상호작용 등록용.
   * 힌지/normalInward 메타가 있는 도어만 핸들이 전달된다.
   */
  onDoorRegister?: (handle: DoorHandle) => void,
  /** 옵션: 도어 wrapper 정리 시 호출 — 상호작용 등록 해제용. */
  onDoorUnregister?: (wrapper: any) => void,
): void {
  const entitiesRef = useRef<any[]>([]);
  const doorWrappersRef = useRef<any[]>([]);
  const doorSplatIdsRef = useRef<string[]>([]);
  const labelOverlayRef = useRef<HTMLDivElement | null>(null);
  const labelRafRef = useRef<number>(0);
  const addDoorSplat = additionalForDoorSplats?.add;
  const removeDoorSplat = additionalForDoorSplats?.remove;
  const getDoorSplatEntity = additionalForDoorSplats?.getEntity;

  useEffect(() => {
    if (!enabled || !uploadId) return;

    let cancelled = false;
    const cleanup = () => {
      for (const w of doorWrappersRef.current) {
        try { onDoorUnregister?.(w); } catch { /* ignore */ }
      }
      doorWrappersRef.current = [];
      for (const e of entitiesRef.current) {
        try { e.destroy(); } catch { /* ignore */ }
      }
      entitiesRef.current = [];
      // 도어 splat 도 정리 (해당 시점).
      if (removeDoorSplat) {
        for (const id of doorSplatIdsRef.current) {
          try { removeDoorSplat(id); } catch {}
        }
      }
      doorSplatIdsRef.current = [];
      if (labelRafRef.current) {
        cancelAnimationFrame(labelRafRef.current);
        labelRafRef.current = 0;
      }
      if (labelOverlayRef.current) {
        try { labelOverlayRef.current.remove(); } catch {}
        labelOverlayRef.current = null;
      }
    };

    (async () => {
      try {
        const { api } = await import('@/lib/api');
        const bundle = await api.get<{
          ply_url: string;
          mesh_meta_url: string | null;
          textures: Record<string, string>;
          texture_variants?: Record<string, Record<string, string>>;
          scene_id: string;
          doors?: Array<{
            id: string;
            corners: number[][];
            unitName?: string | null;
            wallSurfaceId?: string | null;
            hingeEdge?: number | null;
            swing?: number | null;
            door_mesh?: {
              corners: number[][];
              uvs: number[][];
              normalInward: number[];
              textureUrl: string;
              textureWidth: number;
              textureHeight: number;
            } | null;
            door_splat?: { url: string } | null;
          }>;
        }>(`/refine/refined-bundle?upload_id=${uploadId}`);

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

        const doorsToLoad = (bundle.doors ?? []).filter((door) => {
          if (!onlyDoorUnitName) return true;
          return door.unitName === onlyDoorUnitName;
        });

        // 도어 자산 — 각 도어마다 BasemapDoor wrapper entity 생성 후 mesh + splat 을 자식으로 reparent.
        //   계층 구조: app.root → basemapDoor_${id} (wrapper) → { door mesh, door splat }
        //   wrapper.enabled 토글 한 번에 자식 mesh + splat 동시 hide/show.
        //   정합 시 Door (doorPivotGroup) 의 자식으로 reparent → 통합 회전.
        for (const door of doorsToLoad) {
          if (cancelled) return;
          const basemapDoorWrapper = new pc.Entity(`basemapDoor_${door.id}`);
          try { basemapDoorWrapper.tags?.add?.('basemap'); } catch {}
          app.root.addChild(basemapDoorWrapper);
          entitiesRef.current.push(basemapDoorWrapper); // cleanup 시 wrapper destroy → 자식 cascade
          doorWrappersRef.current.push(basemapDoorWrapper);

          // 층 뷰어 문 상호작용 등록 — 힌지 + normalInward 메타가 있는 도어만.
          const ni = door.door_mesh?.normalInward;
          if (
            onDoorRegister &&
            typeof door.hingeEdge === 'number' &&
            Array.isArray(door.corners) && door.corners.length === 4 &&
            Array.isArray(ni) && ni.length === 3
          ) {
            onDoorRegister({
              id: `basemap_${door.id}`,
              wrapper: basemapDoorWrapper,
              corners: door.corners.map((c) => [c[0], c[1], c[2]] as [number, number, number]),
              hingeEdge: door.hingeEdge,
              swing: typeof door.swing === 'number' ? door.swing : 1,
              normalInward: [ni[0], ni[1], ni[2]],
            });
          }

          // 1) 도어 mesh quad → wrapper 자식으로
          if (door.door_mesh) {
            try {
              const dm = door.door_mesh;
              const img = await new Promise<HTMLImageElement | null>((res) => {
                const i = new Image();
                i.crossOrigin = 'anonymous';
                i.onload = () => res(i);
                i.onerror = () => { console.warn(`[useRefinedMeshLoader] door mesh tex load failed: ${door.id}`); res(null); };
                i.src = dm.textureUrl;
              });
              if (cancelled) return;
              if (img) {
                // N벽 일반화 — door 가 어느 벽에 속하는지는 정합 시 closest-plane 으로 결정. fallback: 'w0'.
                const wallSid = door.wallSurfaceId ?? 'w0';
                const ent = createWallMeshFromPersisted(pc, app, {
                  surfaceId: `door_${door.id}_${wallSid}`,
                  corners: dm.corners,
                  uvs: dm.uvs,
                  normalInward: dm.normalInward as [number, number, number],
                  textureImage: img,
                }, { mutableTexture: mutableTextures });
                try { ent.tags?.add?.('basemap'); } catch {}
                // createWallMeshFromPersisted 가 app.root 에 add — wrapper 자식으로 reparent (둘 다 root 부모라 transform 변동 없음).
                basemapDoorWrapper.addChild(ent);
              }
            } catch (e) {
              console.warn(`[useRefinedMeshLoader] door mesh create failed for ${door.id}:`, e);
            }
          }
          // 2) 도어 splat (가우시안 입자) → wrapper 자식으로 (asset.ready 후 reparent)
          if (door.door_splat && addDoorSplat) {
            try {
              const { id, ready } = addDoorSplat(door.door_splat.url, {
                name: `도어 영역 가우시안 (${door.unitName ?? door.id})`,
                source: 'basemap',
              });
              doorSplatIdsRef.current.push(id);
              ready.then(() => {
                const ent = getDoorSplatEntity?.(id);
                if (!ent) { console.warn(`[DoorSplatLoad] entity not found for id=${id}`); return; }
                try { basemapDoorWrapper.addChild(ent); } catch (e) { console.warn(`[DoorSplatLoad] reparent failed:`, e); }
              }).catch((e: any) => {
                console.warn(`[DoorSplatLoad] ready failed door=${door.id}:`, e?.message ?? e);
              });
            } catch (e) {
              console.warn(`[useRefinedMeshLoader] door splat add failed for ${door.id}:`, e);
            }
          }
        }

        if (bundle.mesh_meta_url) {
          const metaResp = await fetch(bundle.mesh_meta_url);
          if (!metaResp.ok) throw new Error(`mesh.json fetch failed: ${metaResp.status}`);
          const meta = await metaResp.json();
          if (cancelled) return;

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
          const viewImageMatrix = await Promise.all(
            surfaces.map((surface: any) => Promise.all(
              ((surface.textureVariants ?? []) as any[]).map((variant: any) => {
                const url = bundle.texture_variants?.[surface.surfaceId]?.[variant.id];
                if (!url) return Promise.resolve(null);
                return new Promise<{ id: string; viewpoint: [number, number, number]; image: HTMLImageElement } | null>((res) => {
                  const img = new Image();
                  img.crossOrigin = 'anonymous';
                  img.onload = () => res({
                    id: String(variant.id),
                    viewpoint: variant.viewpoint as [number, number, number],
                    image: img,
                  });
                  img.onerror = () => {
                    console.warn(`[useRefinedMeshLoader] view texture load failed: ${surface.surfaceId}/${variant.id}`);
                    res(null);
                  };
                  img.src = url;
                });
              }),
            )),
          );
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
              viewTextures: viewImageMatrix[i]
                .filter(Boolean)
                .map((variant: any) => ({
                  id: variant.id,
                  viewpoint: variant.viewpoint,
                  textureImage: variant.image,
                })),
            }, {
              mutableTexture: mutableTextures,
              onTextureData: (texture) => onWallTextureData?.({
                surfaceId: surface.surfaceId,
                rgba: texture.rgba,
                width: texture.width,
                height: texture.height,
                corners: surface.corners,
                uvs: surface.uvs,
                normalInward: surface.normalInward,
              }),
            });
            // basemap 자산 — enterAlignmentMode 가 module-side 와 구분해서 reparent 안 하도록 tag.
            try { ent.tags?.add?.('basemap'); } catch {}
            entitiesRef.current.push(ent);
          }
        }
        // 도어 호수 라벨 — 말풍선 HTML overlay. 도어 corners 는 A'+Y 프레임이므로
        // Z-180 적용 후 world 좌표 = (-x, -y, z). 카메라 worldToScreen 으로 매 프레임 투영.
        // 라벨은 정합 단계에서도 다른 호수 도어를 보여주는 게 자연스러움 (디스플레이는 살아있으니).
        const labeledDoors = doorsToLoad.filter(d => d.unitName && d.corners?.length);
        if (labeledDoors.length > 0) {
          const canvas: HTMLCanvasElement | undefined = (app as any).graphicsDevice?.canvas;
          const parent = canvas?.parentElement;
          if (canvas && parent) {
            if (!parent.style.position) parent.style.position = 'relative';
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10;overflow:hidden;';
            parent.appendChild(overlay);
            labelOverlayRef.current = overlay;

            const labels: { el: HTMLDivElement; world: any }[] = [];
            for (const door of labeledDoors) {
              const cs = door.corners!;
              let cx = 0, cy = 0, cz = 0;
              for (const c of cs) { cx += c[0]; cy += c[1]; cz += c[2]; }
              cx /= cs.length; cy /= cs.length; cz /= cs.length;
              const world = new pc.Vec3(-cx, -cy, cz);

              const el = document.createElement('div');
              el.style.cssText = [
                'position:absolute',
                'transform:translate(-50%,calc(-100% - 10px))',
                'padding:4px 10px',
                'background:rgba(20,20,20,0.88)',
                'color:#fff',
                'border:1px solid rgba(250,204,21,0.85)',
                'border-radius:8px',
                'font-size:12px',
                'font-weight:600',
                'font-family:sans-serif',
                'white-space:nowrap',
                'pointer-events:none',
                'box-shadow:0 2px 6px rgba(0,0,0,0.4)',
                'display:none',
              ].join(';');
              el.textContent = door.unitName!;
              const tail = document.createElement('div');
              tail.style.cssText = [
                'position:absolute',
                'left:50%','bottom:-6px',
                'transform:translateX(-50%)',
                'width:0','height:0',
                'border-left:6px solid transparent',
                'border-right:6px solid transparent',
                'border-top:6px solid rgba(20,20,20,0.88)',
              ].join(';');
              el.appendChild(tail);
              overlay.appendChild(el);
              labels.push({ el, world });
            }

            const camera = coreRef.current?.getCamera();
            const screenVec = new pc.Vec3();
            const tick = () => {
              if (cancelled) return;
              const cam = camera?.camera;
              if (cam) {
                for (const lb of labels) {
                  cam.worldToScreen(lb.world, screenVec);
                  if (screenVec.z > 0) {
                    lb.el.style.display = '';
                    lb.el.style.left = `${screenVec.x}px`;
                    lb.el.style.top = `${screenVec.y}px`;
                  } else {
                    lb.el.style.display = 'none';
                  }
                }
              }
              labelRafRef.current = requestAnimationFrame(tick);
            };
            labelRafRef.current = requestAnimationFrame(tick);
          }
        }
      } catch (e: any) {
        // 404 는 정상 (정제된 결과 없음). 그 외 에러만 로그.
        if (!String(e?.message ?? '').includes('404')) {
          console.warn('[useRefinedMeshLoader] failed:', e);
        }
      }
    })();

    return () => { cancelled = true; cleanup(); };
  }, [
    coreRef,
    uploadId,
    enabled,
    addDoorSplat,
    removeDoorSplat,
    getDoorSplatEntity,
    onlyDoorUnitName,
    mutableTextures,
    onWallTextureData,
    onDoorRegister,
    onDoorUnregister,
  ]);
}
