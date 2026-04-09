'use client';

import { useRef, useCallback } from 'react';
import { SplatViewerCoreRef } from '../SplatViewerCore';
import { RefObject } from 'react';
import { axisAngleToQuat, quatMul, quatNormalize, rotatePoint, Axis } from './quatUtils';
import { syncGPU, snapshotSplatData } from './gpuSync';

interface DoorAnimationOptions {
  pivotAxis?: Axis;
  angleDeg?: number;
  durationSec?: number;
  pivot?: [number, number, number];
  onComplete?: () => void;
}

type DoorState = 'closed' | 'opening' | 'open' | 'closing';

interface DoorContext {
  indices: number[];
  pivotAxis: Axis;
  targetAngle: number;
  duration: number;
  pivot: [number, number, number];
  origPositions: Float32Array;
  origQuaternions: Float32Array;
  state: DoorState;
  elapsed: number;
  unsubscribe: () => void;
  onComplete?: () => void;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 위치 + 쿼터니언 회전 적용 + GPU 동기화 */
function applyRotation(
  ctx: DoorContext,
  splatData: any,
  angle: number,
  float2HalfFn: (v: number) => number,
) {
  const [rw, rx, ry, rz] = axisAngleToQuat(ctx.pivotAxis, angle);

  const gsplatData = splatData.gsplatData;
  const rot0 = gsplatData?.getProp('rot_0');
  const rot1 = gsplatData?.getProp('rot_1');
  const rot2 = gsplatData?.getProp('rot_2');
  const rot3 = gsplatData?.getProp('rot_3');

  for (let i = 0; i < ctx.indices.length; i++) {
    const idx = ctx.indices[i];

    // 위치 회전
    const [nx, ny, nz] = rotatePoint(
      ctx.origPositions[i * 3 + 0],
      ctx.origPositions[i * 3 + 1],
      ctx.origPositions[i * 3 + 2],
      ctx.pivot, ctx.pivotAxis, angle,
    );
    splatData.posX[idx] = nx;
    splatData.posY[idx] = ny;
    splatData.posZ[idx] = nz;

    // 쿼터니언 회전
    const ow = ctx.origQuaternions[i * 4 + 0];
    const ox = ctx.origQuaternions[i * 4 + 1];
    const oy = ctx.origQuaternions[i * 4 + 2];
    const oz = ctx.origQuaternions[i * 4 + 3];

    let [nw, nqx, nqy, nqz] = quatMul(rw, rx, ry, rz, ow, ox, oy, oz);
    [nw, nqx, nqy, nqz] = quatNormalize(nw, nqx, nqy, nqz);
    if (nw < 0) { nw = -nw; nqx = -nqx; nqy = -nqy; nqz = -nqz; }

    if (rot0) rot0[idx] = nw;
    if (rot1) rot1[idx] = nqx;
    if (rot2) rot2[idx] = nqy;
    if (rot3) rot3[idx] = nqz;
  }

  syncGPU(ctx.indices, splatData, float2HalfFn);
}

export function useDoorAnimation(
  coreRef: RefObject<SplatViewerCoreRef | null>,
) {
  const doorRef = useRef<DoorContext | null>(null);

  const openDoor = useCallback((
    indices: number[],
    options: DoorAnimationOptions = {},
  ) => {
    const core = coreRef.current;
    const splatData = core?.getSplatData();
    if (!core || !splatData || indices.length === 0) return;

    const prev = doorRef.current;
    if (prev && (prev.state === 'open' || prev.state === 'opening')) return;
    if (prev?.state === 'closing') prev.unsubscribe();

    const pivotAxis = options.pivotAxis ?? 'y';
    const targetAngle = (options.angleDeg ?? 90) * (Math.PI / 180);
    const duration = options.durationSec ?? 1.0;

    let origPositions: Float32Array;
    let origQuaternions: Float32Array;
    let pivot: [number, number, number];
    let startT: number;

    if (prev?.state === 'closing') {
      origPositions = prev.origPositions;
      origQuaternions = prev.origQuaternions;
      pivot = prev.pivot;
      startT = 1 - Math.min(prev.elapsed / prev.duration, 1);
    } else {
      const snap = snapshotSplatData(splatData, indices);
      origPositions = snap.positions;
      origQuaternions = snap.quaternions;

      pivot = options.pivot ?? (() => {
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < indices.length; i++) {
          cx += origPositions[i * 3]; cy += origPositions[i * 3 + 1]; cz += origPositions[i * 3 + 2];
        }
        const n = indices.length;
        return [cx / n, cy / n, cz / n] as [number, number, number];
      })();
      startT = 0;
    }

    const ctx: DoorContext = {
      indices, pivotAxis, targetAngle, duration, pivot,
      origPositions, origQuaternions,
      state: 'opening', elapsed: startT * duration,
      unsubscribe: () => {}, onComplete: options.onComplete,
    };

    const f2h = core.float2Half;
    const unsub = core.onUpdate((dt: number) => {
      ctx.elapsed += dt;
      const t = Math.min(ctx.elapsed / ctx.duration, 1);
      applyRotation(ctx, splatData, ctx.targetAngle * easeInOutCubic(t), f2h);
      if (t >= 1) { ctx.state = 'open'; ctx.unsubscribe(); ctx.onComplete?.(); }
    });

    ctx.unsubscribe = unsub;
    doorRef.current = ctx;
  }, [coreRef]);

  const closeDoor = useCallback((options?: { durationSec?: number; onComplete?: () => void }) => {
    const core = coreRef.current;
    const splatData = core?.getSplatData();
    const prev = doorRef.current;
    if (!core || !splatData || !prev) return;
    if (prev.state === 'closed' || prev.state === 'closing') return;
    if (prev.state === 'opening') prev.unsubscribe();

    const duration = options?.durationSec ?? prev.duration;
    const startT = prev.state === 'opening'
      ? 1 - Math.min(prev.elapsed / prev.duration, 1)
      : 0;

    const ctx: DoorContext = {
      ...prev, state: 'closing', duration,
      elapsed: startT * duration,
      unsubscribe: () => {}, onComplete: options?.onComplete,
    };

    const f2h = core.float2Half;
    const unsub = core.onUpdate((dt: number) => {
      ctx.elapsed += dt;
      const t = Math.min(ctx.elapsed / ctx.duration, 1);
      applyRotation(ctx, splatData, ctx.targetAngle * (1 - easeInOutCubic(t)), f2h);
      if (t >= 1) { ctx.state = 'closed'; ctx.unsubscribe(); doorRef.current = null; ctx.onComplete?.(); }
    });

    ctx.unsubscribe = unsub;
    doorRef.current = ctx;
  }, [coreRef]);

  const getDoorState = useCallback((): DoorState => {
    return doorRef.current?.state ?? 'closed';
  }, []);

  return { openDoor, closeDoor, getDoorState };
}
