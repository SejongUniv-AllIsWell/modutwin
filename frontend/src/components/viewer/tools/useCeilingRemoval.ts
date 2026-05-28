'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { SplatViewerCoreRef } from '../SplatViewerCore';

export type CeilingMaskRecord = {
  mainSplatLayerId: string | null;
  visualCeilingEntity: any | null;
  visualCeilingY: number | null;
};

export type CeilingSurfaceInfo = {
  surfaceId: string;
  entity: any;
  corners: number[][];
};

type CeilingScope<T extends CeilingMaskRecord> =
  | { kind: 'all' }
  | { kind: 'primary' }
  | { kind: 'module'; record: T };

type UseCeilingRemovalOptions<T extends CeilingMaskRecord> = {
  coreRef: RefObject<SplatViewerCoreRef | null>;
  ceilingRemoved: boolean;
  overlayRecordsRef: RefObject<Map<string, T>>;
  applyAdditionalCeilingMask: (
    id: string,
    visualCeilingY: number,
    cutoff: number,
    mode: 'remove' | 'restore',
  ) => void;
  cutoff?: number;
};

const DEFAULT_CEILING_CUTOFF = 0.05;

/**
 * 층 상세 뷰어의 천장 제거 상태를 primary splat + overlay module 자산 전체에 일관되게 적용한다.
 * 비동기 자산 로드 이후에도 same-source-of-truth 로 재적용할 수 있도록 imperative API 를 제공한다.
 */
export function useCeilingRemoval<T extends CeilingMaskRecord>({
  coreRef,
  ceilingRemoved,
  overlayRecordsRef,
  applyAdditionalCeilingMask,
  cutoff = DEFAULT_CEILING_CUTOFF,
}: UseCeilingRemovalOptions<T>) {
  const primaryCeilingRef = useRef<{ entity: any | null; visualCeilingY: number | null }>({
    entity: null,
    visualCeilingY: null,
  });
  const ceilingRemovedRef = useRef(ceilingRemoved);

  useEffect(() => {
    ceilingRemovedRef.current = ceilingRemoved;
  }, [ceilingRemoved]);

  const applyPrimarySplatMask = useCallback((visualCeilingY: number, hide: boolean) => {
    const core = coreRef.current;
    if (!core) return;
    const sd = core.getSplatData();
    if (!sd?.colorTexture || !sd?.origColorData || !sd?.posY) return;
    const data = sd.colorTexture.lock();
    if (!data) return;

    const threshold = visualCeilingY + cutoff;
    const zeroH = core.float2Half(0);
    const orig = sd.origColorData;
    const posY = sd.posY;
    const count = sd.numSplats;

    if (hide) {
      for (let i = 0; i < count; i++) {
        data[i * 4 + 3] = posY[i] < threshold ? zeroH : orig[i * 4 + 3];
      }
    } else {
      for (let i = 0; i < count; i++) data[i * 4 + 3] = orig[i * 4 + 3];
    }

    sd.colorTexture.unlock();
  }, [coreRef, cutoff]);

  const applyCeilingState = useCallback((scope: CeilingScope<T>) => {
    const removed = ceilingRemovedRef.current;

    if (scope.kind === 'all' || scope.kind === 'primary') {
      const entity = primaryCeilingRef.current.entity;
      if (entity) entity.enabled = !removed;
    }

    if (scope.kind === 'all' || scope.kind === 'primary') {
      const visualCeilingY = primaryCeilingRef.current.visualCeilingY;
      if (visualCeilingY != null) applyPrimarySplatMask(visualCeilingY, removed);
    }

    const records =
      scope.kind === 'all'
        ? Array.from(overlayRecordsRef.current?.values() ?? [])
        : scope.kind === 'module'
          ? [scope.record]
          : [];

    for (const record of records) {
      if (record.visualCeilingEntity) record.visualCeilingEntity.enabled = !removed;
      if (record.mainSplatLayerId && record.visualCeilingY != null) {
        applyAdditionalCeilingMask(
          record.mainSplatLayerId,
          record.visualCeilingY,
          cutoff,
          removed ? 'remove' : 'restore',
        );
      }
    }
  }, [applyAdditionalCeilingMask, applyPrimarySplatMask, cutoff, overlayRecordsRef]);

  useEffect(() => {
    applyCeilingState({ kind: 'all' });
  }, [ceilingRemoved, applyCeilingState]);

  const clearPrimaryCeiling = useCallback(() => {
    primaryCeilingRef.current = { entity: null, visualCeilingY: null };
  }, []);

  const registerPrimaryCeiling = useCallback((entity: any | null, visualCeilingY: number | null) => {
    primaryCeilingRef.current = { entity, visualCeilingY };
    applyCeilingState({ kind: 'primary' });
  }, [applyCeilingState]);

  const registerPrimaryFromSurfaces = useCallback((surfaces: CeilingSurfaceInfo[]) => {
    const visualCeiling = surfaces.find((surface) => surface.surfaceId === 'floor');
    if (!visualCeiling) return;
    registerPrimaryCeiling(visualCeiling.entity, visualCeiling.corners[0]?.[1] ?? null);
  }, [registerPrimaryCeiling]);

  const applyModuleCeilingState = useCallback((record: T) => {
    applyCeilingState({ kind: 'module', record });
  }, [applyCeilingState]);

  const handlePrimarySplatLoaded = useCallback(() => {
    applyCeilingState({ kind: 'primary' });
  }, [applyCeilingState]);

  return {
    clearPrimaryCeiling,
    registerPrimaryFromSurfaces,
    applyModuleCeilingState,
    handlePrimarySplatLoaded,
  };
}
