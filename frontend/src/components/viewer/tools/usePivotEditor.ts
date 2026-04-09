'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { SplatViewerCoreRef } from '../SplatViewerCore';
import { RefObject } from 'react';

export interface PivotAxis {
  pointA: [number, number, number];
  pointB: [number, number, number];
}

interface DragState {
  target: 'a' | 'b' | 'center' | 'rotate';
  startMouse: [number, number];
  startPivot: PivotAxis;         // 드래그 시작 시점의 A, B
  depth: number;
  startWorldPos: [number, number, number]; // 드래그 시작 월드 좌표
}

const HANDLE_SCREEN_RADIUS = 14;
const CENTER_SCREEN_RADIUS = 18;
const LINE_THICKNESS = 5;

export function usePivotEditor(
  coreRef: RefObject<SplatViewerCoreRef | null>,
) {
  const [editing, setEditing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const pivotRef = useRef<PivotAxis>({ pointA: [0, -1, 0], pointB: [0, 1, 0] });
  const [pivot, _setPivot] = useState<PivotAxis>(pivotRef.current);
  const dragRef = useRef<DragState | null>(null);
  const editingRef = useRef(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const cleanupEventsRef = useRef<(() => void) | null>(null);

  const setPivot = (p: PivotAxis) => {
    pivotRef.current = p;
    _setPivot({ ...p });
  };

  const getMidpoint = (p: PivotAxis): [number, number, number] => [
    (p.pointA[0] + p.pointB[0]) / 2,
    (p.pointA[1] + p.pointB[1]) / 2,
    (p.pointA[2] + p.pointB[2]) / 2,
  ];

  const worldToScreen = useCallback((pos: [number, number, number]): [number, number, number] | null => {
    const camera = coreRef.current?.getCamera();
    const pc = coreRef.current?.getPC();
    if (!camera?.camera || !pc) return null;
    const v = new pc.Vec3();
    camera.camera.worldToScreen(new pc.Vec3(pos[0], pos[1], pos[2]), v);
    return [v.x, v.y, v.z];
  }, [coreRef]);

  const screenToWorld = useCallback((sx: number, sy: number, depth: number): [number, number, number] | null => {
    const camera = coreRef.current?.getCamera();
    const pc = coreRef.current?.getPC();
    if (!camera?.camera || !pc) return null;
    const v = new pc.Vec3();
    camera.camera.screenToWorld(sx, sy, depth, v);
    return [v.x, v.y, v.z];
  }, [coreRef]);

  /** 두꺼운 선 그리기 */
  const drawThickLine = useCallback((
    a: [number, number, number],
    b: [number, number, number],
    color: [number, number, number, number],
  ) => {
    const core = coreRef.current;
    const camera = core?.getCamera();
    const pc = coreRef.current?.getPC();
    if (!core || !camera || !pc) return;

    const camPos = camera.getLocalPosition();
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const viewDir = new pc.Vec3(mid[0] - camPos.x, mid[1] - camPos.y, mid[2] - camPos.z).normalize();
    const lineDir = new pc.Vec3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    const right = new pc.Vec3().cross(lineDir, viewDir).normalize();
    const up = new pc.Vec3().cross(right, lineDir).normalize();

    const dist = Math.sqrt(
      (mid[0] - camPos.x) ** 2 + (mid[1] - camPos.y) ** 2 + (mid[2] - camPos.z) ** 2,
    );
    const offset = dist * 0.001;

    core.drawLine(a, b, color, false);
    for (let i = 1; i <= LINE_THICKNESS; i++) {
      const d = offset * i * 0.3;
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
        const offA: [number, number, number] = [
          a[0] + right.x * dx + up.x * dy,
          a[1] + right.y * dx + up.y * dy,
          a[2] + right.z * dx + up.z * dy,
        ];
        const offB: [number, number, number] = [
          b[0] + right.x * dx + up.x * dy,
          b[1] + right.y * dx + up.y * dy,
          b[2] + right.z * dx + up.z * dy,
        ];
        core.drawLine(offA, offB, color, false);
      }
    }
  }, [coreRef]);

  /** 마커 그리기 (십자) */
  const drawMarker = useCallback((
    pos: [number, number, number],
    color: [number, number, number, number],
    isHovered: boolean,
    scale: number = 1,
  ) => {
    const core = coreRef.current;
    const camera = core?.getCamera();
    if (!core || !camera) return;

    const camPos = camera.getLocalPosition();
    const dist = Math.sqrt(
      (pos[0] - camPos.x) ** 2 + (pos[1] - camPos.y) ** 2 + (pos[2] - camPos.z) ** 2,
    );
    const size = dist * (isHovered ? 0.015 : 0.01) * scale;

    const axes: [number, number, number][] = [[size, 0, 0], [0, size, 0], [0, 0, size]];
    for (const ax of axes) {
      core.drawLine(
        [pos[0] - ax[0], pos[1] - ax[1], pos[2] - ax[2]],
        [pos[0] + ax[0], pos[1] + ax[1], pos[2] + ax[2]],
        color, false,
      );
    }
  }, [coreRef]);

  /** 중앙에 회전 링 그리기 */
  const drawRotateRing = useCallback((
    center: [number, number, number],
    lineDir: [number, number, number],
    color: [number, number, number, number],
    isHovered: boolean,
  ) => {
    const core = coreRef.current;
    const camera = core?.getCamera();
    const pc = coreRef.current?.getPC();
    if (!core || !camera || !pc) return;

    const camPos = camera.getLocalPosition();
    const dist = Math.sqrt(
      (center[0] - camPos.x) ** 2 + (center[1] - camPos.y) ** 2 + (center[2] - camPos.z) ** 2,
    );
    const radius = dist * (isHovered ? 0.025 : 0.02);

    const dir = new pc.Vec3(lineDir[0], lineDir[1], lineDir[2]).normalize();
    // 선분에 수직인 두 벡터 구하기
    const viewDir = new pc.Vec3(center[0] - camPos.x, center[1] - camPos.y, center[2] - camPos.z).normalize();
    const right = new pc.Vec3().cross(dir, viewDir).normalize();
    const up = new pc.Vec3().cross(right, dir).normalize();

    const segments = 24;
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      const p1: [number, number, number] = [
        center[0] + right.x * Math.cos(a1) * radius + up.x * Math.sin(a1) * radius,
        center[1] + right.y * Math.cos(a1) * radius + up.y * Math.sin(a1) * radius,
        center[2] + right.z * Math.cos(a1) * radius + up.z * Math.sin(a1) * radius,
      ];
      const p2: [number, number, number] = [
        center[0] + right.x * Math.cos(a2) * radius + up.x * Math.sin(a2) * radius,
        center[1] + right.y * Math.cos(a2) * radius + up.y * Math.sin(a2) * radius,
        center[2] + right.z * Math.cos(a2) * radius + up.z * Math.sin(a2) * radius,
      ];
      core.drawLine(p1, p2, color, false);
    }
  }, [coreRef]);

  const startEditing = useCallback((doorIndices: number[]) => {
    const splatData = coreRef.current?.getSplatData();
    if (!splatData || doorIndices.length === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const idx of doorIndices) {
      const x = splatData.posX[idx], y = splatData.posY[idx], z = splatData.posZ[idx];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    const cx = minX;
    const cz = (minZ + maxZ) / 2;
    setPivot({
      pointA: [cx, minY, cz],
      pointB: [cx, maxY, cz],
    });

    setConfirmed(false);
    setEditing(true);
    editingRef.current = true;
  }, [coreRef]);

  const stopEditing = useCallback(() => {
    setEditing(false);
    editingRef.current = false;
  }, []);

  const confirmAxis = useCallback(() => {
    setConfirmed(true);
    setEditing(false);
    editingRef.current = false;
  }, []);

  const getPivotForAnimation = useCallback((): {
    pivot: [number, number, number];
    pivotAxis: 'x' | 'y' | 'z';
  } | null => {
    if (!confirmed) return null;
    const p = pivotRef.current;
    const mid = getMidpoint(p);

    const dx = Math.abs(p.pointB[0] - p.pointA[0]);
    const dy = Math.abs(p.pointB[1] - p.pointA[1]);
    const dz = Math.abs(p.pointB[2] - p.pointA[2]);

    let pivotAxis: 'x' | 'y' | 'z' = 'y';
    if (dx >= dy && dx >= dz) pivotAxis = 'x';
    else if (dz >= dy && dz >= dx) pivotAxis = 'z';

    return { pivot: mid, pivotAxis };
  }, [confirmed]);

  // 이벤트 등록 & 렌더링 루프
  useEffect(() => {
    if (!editing) {
      if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
      if (cleanupEventsRef.current) { cleanupEventsRef.current(); cleanupEventsRef.current = null; }
      return;
    }

    const core = coreRef.current;
    const canvas = core?.getCanvas();
    if (!core || !canvas) return;

    let hoveredHandle: 'a' | 'b' | 'center' | 'rotate' | null = null;

    const getHandleUnderMouse = (mx: number, my: number): 'a' | 'b' | 'center' | 'rotate' | null => {
      const p = pivotRef.current;
      const screenA = worldToScreen(p.pointA);
      const screenB = worldToScreen(p.pointB);
      if (!screenA || !screenB) return null;

      const mid = getMidpoint(p);
      const screenMid = worldToScreen(mid);
      if (!screenMid) return null;

      const distA = Math.hypot(mx - screenA[0], my - screenA[1]);
      const distB = Math.hypot(mx - screenB[0], my - screenB[1]);
      const distMid = Math.hypot(mx - screenMid[0], my - screenMid[1]);

      // 엔드포인트 우선
      if (distA < HANDLE_SCREEN_RADIUS && distA < distB && distA < distMid) return 'a';
      if (distB < HANDLE_SCREEN_RADIUS && distB < distA && distB < distMid) return 'b';

      // 회전 링 영역 (링 반경 ± 허용 오차)
      const camera = core.getCamera();
      if (camera) {
        const camPos = camera.getLocalPosition();
        const dist3d = Math.sqrt(
          (mid[0] - camPos.x) ** 2 + (mid[1] - camPos.y) ** 2 + (mid[2] - camPos.z) ** 2,
        );
        // 링의 스크린 반경 추정
        const ringScreenRadius = (dist3d * 0.02) / dist3d * 500; // 대략적 추정
        const ringTolerance = 8;
        if (Math.abs(distMid - ringScreenRadius) < ringTolerance) return 'rotate';
      }

      // 중앙 핸들
      if (distMid < CENTER_SCREEN_RADIUS) return 'center';

      return null;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !editingRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Shift+클릭으로 회전 모드
      const handle = e.shiftKey ? 'rotate' : getHandleUnderMouse(mx, my);
      if (!handle) return;

      // shift 회전은 중앙 근처에서만
      if (handle === 'rotate' && !e.shiftKey) {
        // 링 위에서만 가능 (getHandleUnderMouse에서 이미 판별)
      } else if (handle === 'rotate' && e.shiftKey) {
        const mid = getMidpoint(pivotRef.current);
        const screenMid = worldToScreen(mid);
        if (!screenMid) return;
        const distMid = Math.hypot(mx - screenMid[0], my - screenMid[1]);
        if (distMid > 60) return; // 너무 멀면 무시
      }

      e.stopPropagation();
      e.preventDefault();

      const p = pivotRef.current;
      let refPos: [number, number, number];
      if (handle === 'a') refPos = p.pointA;
      else if (handle === 'b') refPos = p.pointB;
      else refPos = getMidpoint(p);

      const screenPos = worldToScreen(refPos);
      if (!screenPos) return;

      dragRef.current = {
        target: handle,
        startMouse: [mx, my],
        startPivot: { pointA: [...p.pointA], pointB: [...p.pointB] },
        depth: screenPos[2],
        startWorldPos: [...refPos],
      };
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (dragRef.current) {
        e.stopPropagation();
        e.preventDefault();

        const drag = dragRef.current;
        const p = pivotRef.current;

        if (drag.target === 'a' || drag.target === 'b') {
          // 엔드포인트 이동
          const newWorld = screenToWorld(mx, my, drag.depth);
          if (!newWorld) return;
          const updated = { ...p };
          if (drag.target === 'a') updated.pointA = newWorld;
          else updated.pointB = newWorld;
          setPivot(updated);

        } else if (drag.target === 'center') {
          // 평행이동: 중앙을 드래그하면 A, B 모두 같은 만큼 이동
          const newWorld = screenToWorld(mx, my, drag.depth);
          if (!newWorld) return;
          const dx = newWorld[0] - drag.startWorldPos[0];
          const dy = newWorld[1] - drag.startWorldPos[1];
          const dz = newWorld[2] - drag.startWorldPos[2];
          setPivot({
            pointA: [
              drag.startPivot.pointA[0] + dx,
              drag.startPivot.pointA[1] + dy,
              drag.startPivot.pointA[2] + dz,
            ],
            pointB: [
              drag.startPivot.pointB[0] + dx,
              drag.startPivot.pointB[1] + dy,
              drag.startPivot.pointB[2] + dz,
            ],
          });

        } else if (drag.target === 'rotate') {
          // 회전: 마우스의 중앙 기준 각도로 선분 회전
          const mid = getMidpoint(drag.startPivot);
          const screenMid = worldToScreen(mid);
          if (!screenMid) return;

          const startAngle = Math.atan2(
            drag.startMouse[1] - screenMid[1],
            drag.startMouse[0] - screenMid[0],
          );
          const currentAngle = Math.atan2(
            my - screenMid[1],
            mx - screenMid[0],
          );
          const deltaAngle = currentAngle - startAngle;

          // 카메라 시선 방향 축으로 회전
          const camera = core.getCamera();
          if (!camera) return;
          const camPos = camera.getLocalPosition();
          const viewDir = [
            mid[0] - camPos.x,
            mid[1] - camPos.y,
            mid[2] - camPos.z,
          ];
          const viewLen = Math.sqrt(viewDir[0] ** 2 + viewDir[1] ** 2 + viewDir[2] ** 2);
          const axis = [viewDir[0] / viewLen, viewDir[1] / viewLen, viewDir[2] / viewLen];

          // Rodrigues 회전
          const rotatePoint = (pt: [number, number, number]): [number, number, number] => {
            const rel = [pt[0] - mid[0], pt[1] - mid[1], pt[2] - mid[2]];
            const cos = Math.cos(deltaAngle);
            const sin = Math.sin(deltaAngle);
            const dot = axis[0] * rel[0] + axis[1] * rel[1] + axis[2] * rel[2];
            const cross = [
              axis[1] * rel[2] - axis[2] * rel[1],
              axis[2] * rel[0] - axis[0] * rel[2],
              axis[0] * rel[1] - axis[1] * rel[0],
            ];
            return [
              mid[0] + rel[0] * cos + cross[0] * sin + axis[0] * dot * (1 - cos),
              mid[1] + rel[1] * cos + cross[1] * sin + axis[1] * dot * (1 - cos),
              mid[2] + rel[2] * cos + cross[2] * sin + axis[2] * dot * (1 - cos),
            ];
          };

          setPivot({
            pointA: rotatePoint(drag.startPivot.pointA),
            pointB: rotatePoint(drag.startPivot.pointB),
          });
        }
      } else {
        hoveredHandle = getHandleUnderMouse(mx, my);
        if (hoveredHandle === 'center') canvas.style.cursor = 'move';
        else if (hoveredHandle === 'rotate') canvas.style.cursor = 'crosshair';
        else if (hoveredHandle) canvas.style.cursor = 'grab';
        else canvas.style.cursor = '';
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (dragRef.current) {
        e.stopPropagation();
        dragRef.current = null;
        canvas.style.cursor = '';
      }
    };

    canvas.addEventListener('mousedown', onMouseDown, true);
    canvas.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);

    cleanupEventsRef.current = () => {
      canvas.removeEventListener('mousedown', onMouseDown, true);
      canvas.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      canvas.style.cursor = '';
    };

    // 매 프레임 그리기
    const unsub = core.onUpdate(() => {
      if (!editingRef.current) return;
      const p = pivotRef.current;
      const mid = getMidpoint(p);
      const lineDir: [number, number, number] = [
        p.pointB[0] - p.pointA[0],
        p.pointB[1] - p.pointA[1],
        p.pointB[2] - p.pointA[2],
      ];

      // 축 선
      drawThickLine(p.pointA, p.pointB, [1, 0.3, 0.3, 1]);

      // 엔드포인트 마커
      const isDragA = dragRef.current?.target === 'a';
      const isDragB = dragRef.current?.target === 'b';
      drawMarker(p.pointA, [1, 1, 0, 1], hoveredHandle === 'a' || isDragA);
      drawMarker(p.pointB, [0, 1, 1, 1], hoveredHandle === 'b' || isDragB);

      // 중앙 마커 (이동용, 초록)
      const isDragCenter = dragRef.current?.target === 'center';
      drawMarker(mid, [0.3, 1, 0.3, 1], hoveredHandle === 'center' || isDragCenter, 1.5);

      // 회전 링 (중앙 주위, 보라)
      const isDragRotate = dragRef.current?.target === 'rotate';
      drawRotateRing(mid, lineDir, [0.8, 0.3, 1, 1], hoveredHandle === 'rotate' || isDragRotate);
    });

    unsubRef.current = unsub;

    return () => {
      unsub();
      unsubRef.current = null;
      if (cleanupEventsRef.current) { cleanupEventsRef.current(); cleanupEventsRef.current = null; }
    };
  }, [editing, coreRef, worldToScreen, screenToWorld, drawThickLine, drawMarker, drawRotateRing]);

  // 확정 후에도 축 표시
  useEffect(() => {
    if (!confirmed || editing) return;
    const core = coreRef.current;
    if (!core) return;

    const unsub = core.onUpdate(() => {
      const p = pivotRef.current;
      drawThickLine(p.pointA, p.pointB, [0.3, 1, 0.3, 1]);
      drawMarker(p.pointA, [0.3, 1, 0.3, 1], false);
      drawMarker(p.pointB, [0.3, 1, 0.3, 1], false);
    });

    return () => unsub();
  }, [confirmed, editing, coreRef, drawThickLine, drawMarker]);

  return {
    editing,
    confirmed,
    pivot,
    startEditing,
    stopEditing,
    confirmAxis,
    getPivotForAnimation,
  };
}
