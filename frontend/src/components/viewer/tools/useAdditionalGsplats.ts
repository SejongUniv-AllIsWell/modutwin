'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SplatViewerCoreRef } from '../SplatViewerCore';

export type AdditionalGsplatSource = 'local' | 'server' | 'basemap';

export interface AdditionalGsplat {
  id: string;
  url: string;
  name: string;
  source: AdditionalGsplatSource;
  visible: boolean;
  loaded: boolean;
  error: string | null;
  /** caller-defined per-layer metadata (e.g. uploadId, MetadataResult) — preserved through detach/refresh */
  meta?: Record<string, any>;
}

export interface AddOptions {
  name?: string;
  source?: AdditionalGsplatSource;
  meta?: Record<string, any>;
  visible?: boolean;
}

export interface DetachedLayer {
  url: string;
  name: string;
  source: AdditionalGsplatSource;
  visible: boolean;
  meta?: Record<string, any>;
}

export interface AddResult {
  id: string;
  /**
   * Asset (gsplat) 가 fully loaded — entity 가 씬에 부착되고 splatColor 등 GPU 텍스처가
   * lock 가능해진 시점에 resolve. 로드 실패 시 reject. 호출자가 entity 의 colorTexture 를
   * 즉시 조작해야 할 때 사용 (폴링 대체).
   */
  ready: Promise<void>;
}

export interface AdditionalGsplatsApi {
  items: AdditionalGsplat[];
  /**
   * 새 splat group 추가. id 즉시 반환 + asset.ready 까지 awaitable Promise.
   * 기존 동기 사용처는 `.id` 만 접근하면 호환.
   */
  add: (url: string, opts?: AddOptions) => AddResult;
  remove: (id: string) => void;
  /** 추가된 gsplat의 local transform을 한 번에 갱신 (raw frame, Z180 baked-in 기준) */
  setTransform: (id: string, position: [number, number, number], quatXYZW: [number, number, number, number]) => void;
  setVisible: (id: string, visible: boolean) => void;
  getEntity: (id: string) => any | null;
  /** 부분 업데이트 (이름/visible/meta 등) */
  update: (id: string, patch: Partial<Pick<AdditionalGsplat, 'name' | 'source' | 'visible' | 'meta'>>) => void;
  /** 항목을 목록에서 제거하면서 URL 소유권을 호출자에게 이전 (blob revoke 안 함). PlayCanvas entity/asset은 제거. */
  detach: (id: string) => DetachedLayer | null;
  /**
   * 모든 entity/asset을 현재 PlayCanvas app에 다시 만든다.
   * SplatViewerCore가 reload되어 app 인스턴스가 바뀐 뒤 호출.
   * 기존 entity/asset 참조는 (이미 destroy된 app에 속해 있어) 그냥 버린다.
   */
  refreshAll: () => void;
}

/**
 * 메인 PLY 외 추가 gsplat을 N개 동적으로 띄우는 훅.
 *
 * - PLY 컨벤션상 Z축 180° 회전을 entity에 baked-in (메인과 동일)
 * - 언마운트 시 추가된 entity와 asset 모두 정리
 *
 * 향후 한 floor에 여러 모듈을 동시에 표시할 때도 그대로 재사용.
 */
