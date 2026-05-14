import { useEffect, useRef, type MutableRefObject } from 'react';
import { loadRefineState, saveRefineState } from '@/lib/refine/persistence';
import type { Surface } from '../refineTypes';

type CfMode = 'none' | 'confirmed';
type WallMode = 'none' | 'confirmed';

type UseRefinePersistenceParams = {
  uploadId: string | undefined;
  undoDepth: number;
  restoringRef: MutableRefObject<boolean>;
  cfMode: CfMode;
  ceilingY: number;
  floorY: number;
  pendingRotation: { rotX: number; rotZ: number };
  wallMode: WallMode;
  wallAngle: number | null;
  wallDistances: [number, number, number, number] | null;
  selectedSurfaces: Set<Surface>;
  globalOffset: number;
  globalOffsetText: string;
  setCeilingY: (value: number) => void;
  setFloorY: (value: number) => void;
  setCfMode: (mode: CfMode) => void;
  setPendingRotation: (rotation: { rotX: number; rotZ: number }) => void;
  setWallAngle: (value: number | null) => void;
  setWallDistances: (value: [number, number, number, number] | null) => void;
  setWallMode: (mode: WallMode) => void;
  setSelectedSurfaces: (surfaces: Set<Surface>) => void;
  setGlobalOffset: (value: number) => void;
  setGlobalOffsetText: (value: string) => void;
  ceilingYRef: MutableRefObject<number>;
  floorYRef: MutableRefObject<number>;
  cfModeRef: MutableRefObject<CfMode>;
  pendingRotationRef: MutableRefObject<{ rotX: number; rotZ: number }>;
  wallAngleRef: MutableRefObject<number | null>;
  wallDistancesRef: MutableRefObject<[number, number, number, number] | null>;
  wallModeRef: MutableRefObject<WallMode>;
};

export function useRefinePersistence(params: UseRefinePersistenceParams) {
  const loadedUploadIdRef = useRef<string | null>(null);

  useEffect(() => {
    const uid = params.uploadId;
    if (!uid || loadedUploadIdRef.current === uid) return;
    const saved = loadRefineState(uid);
    if (!saved) {
      loadedUploadIdRef.current = uid;
      return;
    }

    params.restoringRef.current = true;

    if (saved.cfConfirmed) {
      params.setCeilingY(saved.ceilingY);
      params.setFloorY(saved.floorY);
      params.ceilingYRef.current = saved.ceilingY;
      params.floorYRef.current = saved.floorY;
      params.setCfMode('confirmed');
      params.cfModeRef.current = 'confirmed';
      const rot = { rotX: saved.rotX ?? 0, rotZ: saved.rotZ ?? 0 };
      params.setPendingRotation(rot);
      params.pendingRotationRef.current = rot;
    }

    if (saved.wallConfirmed && saved.wallAngle !== null && saved.wallDistances) {
      params.setWallAngle(saved.wallAngle);
      params.wallAngleRef.current = saved.wallAngle;
      params.setWallDistances(saved.wallDistances);
      params.wallDistancesRef.current = saved.wallDistances;
      params.setWallMode('confirmed');
      params.wallModeRef.current = 'confirmed';
    }

    params.setSelectedSurfaces(new Set(saved.selectedSurfaces as Surface[]));
    params.setGlobalOffset(saved.globalOffset);
    params.setGlobalOffsetText(saved.globalOffsetText);

    loadedUploadIdRef.current = uid;
    setTimeout(() => {
      params.restoringRef.current = false;
    }, 0);
  }, [
    params.uploadId,
    params.restoringRef,
    params.setCeilingY,
    params.setFloorY,
    params.setCfMode,
    params.setPendingRotation,
    params.setWallAngle,
    params.setWallDistances,
    params.setWallMode,
    params.setSelectedSurfaces,
    params.setGlobalOffset,
    params.setGlobalOffsetText,
    params.ceilingYRef,
    params.floorYRef,
    params.cfModeRef,
    params.pendingRotationRef,
    params.wallAngleRef,
    params.wallDistancesRef,
    params.wallModeRef,
  ]);

  useEffect(() => {
    if (params.restoringRef.current) return;
    const uid = params.uploadId ?? '';
    saveRefineState(uid, {
      cfConfirmed: params.cfMode === 'confirmed',
      ceilingY: params.ceilingY,
      floorY: params.floorY,
      rotX: params.pendingRotation.rotX,
      rotZ: params.pendingRotation.rotZ,
      wallConfirmed: params.wallMode === 'confirmed',
      wallAngle: params.wallAngle,
      wallDistances: params.wallDistances,
      selectedSurfaces: Array.from(params.selectedSurfaces),
      globalOffset: params.globalOffset,
      globalOffsetText: params.globalOffsetText,
    });
  }, [
    params.uploadId,
    params.undoDepth,
    params.cfMode,
    params.ceilingY,
    params.floorY,
    params.pendingRotation.rotX,
    params.pendingRotation.rotZ,
    params.wallMode,
    params.wallAngle,
    params.wallDistances,
    params.selectedSurfaces,
    params.globalOffset,
    params.globalOffsetText,
    params.restoringRef,
  ]);
}
