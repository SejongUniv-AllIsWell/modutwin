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
interface Props {
  onStartAuto: (prompt: string) => void;
  onSkipToManual: () => void;
  onClose: () => void;
}

export default function Sam3PromptModal({ onStartAuto, onSkipToManual, onClose }: Props) {
  const [prompt, setPrompt] = useState('');

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
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl text-gray-200 w-[800px] max-w-[90vw] p-8 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-2xl font-bold">문 자동 지정</div>
        <div className="text-sm text-gray-400 leading-relaxed">
          어떻게 생긴 문인지 설명해주세요.
          <br />
          예: <span className="text-gray-300">"흰색 손잡이가 있는 갈색 나무 문"</span>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="문에 대한 설명 입력..."
          spellCheck={false}
          rows={4}
          className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm resize-none focus:outline-none focus:border-indigo-500"
        />
        <div className="flex gap-3 pt-1">
          <button
            onClick={() => {
              // 빈 입력 / 공백만 입력이면 기본 프롬프트 'door' 사용.
              const trimmed = prompt.trim();
              onStartAuto(trimmed || 'door');
            }}
            className="flex-1 px-4 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg cursor-pointer text-sm font-bold"
            title="입력한 설명 (또는 빈 입력 시 기본 'door' 프롬프트) 으로 자동 문 추출 시작"
          >
            자동 문 지정
          </button>
          <button
            onClick={onSkipToManual}
            className="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg cursor-pointer text-sm font-bold"
            title="자동 추출을 건너뛰고 4 꼭짓점을 직접 클릭해 지정"
          >
            문 수동 지정
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