export function useAdditionalGsplats(
  coreRef: React.RefObject<SplatViewerCoreRef>,
): AdditionalGsplatsApi {
  const [items, setItems] = useState<AdditionalGsplat[]>([]);
  const itemsRef = useRef<AdditionalGsplat[]>([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const entityMapRef = useRef<Map<string, any>>(new Map());
  const assetMapRef = useRef<Map<string, any>>(new Map());

  const cancelMapRef = useRef<Map<string, () => void>>(new Map());
  const urlMapRef = useRef<Map<string, string>>(new Map());
  // id → ready Promise resolver/rejector (asset.ready / asset.error 시 호출).
  const readyMapRef = useRef<Map<string, { resolve: () => void; reject: (e: Error) => void }>>(new Map());

  const revokeIfBlob = (url: string) => {
    if (url.startsWith('blob:')) {
      try { URL.revokeObjectURL(url); } catch {}
    }
  };

  /** 단일 항목을 현재 PlayCanvas app에 로드. app 준비 전이면 50ms 간격으로 재시도. */
  const loadEntity = useCallback((id: string, url: string, source: AdditionalGsplatSource, visible: boolean) => {
    let cancelled = false;
    cancelMapRef.current.set(id, () => { cancelled = true; });

    const tryLoad = () => {
      if (cancelled) return;
      const core = coreRef.current;
      const app = core?.getApp();
      const pc = core?.getPC();
      if (!app || !pc) {
        setTimeout(tryLoad, 50);
        return;
      }

      const asset = new pc.Asset(`add_splat_${id}`, 'gsplat', { url });
      app.assets.add(asset);
      assetMapRef.current.set(id, asset);

      asset.on('error', (_msg: string, err: Error) => {
        setItems(prev => prev.map(it => it.id === id ? { ...it, error: err?.message ?? '로드 실패' } : it));
        const r = readyMapRef.current.get(id);
        if (r) { r.reject(err ?? new Error('asset load error')); readyMapRef.current.delete(id); }
      });

      asset.ready(() => {
        if (cancelled) {
          const r = readyMapRef.current.get(id);
          if (r) { r.reject(new Error('cancelled')); readyMapRef.current.delete(id); }
          return;
        }
        const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
        const ent = new pc.Entity(`add_splat_${id}`);
        if (ext !== 'spz') {
          // PLY 컨벤션: Z축 180° 회전 (SuperSplat과 동일)
          ent.setLocalEulerAngles(0, 0, 180);
        }
        ent.addComponent('gsplat', { asset });
        ent.enabled = visible;
        // 정합 모드 reparent 시 module-side 와 basemap 을 구분하기 위한 태그.
        // SplatViewerCore.enterAlignmentMode 가 'basemap' 태그가 없는 추가 splat 만 alignmentGroup 으로 옮긴다.
        try { ent.tags.add(`source:${source}`); if (source === 'basemap') ent.tags.add('basemap'); } catch {}
        // 비동기 로드가 끝났을 때 이미 alignment 모드라면 곧장 alignmentGroup 의 자식으로 붙인다.
        // (그렇지 않으면 app.root 에 남아 정합 transform 을 안 받음 — module 측 도어 가우시안 race 문제 원인)
        const alignGroup = coreRef.current?.getAlignmentGroup?.();
        const parent = (alignGroup && source !== 'basemap') ? alignGroup : app.root;
        parent.addChild(ent);
        entityMapRef.current.set(id, ent);
        setItems(prev => prev.map(it => it.id === id ? { ...it, loaded: true, error: null } : it));
        const r = readyMapRef.current.get(id);
        if (r) { r.resolve(); readyMapRef.current.delete(id); }
      });

      app.assets.load(asset);
    };
    tryLoad();
  }, [coreRef]);

  const remove = useCallback((id: string) => {
    console.warn(`[DoorSplat:REMOVE] id=${id} stack:`, new Error().stack);
    const cancel = cancelMapRef.current.get(id);
    if (cancel) { cancel(); cancelMapRef.current.delete(id); }
    const ent = entityMapRef.current.get(id);
    if (ent) { try { ent.destroy(); } catch {} entityMapRef.current.delete(id); }
    const asset = assetMapRef.current.get(id);
    const app = coreRef.current?.getApp();
    if (asset && app) { try { app.assets.remove(asset); } catch {} }
    assetMapRef.current.delete(id);
    const url = urlMapRef.current.get(id);
    if (url) { revokeIfBlob(url); urlMapRef.current.delete(id); }
    // 미해결 ready Promise 가 있으면 reject (await 가 hang 되지 않도록).
    const r = readyMapRef.current.get(id);
    if (r) { r.reject(new Error('removed before ready')); readyMapRef.current.delete(id); }
    setItems(prev => prev.filter(it => it.id !== id));
  }, [coreRef]);

  const add = useCallback((url: string, opts?: AddOptions): AddResult => {
    const id = (typeof crypto !== 'undefined' && (crypto as any).randomUUID)
      ? (crypto as any).randomUUID()
      : `gsplat_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const name = opts?.name ?? (() => {
      const tail = url.split('?')[0].split('/').pop() ?? 'layer';
      return decodeURIComponent(tail);
    })();
    const source = opts?.source ?? 'local';
    const visible = opts?.visible ?? true;

    // ready Promise 등록 — asset.ready 또는 error 시 resolve/reject.
    const ready = new Promise<void>((resolve, reject) => {
      readyMapRef.current.set(id, { resolve, reject });
    });

    setItems(prev => [
      ...prev,
      { id, url, name, source, visible, loaded: false, error: null, meta: opts?.meta },
    ]);
    urlMapRef.current.set(id, url);

    loadEntity(id, url, source, visible);

    return { id, ready };
  }, [loadEntity]);

  const setVisible = useCallback((id: string, visible: boolean) => {
    const ent = entityMapRef.current.get(id);
    if (ent) ent.enabled = visible;
    setItems(prev => prev.map(it => it.id === id ? { ...it, visible } : it));
  }, []);

  const setTransform = useCallback((
    id: string,
    position: [number, number, number],
    quatXYZW: [number, number, number, number],
  ) => {
    const ent = entityMapRef.current.get(id);
    if (!ent) return;
    ent.setLocalPosition(position[0], position[1], position[2]);
    ent.setLocalRotation(quatXYZW[0], quatXYZW[1], quatXYZW[2], quatXYZW[3]);
  }, []);

  const getEntity = useCallback((id: string) => {
    return entityMapRef.current.get(id) ?? null;
  }, []);

  const update = useCallback((id: string, patch: Partial<Pick<AdditionalGsplat, 'name' | 'source' | 'visible' | 'meta'>>) => {
    if (patch.visible !== undefined) {
      const ent = entityMapRef.current.get(id);
      if (ent) ent.enabled = patch.visible;
    }
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
  }, []);

  const detach = useCallback((id: string): DetachedLayer | null => {
    const item = itemsRef.current.find(it => it.id === id);
    if (!item) return null;

    const cancel = cancelMapRef.current.get(id);
    if (cancel) { cancel(); cancelMapRef.current.delete(id); }
    const ent = entityMapRef.current.get(id);
    if (ent) { try { ent.destroy(); } catch {} entityMapRef.current.delete(id); }
    const asset = assetMapRef.current.get(id);
    const app = coreRef.current?.getApp();
    if (asset && app) { try { app.assets.remove(asset); } catch {} }
    assetMapRef.current.delete(id);
    // URL은 revoke하지 않는다 — 호출자가 이어받음
    urlMapRef.current.delete(id);

    setItems(prev => prev.filter(it => it.id !== id));

    return {
      url: item.url,
      name: item.name,
      source: item.source,
      visible: item.visible,
      meta: item.meta,
    };
  }, [coreRef]);

  const refreshAll = useCallback(() => {
    // 1) 진행 중 로드 모두 취소 (asset.ready 콜백이 새 app과 무관하게 발화하지 않도록)
    cancelMapRef.current.forEach(c => { try { c(); } catch {} });
    cancelMapRef.current.clear();
    // 2) 옛 app에 속한 entity/asset 참조는 그냥 버린다 (app.destroy가 정리함)
    entityMapRef.current.clear();
    assetMapRef.current.clear();
    // 3) 모든 항목을 unloaded로 표시 후 새 app에 재로드
    const list = itemsRef.current;
    setItems(prev => prev.map(it => ({ ...it, loaded: false, error: null })));
    list.forEach(item => loadEntity(item.id, item.url, item.source, item.visible));
  }, [loadEntity]);

  // 언마운트 시 모두 정리
  useEffect(() => {
    return () => {
      cancelMapRef.current.forEach(cancel => { try { cancel(); } catch {} });
      cancelMapRef.current.clear();
      const app = coreRef.current?.getApp();
      entityMapRef.current.forEach(ent => { try { ent.destroy(); } catch {} });
      entityMapRef.current.clear();
      if (app) {
        assetMapRef.current.forEach(asset => { try { app.assets.remove(asset); } catch {} });
      }
      assetMapRef.current.clear();
      urlMapRef.current.forEach(url => revokeIfBlob(url));
      urlMapRef.current.clear();
    };
  }, [coreRef]);

  return { items, add, remove, setTransform, setVisible, getEntity, update, detach, refreshAll };
}
