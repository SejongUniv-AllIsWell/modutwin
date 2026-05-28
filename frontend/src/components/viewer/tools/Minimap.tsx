'use client';

import { useEffect, useRef } from 'react';
import type { FloorplanResult } from '@/lib/gs/floorplan';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;

/**
 * FPS / GTA 스타일 미니맵.
 *
 * - 평면도 이미지 (월드 XZ → 픽셀) 를 매 프레임 평행이동해서 사용자(=카메라) 위치를 가운데로.
 * - X/Z 축 고정 (회전 없음).
 * - 가운데 빨강 점: 카메라 위치.
 * - 화살표: cameraEntity.forward 의 (x, z) 성분.
 *
 * 카메라는 매번 변하므로 prop 으로 직접 받지 않고 getter 로 주입 (ref-like).
 */

interface MinimapProps {
  floorplan: FloorplanResult;
  cameraGetter: () => any | null;
  size?: number; // px
  /** 천장 컷오프 (m) — 천장에서 이만큼 아래까지의 splat 만 평면도에 보임. */
  cutoff: number;
  onCutoffChange: (v: number) => void;
}

export default function Minimap({ floorplan, cameraGetter, size = 220, cutoff, onCutoffChange }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoomRef = useRef(1);
  const userZoomedRef = useRef(false);

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

      // 평면도 이미지 그리기 (player 가 캔버스 가운데 오도록 평행이동 + zoom 스케일)
      const z = zoomRef.current;
      const cx = size / 2, cy = size / 2;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        floorplan.canvas,
        cx - playerPx * z,
        cy - playerPy * z,
        floorplan.width * z,
        floorplan.height * z,
      );

      // 방향 화살표 (player 점 위에 그림)
      const fLen = Math.hypot(fwd.x, fwd.z);
      if (fLen > 1e-6) {
        const dx = fwd.x / fLen;
        const dz = fwd.z / fLen;
        const nx = -dz, ny = dx; // perpendicular
        const tipL = 22;
        const baseL = 6;
        const baseW = 8;
        const tipX = cx + dx * tipL;
        const tipY = cy + dz * tipL;
        const baseLX = cx + dx * baseL + nx * baseW;
        const baseLY = cy + dz * baseL + ny * baseW;
        const baseRX = cx + dx * baseL - nx * baseW;
        const baseRY = cy + dz * baseL - ny * baseW;
        ctx.fillStyle = '#ef4444';
        ctx.strokeStyle = '#fef2f2';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(baseLX, baseLY);
        ctx.lineTo(baseRX, baseRY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // 가운데 빨강 점
      ctx.fillStyle = '#ef4444';
      ctx.strokeStyle = '#fef2f2';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
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
    <div
      className="absolute top-3 right-3 z-30 rounded-lg overflow-hidden border-2 border-[var(--rule)] shadow-xl bg-[var(--paper)]"
      style={{ width: size, height: size }}
    >
      <canvas ref={canvasRef} width={size} height={size} className="block" />
      <div className="absolute top-1 left-1 text-[10px] text-[var(--ink)] bg-black/70 px-1.5 py-0.5 rounded font-bold tracking-wide">
        평면도
      </div>
      <div className="absolute bottom-1 right-1 text-[9px] text-[var(--muted)] bg-black/50 px-1 py-0.5 rounded">
        휠: 줌
      </div>
      {/* 천장 컷 슬라이더 — 천장에서 이만큼 아래까지의 splat 만 평면도에 보임. */}
      <div
        className="absolute bottom-1 left-1 right-1 flex items-center gap-1 text-[9px] text-[var(--ink)] bg-black/60 px-1.5 py-1 rounded"
        title="천장에서 이만큼 아래까지의 splat 만 평면도에 보임"
      >
        <span className="shrink-0">천장 컷</span>
        <input type="range" min={0} max={10} step={0.01}
          value={cutoff}
          onChange={e => onCutoffChange(parseFloat(e.target.value))}
          className="flex-1 accent-emerald-500 cursor-pointer" />
        <span className="font-mono w-10 text-right shrink-0">
          {cutoff < 1 ? `${(cutoff * 100).toFixed(0)}cm` : `${cutoff.toFixed(2)}m`}
        </span>
      </div>
    </div>
  );
}
