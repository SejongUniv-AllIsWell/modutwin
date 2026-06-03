'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 다듬기 완료 → 문 설정 진입 시 띄우는 SAM3 프롬프트 입력 / 자동 추출 시작 팝업.
 *
 * 동작:
 *  - SAM3 프롬프트 입력칸 (선택 사항).
 *  - "자동 문 지정" 버튼: 프롬프트로 자동 추출 시작 → onStartAuto 호출 → 모달 닫힘 (백그라운드 진행).
 *  - "문 수동 지정" 버튼: 자동 추출 건너뛰고 바로 수동 지정 모드 → onSkipToManual 호출 → 모달 닫힘.
 *  - ESC / 외부 클릭 시 모달 닫힘 (자동 추출 진행 중에도 가능). 단 입력 안 한 상태에선 onSkipToManual 처럼 동작하지 않고 단순 닫힘.
 */
export interface Sam3AutoOptions {
  interiorMinHits: number;
  interiorStrict: boolean;
}

interface Props {
  onStartAuto: (prompt: string, opts: Sam3AutoOptions) => void;
  onSkipToManual: () => void;
  onClose: () => void;
}

export default function Sam3PromptModal({ onStartAuto, onSkipToManual, onClose }: Props) {
  const [prompt, setPrompt] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [interiorMinHits, setInteriorMinHits] = useState(22);
  const [interiorStrict, setInteriorStrict] = useState(true);

  // ESC 로 닫기.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal((
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[var(--paper)] border border-[var(--rule)] rounded-xl shadow-2xl text-[var(--ink)] w-[800px] max-w-[90vw] p-8 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-2xl font-bold">문 자동 지정</div>
        <div className="text-sm text-[var(--muted)] leading-relaxed">
          Describe the door in English (SAM3 requires English).
          <br />
          e.g. <span className="text-[var(--ink-2)]">"white door"</span>, <span className="text-[var(--ink-2)]">"brown wooden door with handle"</span>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the door in English..."
          spellCheck={false}
          rows={4}
          className="w-full bg-[var(--bg-soft)] border border-[var(--rule)] rounded-lg px-3 py-2.5 text-sm resize-none focus:outline-none focus:border-indigo-500"
        />
        {/* 고급 설정: Phase 1 interior gate 조정 (긴/비볼록 방이 "interior 미달"로 즉시 실패할 때). */}
        <div className="border-t border-[var(--rule)] pt-3">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-xs text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
          >
            {showAdvanced ? '▾' : '▸'} 고급 설정 (방 내부 검사)
          </button>
          {showAdvanced && (
            <div className="mt-3 space-y-3 text-sm">
              <div className="text-xs text-[var(--muted)] leading-relaxed">
                For long/non-convex rooms, lower min hits or disable strict check.
              </div>
              <label className="flex items-center justify-between gap-3">
                <span>Min interior hits (default 22 / 26)</span>
                <input
                  type="number"
                  min={0}
                  max={26}
                  value={interiorMinHits}
                  onChange={(e) => setInteriorMinHits(Math.max(0, Math.min(26, Number(e.target.value) || 0)))}
                  className="w-20 bg-[var(--bg-soft)] border border-[var(--rule)] rounded-md px-2 py-1 text-right focus:outline-none focus:border-indigo-500"
                />
              </label>
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span>Strict interior check</span>
                <input
                  type="checkbox"
                  checked={interiorStrict}
                  onChange={(e) => setInteriorStrict(e.target.checked)}
                  className="w-4 h-4 cursor-pointer"
                />
              </label>
            </div>
          )}
        </div>
        <div className="flex gap-3 pt-1">
          <button
            onClick={() => {
              // 빈 입력 / 공백만 입력이면 기본 프롬프트 'door' 사용.
              const trimmed = prompt.trim();
              onStartAuto(trimmed || 'door', { interiorMinHits, interiorStrict });
            }}
            className="flex-1 px-4 py-3 bg-indigo-600 hover:bg-indigo-500 text-[var(--ink)] rounded-lg cursor-pointer text-sm font-bold"
            title="입력한 설명 (또는 빈 입력 시 기본 'door' 프롬프트) 으로 자동 문 추출 시작"
          >
            자동 문 지정
          </button>
          <button
            onClick={onSkipToManual}
            className="flex-1 px-4 py-3 bg-[var(--bg-soft)] hover:bg-[var(--rule)] text-[var(--ink)] rounded-lg cursor-pointer text-sm font-bold"
            title="자동 추출을 건너뛰고 4 꼭짓점을 직접 클릭해 지정"
          >
            문 수동 지정
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
