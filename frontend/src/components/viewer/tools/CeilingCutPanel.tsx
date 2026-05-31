'use client';

import { useState } from 'react';

interface CeilingCutPanelProps {
  /** 라이브 3D 천장 컷 ON/OFF (paperCeilingCut). */
  enabled: boolean;
  onToggle: () => void;
  /** 천장에서 아래로 제거할 깊이 (m). */
  cutoff: number;
  onCutoffChange: (v: number) => void;
  /** 패널 너비 — 미니맵과 폭을 맞추기 위함. */
  width?: number;
}

/**
 * 라이브 3D 씬의 천장 컷을 제어하는 패널.
 *
 * - ON/OFF: 천장에서 cutoff 깊이 이내 가우시안을 투명화 + 시각적 천장 메시 숨김.
 * - 슬라이더: 컷 깊이 조절. (미니맵 이미지 베이크는 별도 고정값을 쓰므로 영향 없음.)
 * - 핸들로 오른쪽 화면 밖으로 슬라이드 숨김/펼침 (미니맵과 동일 패턴).
 */
export default function CeilingCutPanel({ enabled, onToggle, cutoff, onCutoffChange, width = 220 }: CeilingCutPanelProps) {
  const [hidden, setHidden] = useState(false);

  return (
    <div className="relative" style={{ width }}>
      {/* 슬라이드 래퍼 — 숨김 시 오른쪽으로 밀어 화면 밖으로 (핸들만 남김). */}
      <div
        className="relative transition-transform duration-300 ease-out"
        style={{ transform: hidden ? 'translateX(calc(100% + 12px))' : 'translateX(0)' }}
      >
        {/* 접기/펼치기 핸들 — 패널 왼쪽에 붙어 함께 이동. */}
        <button
          type="button"
          onClick={() => setHidden(h => !h)}
          className="absolute top-2 -left-7 w-7 h-9 flex items-center justify-center rounded-l-md bg-[var(--paper)]/80 backdrop-blur-sm text-[var(--ink)] text-sm border border-r-0 border-[var(--rule)] hover:bg-[var(--paper)] shadow-lg"
          title={hidden ? '천장 컷 펼치기' : '천장 컷 숨기기'}
        >
          {hidden ? '◀' : '▶'}
        </button>

        {/* 패널 카드 — 반투명 배경 + blur. */}
        <div className="rounded-lg border-2 border-[var(--rule)] bg-[var(--paper)]/80 backdrop-blur-sm shadow-xl px-3 py-2.5 space-y-2.5">
          {/* ON/OFF */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-[var(--ink)]">천장 컷</span>
            <button
              type="button"
              onClick={onToggle}
              role="switch"
              aria-checked={enabled}
              className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${
                enabled ? 'bg-[var(--accent)]' : 'bg-[var(--rule)]'
              }`}
              title="천장에서 지정 깊이 이내 가우시안을 투명화하고 천장 메시를 숨깁니다."
            >
              <span
                className="absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform duration-200"
                style={{ transform: enabled ? 'translateX(16px)' : 'translateX(0)' }}
              />
            </button>
          </div>

          {/* 깊이 슬라이더 */}
          <div className={`flex items-center gap-1.5 text-[9px] text-[var(--ink)] transition-opacity ${enabled ? '' : 'opacity-40'}`}>
            <span className="shrink-0">깊이</span>
            <input
              type="range" min={0} max={10} step={0.01}
              value={cutoff}
              disabled={!enabled}
              onChange={e => onCutoffChange(parseFloat(e.target.value))}
              className="flex-1 accent-[var(--accent)] cursor-pointer disabled:cursor-not-allowed"
            />
            <span className="font-mono w-10 text-right shrink-0 text-[var(--muted)]">
              {cutoff < 1 ? `${(cutoff * 100).toFixed(0)}cm` : `${cutoff.toFixed(2)}m`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
