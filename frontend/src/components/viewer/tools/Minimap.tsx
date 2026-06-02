'use client';

import { useEffect, useRef, useState } from 'react';
import type { FloorplanResult } from '@/lib/gs/floorplan';

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 6;

/**
 * 전체 층 평면도.
 *
 * - 기본 상태는 현재 카메라를 중앙에 두고, 카메라가 바라보는 방향이 위로 오도록 그린다.
 * - 빨강 삼각형은 항상 중앙에 고정된 현재 위치를 표시한다.
 *
 * 카메라는 매번 변하므로 prop 으로 직접 받지 않고 getter 로 주입 (ref-like).
 */

interface MinimapProps {
  floorplan: FloorplanResult;
  cameraGetter: () => any | null;
  size?: number; // px
}

export default function Minimap({ floorplan, cameraGetter, size = 220 }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoomRef = useRef(1);
  const userZoomedRef = useRef(false);
  const [hidden, setHidden] = useState(false);

  // floorplan 변경 시 — 사용자가 휠로 줌 안 했으면 방 전체가 들어오도록 auto-fit.
  useEffect(() => {
    if (userZoomedRef.current) return;
    const fit = Math.min(size / floorplan.width, size / floorplan.height) * 0.9;
    zoomRef.current = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fit));
  }, [floorplan, size]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const cam = cameraGetter();
      if (!cam) return;

      // 배경 클리어 (어두운 회색)
      ctx.fillStyle = '#0f1115';
      ctx.fillRect(0, 0, size, size);

      // 카메라 월드 좌표 + forward
      const pos = cam.getPosition();
      const fwd = cam.forward;

      // 평면도 픽셀 좌표 (player 위치) — 베이크 캔버스의 픽셀 단위
      const playerPx = (pos.x - floorplan.minX) * floorplan.ppm;
      const playerPy = (pos.z - floorplan.minZ) * floorplan.ppm;

      const fLen = Math.hypot(fwd.x, fwd.z);
      const heading = fLen > 1e-6 ? Math.atan2(fwd.z, fwd.x) : -Math.PI / 2;
      const headingToUp = -(heading + Math.PI / 2);

      const z = zoomRef.current;
      ctx.imageSmoothingEnabled = false;

      // 사용자 중심 미니맵: playerPx/playerPy 가 항상 패널 중앙에 오도록 translate 하고,
      // 카메라 forward 가 화면 위쪽을 향하도록 지도 자체를 반대로 회전한다.
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(headingToUp);
      ctx.drawImage(floorplan.canvas, -playerPx * z, -playerPy * z, floorplan.width * z, floorplan.height * z);
      ctx.restore();

      // 사용자 마커 — 지도는 회전하므로 마커는 중앙에서 위쪽을 향한 고정 삼각형.
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.fillStyle = '#ef4444';
      ctx.strokeStyle = '#fef2f2';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(-7, 7);
      ctx.lineTo(0, 3);
      ctx.lineTo(7, 7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [floorplan, cameraGetter, size]);

  // 휠 줌 — 캔버스 위에서만 동작, 페이지 스크롤 막음. zoom 은 ref 만 갱신 (raf tick 이 다음 프레임에 반영).
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current * factor));
      zoomRef.current = next;
      userZoomedRef.current = true;
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="relative" style={{ width: size }}>
      <button
        type="button"
        onClick={() => setHidden(h => !h)}
        className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded bg-black/70 text-white text-xs border border-white/20 hover:bg-black/85 shadow-lg"
        title={hidden ? '평면도 펼치기' : '평면도 숨기기'}
      >
        {hidden ? '◀' : '▶'}
      </button>

      {/* 슬라이드 래퍼 — 숨김 시 오른쪽으로 밀어 화면 밖으로. */}
      <div
        className="relative transition-transform duration-300 ease-out"
        style={{ transform: hidden ? 'translateX(calc(100% + 12px))' : 'translateX(0)' }}
      >
      {/* 사각 평면도 뷰포트 */}
      <div
        className="relative rounded-lg overflow-hidden border-2 border-[var(--rule)] shadow-xl bg-[var(--paper)]"
        style={{ width: size, height: size }}
      >
        <canvas ref={canvasRef} width={size} height={size} className="block" />
        <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[10px] text-[var(--ink)] bg-black/70 px-1.5 py-0.5 rounded font-bold tracking-wide">
          평면도
        </div>
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[9px] text-[var(--muted)] bg-black/50 px-1 py-0.5 rounded">
          휠: 줌 · 내 방향 기준
        </div>
      </div>
      </div>
    </div>
  );
}
