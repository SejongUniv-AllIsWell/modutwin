'use client';

import { useEffect, useRef, useState } from 'react';
import type { FloorplanResult } from '@/lib/gs/floorplan';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;

/**
 * FPS / GTA 스타일 헤딩-업 미니맵.
 *
 * - 평면도 이미지 (월드 XZ → 픽셀) 를 사용자(=카메라) 위치 중심으로 평행이동 + 헤딩만큼 회전.
 * - 사용자는 항상 화면 위쪽을 향함 (heading-up): 카메라 forward 가 위로 가도록 맵을 돌림.
 * - 사각 뷰포트 (캔버스 경계로 클립).
 * - 가운데 빨강 삼각형: 사용자, 항상 위를 가리킴.
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

      const z = zoomRef.current;
      const cx = size / 2, cy = size / 2;

      // 헤딩-업 회전각: 평면도 이미지 공간(+X 우, +Z 하)에서 forward 방향(fwd.x, fwd.z)이
      // 화면 위(-Y)를 향하도록 맵 전체를 회전. rot = -π/2 - atan2(fwd.z, fwd.x).
      const fLen = Math.hypot(fwd.x, fwd.z);
      const heading = fLen > 1e-6 ? Math.atan2(fwd.z, fwd.x) : -Math.PI / 2;
      const rot = -Math.PI / 2 - heading;

      // player 중심 회전 후 평면도 그리기 (사각 뷰포트, 캔버스 경계로 자동 클립)
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        floorplan.canvas,
        -playerPx * z,
        -playerPy * z,
        floorplan.width * z,
        floorplan.height * z,
      );
      ctx.restore();

      // 사용자 마커 — 항상 위(-Y)를 가리키는 삼각형, 중앙 고정
      ctx.fillStyle = '#ef4444';
      ctx.strokeStyle = '#fef2f2';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 11);       // tip (up)
      ctx.lineTo(cx - 7, cy + 7);    // base left
      ctx.lineTo(cx, cy + 3);        // notch
      ctx.lineTo(cx + 7, cy + 7);    // base right
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
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
    // 위치는 부모(우측 컬럼)가 결정. 바깥 컨테이너는 클립하지 않음 — 핸들이 뷰포트 밖에 놓여 잘리지 않도록.
    <div className="relative" style={{ width: size }}>
      {/* 슬라이드 래퍼 — 숨김 시 오른쪽으로 밀어 화면 밖으로 (핸들만 남김). */}
      <div
        className="relative transition-transform duration-300 ease-out"
        style={{ transform: hidden ? 'translateX(calc(100% + 12px))' : 'translateX(0)' }}
      >
        {/* 접기/펼치기 핸들 — 패널 왼쪽에 붙어 함께 이동, 숨김 시 화면 오른쪽 가장자리에 남음. */}
        <button
          type="button"
          onClick={() => setHidden(h => !h)}
          className="absolute top-2 -left-7 w-7 h-9 flex items-center justify-center rounded-l-md bg-black/70 text-white text-sm border border-r-0 border-white/20 hover:bg-black/85 shadow-lg"
          title={hidden ? '미니맵 펼치기' : '미니맵 숨기기'}
        >
          {hidden ? '◀' : '▶'}
        </button>
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
          휠: 줌
        </div>
      </div>
      </div>
    </div>
  );
}
