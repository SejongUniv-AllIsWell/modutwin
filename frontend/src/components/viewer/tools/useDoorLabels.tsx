'use client';

import { RefObject, useEffect, useRef } from 'react';
import type { SplatViewerCoreRef } from '../SplatViewerCore';

export interface DoorLabelEntry {
  id: string;
  unitName: string | null;       // null = 미설정 (회색 라벨로 "미설정" 표시)
  corners: number[][];            // A'+Y 프레임 4 corners. centroid 로 라벨 위치 계산.
}

/**
 * 도어 corners (A'+Y 프레임) 위에 말풍선 HTML 라벨 표시.
 * 매 프레임 카메라 worldToScreen 으로 화면 좌표 갱신.
 *
 * Z-180 viewer 컨벤션 가정 → world = (-x, -y, z).
 */
export function useDoorLabels(
  coreRef: RefObject<SplatViewerCoreRef | null>,
  doors: DoorLabelEntry[],
  enabled: boolean,
): void {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled || doors.length === 0) return;

    let cancelled = false;
    const labels: { el: HTMLDivElement; world: any }[] = [];

    (async () => {
      // splat 까지 마운트 대기.
      let attempts = 0;
      while (!coreRef.current?.getApp() && attempts < 50) {
        if (cancelled) return;
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }
      if (cancelled) return;
      const app = coreRef.current?.getApp();
      const pc = coreRef.current?.getPC();
      if (!app || !pc) return;
      const canvas: HTMLCanvasElement | undefined = (app as any).graphicsDevice?.canvas;
      const parent = canvas?.parentElement;
      if (!canvas || !parent) return;
      if (!parent.style.position) parent.style.position = 'relative';

      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10;overflow:hidden;';
      parent.appendChild(overlay);
      overlayRef.current = overlay;

      for (const door of doors) {
        if (!door.corners || door.corners.length === 0) continue;
        let cx = 0, cy = 0, cz = 0;
        for (const c of door.corners) { cx += c[0]; cy += c[1]; cz += c[2]; }
        cx /= door.corners.length; cy /= door.corners.length; cz /= door.corners.length;
        const world = new pc.Vec3(-cx, -cy, cz);

        const el = document.createElement('div');
        const hasName = !!door.unitName;
        el.style.cssText = [
          'position:absolute',
          'transform:translate(-50%,calc(-100% - 10px))',
          'padding:4px 10px',
          hasName ? 'background:rgba(20,20,20,0.88)' : 'background:rgba(120,60,0,0.88)',
          'color:#fff',
          hasName ? 'border:1px solid rgba(250,204,21,0.85)' : 'border:1px solid rgba(250,200,100,0.85)',
          'border-radius:8px',
          'font-size:12px',
          'font-weight:600',
          'font-family:sans-serif',
          'white-space:nowrap',
          'pointer-events:none',
          'box-shadow:0 2px 6px rgba(0,0,0,0.4)',
          'display:none',
        ].join(';');
        el.textContent = hasName ? door.unitName! : '호수 미설정';
        const tail = document.createElement('div');
        tail.style.cssText = [
          'position:absolute',
          'left:50%','bottom:-6px',
          'transform:translateX(-50%)',
          'width:0','height:0',
          'border-left:6px solid transparent',
          'border-right:6px solid transparent',
          hasName ? 'border-top:6px solid rgba(20,20,20,0.88)' : 'border-top:6px solid rgba(120,60,0,0.88)',
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
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      if (overlayRef.current) {
        try { overlayRef.current.remove(); } catch {}
        overlayRef.current = null;
      }
    };
  }, [coreRef, doors, enabled]);
}
