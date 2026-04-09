'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { SplatViewerCoreRef, SplatData } from '../SplatViewerCore';
import { RefObject } from 'react';
import { axisAngleToQuat, quatMul, quatNormalize, rotatePoint, Axis } from './quatUtils';
import { syncGPU, snapshotSplatData } from './gpuSync';

type TransformMode = 'translate' | 'rotate';

interface OriginalData {
  positions: Float32Array;
  quaternions: Float32Array;
}

interface DragState {
  axis: Axis;
  startMouse: [number, number];
  startGizmoCenter: [number, number, number];
  depth: number;
}

const AXIS_COLORS: Record<Axis, [number, number, number, number]> = {
  x: [1, 0.25, 0.25, 1],
  y: [0.25, 1, 0.25, 1],
  z: [0.35, 0.55, 1, 1],
};
const AXIS_HIGHLIGHT: Record<Axis, [number, number, number, number]> = {
  x: [1, 0.6, 0.6, 1],
  y: [0.6, 1, 0.6, 1],
  z: [0.6, 0.75, 1, 1],
};

const HANDLE_SCREEN_RADIUS = 12;
const RING_SEGMENTS = 32;

export function useTransformTool(
  coreRef: RefObject<SplatViewerCoreRef | null>,
) {
  const [active, setActive] = useState(false);
  const [mode, setMode] = useState<TransformMode>('translate');
  const activeRef = useRef(false);
  const modeRef = useRef<TransformMode>('translate');
  const indicesRef = useRef<number[]>([]);
  const origRef = useRef<OriginalData | null>(null);
  const gizmoCenterRef = useRef<[number, number, number]>([0, 0, 0]);
  const dragRef = useRef<DragState | null>(null);
  const hoveredRef = useRef<{ type: 'arrow' | 'ring'; axis: Axis } | null>(null);
  const accTranslationRef = useRef<[number, number, number]>([0, 0, 0]);
  const accRotationRef = useRef<Record<Axis, number>>({ x: 0, y: 0, z: 0 });

  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const computeCenter = useCallback((indices: number[]): [number, number, number] => {
    const sd = coreRef.current?.getSplatData();
    if (!sd || indices.length === 0) return [0, 0, 0];
    let cx = 0, cy = 0, cz = 0;
    for (const i of indices) { cx += sd.posX[i]; cy += sd.posY[i]; cz += sd.posZ[i]; }
    const n = indices.length;
    return [cx / n, cy / n, cz / n];
  }, [coreRef]);

  const startTransform = useCallback((indices: number[]) => {
    const sd = coreRef.current?.getSplatData();
    if (!sd || indices.length === 0) return;

    const snap = snapshotSplatData(sd, indices);
    indicesRef.current = indices;
    origRef.current = snap;
    gizmoCenterRef.current = computeCenter(indices);
    accTranslationRef.current = [0, 0, 0];
    accRotationRef.current = { x: 0, y: 0, z: 0 };
    setActive(true);
  }, [coreRef, computeCenter]);

  /** 원본으로부터 누적된 변환 전체를 적용 */
  const applyAccumulatedTransform = useCallback(() => {
    const sd = coreRef.current?.getSplatData();
    const orig = origRef.current;
    const indices = indicesRef.current;
    if (!sd || !orig) return;

    const gsplatData = sd.gsplatData;
    const rot0 = gsplatData?.getProp('rot_0');
    const rot1 = gsplatData?.getProp('rot_1');
    const rot2 = gsplatData?.getProp('rot_2');
    const rot3 = gsplatData?.getProp('rot_3');

    const t = accTranslationRef.current;
    const rots = accRotationRef.current;

    // 원본 center (회전 기준점)
    let ocx = 0, ocy = 0, ocz = 0;
    for (let i = 0; i < indices.length; i++) {
      ocx += orig.positions[i * 3]; ocy += orig.positions[i * 3 + 1]; ocz += orig.positions[i * 3 + 2];
    }
    const n = indices.length;
    const pivot: [number, number, number] = [ocx / n, ocy / n, ocz / n];

    // 복합 회전 쿼터니언 (X→Y→Z 순)
    let [cw, cx, cy, cz] = axisAngleToQuat('x', rots.x);
    const qy = axisAngleToQuat('y', rots.y);
    [cw, cx, cy, cz] = quatMul(qy[0], qy[1], qy[2], qy[3], cw, cx, cy, cz);
    const qz = axisAngleToQuat('z', rots.z);
    [cw, cx, cy, cz] = quatMul(qz[0], qz[1], qz[2], qz[3], cw, cx, cy, cz);

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      let px = orig.positions[i * 3];
      let py = orig.positions[i * 3 + 1];
      let pz = orig.positions[i * 3 + 2];

      if (rots.x !== 0) [px, py, pz] = rotatePoint(px, py, pz, pivot, 'x', rots.x);
      if (rots.y !== 0) [px, py, pz] = rotatePoint(px, py, pz, pivot, 'y', rots.y);
      if (rots.z !== 0) [px, py, pz] = rotatePoint(px, py, pz, pivot, 'z', rots.z);

      sd.posX[idx] = px + t[0];
      sd.posY[idx] = py + t[1];
      sd.posZ[idx] = pz + t[2];

      const ow = orig.quaternions[i * 4];
      const ox = orig.quaternions[i * 4 + 1];
      const oy = orig.quaternions[i * 4 + 2];
      const oz = orig.quaternions[i * 4 + 3];
      let [nw, nqx, nqy, nqz] = quatMul(cw, cx, cy, cz, ow, ox, oy, oz);
      [nw, nqx, nqy, nqz] = quatNormalize(nw, nqx, nqy, nqz);
      if (nw < 0) { nw = -nw; nqx = -nqx; nqy = -nqy; nqz = -nqz; }

      if (rot0) rot0[idx] = nw;
      if (rot1) rot1[idx] = nqx;
      if (rot2) rot2[idx] = nqy;
      if (rot3) rot3[idx] = nqz;
    }

    syncGPU(indices, sd, coreRef.current!.float2Half);
    gizmoCenterRef.current = computeCenter(indices);
  }, [coreRef, computeCenter]);

  const confirmTransform = useCallback(() => {
    setActive(false);
    origRef.current = null;
    indicesRef.current = [];
  }, []);

  const cancelTransform = useCallback(() => {
    const sd = coreRef.current?.getSplatData();
    const orig = origRef.current;
    const indices = indicesRef.current;
    if (!sd || !orig) { setActive(false); return; }

    const gsplatData = sd.gsplatData;
    const rot0 = gsplatData?.getProp('rot_0');
    const rot1 = gsplatData?.getProp('rot_1');
    const rot2 = gsplatData?.getProp('rot_2');
    const rot3 = gsplatData?.getProp('rot_3');

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      sd.posX[idx] = orig.positions[i * 3];
      sd.posY[idx] = orig.positions[i * 3 + 1];
      sd.posZ[idx] = orig.positions[i * 3 + 2];
      if (rot0) rot0[idx] = orig.quaternions[i * 4];
      if (rot1) rot1[idx] = orig.quaternions[i * 4 + 1];
      if (rot2) rot2[idx] = orig.quaternions[i * 4 + 2];
      if (rot3) rot3[idx] = orig.quaternions[i * 4 + 3];
    }

    syncGPU(indices, sd, coreRef.current!.float2Half);
    setActive(false);
    origRef.current = null;
    indicesRef.current = [];
  }, [coreRef]);

  // ── 기즈모 렌더링 + 인터랙션 ──
  useEffect(() => {
    if (!active) return;

    const core = coreRef.current;
    const canvas = core?.getCanvas();
    if (!core || !canvas) return;

    const worldToScreen = (pos: [number, number, number]): [number, number] | null => {
      const camera = core.getCamera();
      const pc = core.getPC();
      if (!camera?.camera || !pc) return null;
      const v = new pc.Vec3();
      camera.camera.worldToScreen(new pc.Vec3(pos[0], pos[1], pos[2]), v);
      return [v.x, v.y];
    };

    const getGizmoScale = (): number => {
      const camera = core.getCamera();
      if (!camera) return 1;
      const cp = camera.getLocalPosition();
      const c = gizmoCenterRef.current;
      return Math.sqrt((cp.x - c[0]) ** 2 + (cp.y - c[1]) ** 2 + (cp.z - c[2]) ** 2) * 0.15;
    };

    const getAxisEnd = (axis: Axis, scale: number): [number, number, number] => {
      const c = gizmoCenterRef.current;
      if (axis === 'x') return [c[0] + scale, c[1], c[2]];
      if (axis === 'y') return [c[0], c[1] + scale, c[2]];
      return [c[0], c[1], c[2] + scale];
    };

    const pickHandle = (mx: number, my: number): { type: 'arrow' | 'ring'; axis: Axis } | null => {
      const scale = getGizmoScale();
      const currentMode = modeRef.current;

      if (currentMode === 'translate') {
        for (const ax of ['x', 'y', 'z'] as Axis[]) {
          const end = getAxisEnd(ax, scale);
          const s = worldToScreen(end);
          if (s && Math.hypot(mx - s[0], my - s[1]) < HANDLE_SCREEN_RADIUS) {
            return { type: 'arrow', axis: ax };
          }
        }
      } else {
        const c = gizmoCenterRef.current;
        const radius = scale * 0.8;
        for (const ax of ['x', 'y', 'z'] as Axis[]) {
          for (let i = 0; i < RING_SEGMENTS; i++) {
            const a = (i / RING_SEGMENTS) * Math.PI * 2;
            const cos = Math.cos(a) * radius, sin = Math.sin(a) * radius;
            let pt: [number, number, number];
            if (ax === 'x') pt = [c[0], c[1] + cos, c[2] + sin];
            else if (ax === 'y') pt = [c[0] + cos, c[1], c[2] + sin];
            else pt = [c[0] + cos, c[1] + sin, c[2]];
            const s = worldToScreen(pt);
            if (s && Math.hypot(mx - s[0], my - s[1]) < HANDLE_SCREEN_RADIUS) {
              return { type: 'ring', axis: ax };
            }
          }
        }
      }
      return null;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !activeRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const hit = pickHandle(mx, my);
      if (!hit) return;

      e.stopPropagation();
      e.preventDefault();

      const camera = core.getCamera();
      const pc = core.getPC();
      if (!camera?.camera || !pc) return;
      const c = gizmoCenterRef.current;
      const sv = new pc.Vec3();
      camera.camera.worldToScreen(new pc.Vec3(c[0], c[1], c[2]), sv);

      dragRef.current = {
        axis: hit.axis,
        startMouse: [mx, my],
        startGizmoCenter: [...c],
        depth: sv.z,
      };
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;

      if (dragRef.current) {
        e.stopPropagation();
        e.preventDefault();

        const drag = dragRef.current;
        const currentMode = modeRef.current;

        if (currentMode === 'translate') {
          const axEnd = getAxisEnd(drag.axis, 1);
          const cScreen = worldToScreen(drag.startGizmoCenter);
          const aScreen = worldToScreen(axEnd);
          if (!cScreen || !aScreen) return;

          const axDirX = aScreen[0] - cScreen[0];
          const axDirY = aScreen[1] - cScreen[1];
          const axLen = Math.hypot(axDirX, axDirY);
          if (axLen < 1) return;

          const proj = ((mx - drag.startMouse[0]) * axDirX + (my - drag.startMouse[1]) * axDirY) / axLen;
          const camera = core.getCamera();
          if (!camera) return;
          const cp = camera.getLocalPosition();
          const c = drag.startGizmoCenter;
          const dist = Math.sqrt((cp.x - c[0]) ** 2 + (cp.y - c[1]) ** 2 + (cp.z - c[2]) ** 2);
          const delta = proj * dist * 0.002;

          const t: [number, number, number] = [0, 0, 0];
          const axIdx = drag.axis === 'x' ? 0 : drag.axis === 'y' ? 1 : 2;
          t[axIdx] = delta;
          accTranslationRef.current = [...t];
          applyAccumulatedTransform();
        } else {
          const c = gizmoCenterRef.current;
          const cScreen = worldToScreen(c);
          if (!cScreen) return;

          const startAngle = Math.atan2(drag.startMouse[1] - cScreen[1], drag.startMouse[0] - cScreen[0]);
          const currentAngle = Math.atan2(my - cScreen[1], mx - cScreen[0]);
          let deltaAngle = currentAngle - startAngle;

          // 카메라 시선 방향과 회전 축의 관계에 따라 부호 보정
          const camera = core.getCamera();
          if (camera) {
            const fwd = camera.forward;
            const axisDot = drag.axis === 'x' ? fwd.x : drag.axis === 'y' ? fwd.y : fwd.z;
            if (axisDot > 0) deltaAngle = -deltaAngle;
          }

          const rots = { ...accRotationRef.current };
          rots[drag.axis] = deltaAngle;
          accRotationRef.current = rots;
          applyAccumulatedTransform();
        }
      } else {
        hoveredRef.current = pickHandle(mx, my);
        canvas.style.cursor = hoveredRef.current ? 'grab' : '';
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!dragRef.current) return;
      e.stopPropagation();

      // 현재 상태를 새 원본으로 저장
      const sd = coreRef.current?.getSplatData();
      const indices = indicesRef.current;
      if (sd && indices.length > 0) {
        origRef.current = snapshotSplatData(sd, indices);
        accTranslationRef.current = [0, 0, 0];
        accRotationRef.current = { x: 0, y: 0, z: 0 };
        gizmoCenterRef.current = computeCenter(indices);
      }

      dragRef.current = null;
      canvas.style.cursor = '';
    };

    canvas.addEventListener('mousedown', onMouseDown, true);
    canvas.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);

    // ── 기즈모 그리기 ──
    const unsub = core.onUpdate(() => {
      if (!activeRef.current) return;
      const scale = getGizmoScale();
      const c = gizmoCenterRef.current;
      const hovered = hoveredRef.current;
      const currentMode = modeRef.current;

      if (currentMode === 'translate') {
        for (const ax of ['x', 'y', 'z'] as Axis[]) {
          const end = getAxisEnd(ax, scale);
          const isActive = (hovered?.type === 'arrow' && hovered.axis === ax) || dragRef.current?.axis === ax;
          const col = isActive ? AXIS_HIGHLIGHT[ax] : AXIS_COLORS[ax];
          core.drawLine(c, end, col, false);

          // 화살촉
          const tipLen = scale * 0.12;
          const dir: [number, number, number] = [end[0] - c[0], end[1] - c[1], end[2] - c[2]];
          const len = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
          if (len > 0) {
            const nd = [dir[0] / len, dir[1] / len, dir[2] / len];
            let perp1: [number, number, number], perp2: [number, number, number];
            if (ax === 'x') { perp1 = [0, 1, 0]; perp2 = [0, 0, 1]; }
            else if (ax === 'y') { perp1 = [1, 0, 0]; perp2 = [0, 0, 1]; }
            else { perp1 = [1, 0, 0]; perp2 = [0, 1, 0]; }
            for (const p of [perp1, perp2]) {
              const d = tipLen * 0.3;
              core.drawLine(end, [end[0] - nd[0] * tipLen + p[0] * d, end[1] - nd[1] * tipLen + p[1] * d, end[2] - nd[2] * tipLen + p[2] * d], col, false);
              core.drawLine(end, [end[0] - nd[0] * tipLen - p[0] * d, end[1] - nd[1] * tipLen - p[1] * d, end[2] - nd[2] * tipLen - p[2] * d], col, false);
            }
          }
        }
      } else {
        const radius = scale * 0.8;
        for (const ax of ['x', 'y', 'z'] as Axis[]) {
          const isActive = (hovered?.type === 'ring' && hovered.axis === ax) || dragRef.current?.axis === ax;
          const col = isActive ? AXIS_HIGHLIGHT[ax] : AXIS_COLORS[ax];
          for (let i = 0; i < RING_SEGMENTS; i++) {
            const a1 = (i / RING_SEGMENTS) * Math.PI * 2;
            const a2 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
            let p1: [number, number, number], p2: [number, number, number];
            if (ax === 'x') {
              p1 = [c[0], c[1] + Math.cos(a1) * radius, c[2] + Math.sin(a1) * radius];
              p2 = [c[0], c[1] + Math.cos(a2) * radius, c[2] + Math.sin(a2) * radius];
            } else if (ax === 'y') {
              p1 = [c[0] + Math.cos(a1) * radius, c[1], c[2] + Math.sin(a1) * radius];
              p2 = [c[0] + Math.cos(a2) * radius, c[1], c[2] + Math.sin(a2) * radius];
            } else {
              p1 = [c[0] + Math.cos(a1) * radius, c[1] + Math.sin(a1) * radius, c[2]];
              p2 = [c[0] + Math.cos(a2) * radius, c[1] + Math.sin(a2) * radius, c[2]];
            }
            core.drawLine(p1, p2, col, false);
          }
        }
      }

      // 중앙 점
      const sz = scale * 0.03;
      core.drawLine([c[0] - sz, c[1], c[2]], [c[0] + sz, c[1], c[2]], [1, 1, 1, 1], false);
      core.drawLine([c[0], c[1] - sz, c[2]], [c[0], c[1] + sz, c[2]], [1, 1, 1, 1], false);
      core.drawLine([c[0], c[1], c[2] - sz], [c[0], c[1], c[2] + sz], [1, 1, 1, 1], false);
    });

    return () => {
      unsub();
      canvas.removeEventListener('mousedown', onMouseDown, true);
      canvas.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      canvas.style.cursor = '';
    };
  }, [active, coreRef, applyAccumulatedTransform, computeCenter]);

  return { active, mode, setMode, startTransform, confirmTransform, cancelTransform };
}
