'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SplatViewerCoreRef } from '../SplatViewerCore';

export interface AdditionalGsplat {
  id: string;
  url: string;
  loaded: boolean;
  error: string | null;
}

export interface AdditionalGsplatsApi {
  items: AdditionalGsplat[];
  /** PlayCanvas 준비 완료 전이면 빈 문자열 반환. 성공 시 새 id 반환 */
  add: (url: string) => string;
  remove: (id: string) => void;
  /** 추가된 gsplat의 local transform을 한 번에 갱신 (raw frame, Z180 baked-in 기준) */
  setTransform: (id: string, position: [number, number, number], quatXYZW: [number, number, number, number]) => void;
  getEntity: (id: string) => any | null;
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
  const entityMapRef = useRef<Map<string, any>>(new Map());
  const assetMapRef = useRef<Map<string, any>>(new Map());

  const remove = useCallback((id: string) => {
    const ent = entityMapRef.current.get(id);
    if (ent) { try { ent.destroy(); } catch {} entityMapRef.current.delete(id); }
    const asset = assetMapRef.current.get(id);
    const app = coreRef.current?.getApp();
    if (asset && app) { try { app.assets.remove(asset); } catch {} }
    assetMapRef.current.delete(id);
    setItems(prev => prev.filter(it => it.id !== id));
  }, [coreRef]);

  const add = useCallback((url: string): string => {
    const core = coreRef.current;
    const app = core?.getApp();
    const pc = core?.getPC();
    if (!app || !pc) {
      console.warn('[useAdditionalGsplats] core not ready');
      return '';
    }
    const id = (typeof crypto !== 'undefined' && (crypto as any).randomUUID)
      ? (crypto as any).randomUUID()
      : `gsplat_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    setItems(prev => [...prev, { id, url, loaded: false, error: null }]);

    const asset = new pc.Asset(`add_splat_${id}`, 'gsplat', { url });
    app.assets.add(asset);
    assetMapRef.current.set(id, asset);

    asset.on('error', (_msg: string, err: Error) => {
      setItems(prev => prev.map(it => it.id === id ? { ...it, error: err?.message ?? '로드 실패' } : it));
    });

    asset.ready(() => {
      const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
      const ent = new pc.Entity(`add_splat_${id}`);
      if (ext !== 'spz') {
        // PLY 컨벤션: Z축 180° 회전 (SuperSplat과 동일)
        ent.setLocalEulerAngles(0, 0, 180);
      }
      ent.addComponent('gsplat', { asset });
      app.root.addChild(ent);
      entityMapRef.current.set(id, ent);
      setItems(prev => prev.map(it => it.id === id ? { ...it, loaded: true } : it));
    });

    app.assets.load(asset);
    return id;
  }, [coreRef]);

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

  // 언마운트 시 모두 정리
  useEffect(() => {
    return () => {
      const app = coreRef.current?.getApp();
      entityMapRef.current.forEach(ent => { try { ent.destroy(); } catch {} });
      entityMapRef.current.clear();
      if (app) {
        assetMapRef.current.forEach(asset => { try { app.assets.remove(asset); } catch {} });
      }
      assetMapRef.current.clear();
    };
  }, [coreRef]);

  return { items, add, remove, setTransform, getEntity };
}
