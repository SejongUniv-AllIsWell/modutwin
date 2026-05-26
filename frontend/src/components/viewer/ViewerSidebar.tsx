'use client';

import { useRef } from 'react';
import { EditorMode } from './UnifiedSplatEditor';

interface Props {
  mode: EditorMode;
  hasMain: boolean;
  hasMetadata: boolean;
  /** 완료 버튼으로 통과한 단계들. 단방향 진행 — 잠긴 단계로 되돌아갈 수 없음. */
  lockedStages: ReadonlySet<'upload' | 'refine' | 'door'>;
  onPickFiles: (files: File[]) => void;
  onToggleMode: (next: 'refine' | 'door' | 'align') => void;
  /** 사이드바 + 레이어 + 툴 패널 전체를 왼쪽으로 밀어 숨김. */
  onCollapse: () => void;
}

const ACCEPT = '.ply,.splat,.sog';

export default function ViewerSidebar({
  mode, hasMain, hasMetadata, lockedStages, onPickFiles, onToggleMode, onCollapse,
}: Props) {
  const uploadLocked = lockedStages.has('upload');
  const refineLocked = lockedStages.has('refine');
  const doorLocked = lockedStages.has('door');
  const lockTitle = '이전 단계는 완료된 상태로 잠겼습니다. 되돌릴 수 없습니다.';
  // 잠긴 단계: 텍스트가 살짝 흐리되 확실히 읽히게 (검은 배경 기준 opacity-40 은 거의 안 보임).
  const lockedClass = 'text-gray-500 cursor-not-allowed';
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (list && list.length > 0) onPickFiles(Array.from(list));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="flex flex-row items-stretch gap-1.5 bg-black/70 backdrop-blur-sm border border-white/10 rounded-lg p-1.5 shadow-lg">
      <button
        onClick={onCollapse}
        title="패널 숨기기"
        className="flex items-center justify-center w-9 h-9 text-[var(--ink-2)] hover:text-[var(--ink)] hover:bg-[var(--bg-soft)]/60 rounded transition cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <div className="w-px bg-white/10 my-1" />

      <button
        onClick={() => { if (!uploadLocked) fileInputRef.current?.click(); }}
        disabled={uploadLocked}
        title={uploadLocked ? lockTitle : '로컬 파일 선택 (.ply / .splat / .sog)'}
        className={`flex flex-col items-center justify-center gap-0.5 w-14 h-9 rounded transition ${
          uploadLocked
            ? lockedClass
            : !hasMain
              ? 'bg-indigo-500/25 text-indigo-300 cursor-pointer'
              : 'text-[var(--ink)] hover:bg-[var(--bg-soft)]/60 cursor-pointer'
        }`}
      >
        <span className="text-[11px] leading-none">업로드</span>
      </button>

      <button
        onClick={() => onToggleMode('refine')}
        disabled={!hasMain || refineLocked}
        title={!hasMain ? '먼저 파일을 불러오세요' : refineLocked ? lockTitle : '다듬기'}
        className={`flex flex-col items-center justify-center gap-0.5 w-14 h-9 rounded transition disabled:cursor-not-allowed ${
          refineLocked
            ? lockedClass
            : hasMain && mode === 'refine'
              ? 'bg-indigo-500/25 text-indigo-300 cursor-pointer'
              : 'text-[var(--ink)] hover:bg-[var(--bg-soft)]/60 cursor-pointer disabled:opacity-40'
        }`}
      >
        <span className="text-[11px] leading-none">다듬기</span>
      </button>

      <button
        onClick={() => onToggleMode('door')}
        disabled={!hasMain || doorLocked}
        title={!hasMain ? '먼저 파일을 불러오세요' : doorLocked ? lockTitle : '문 설정'}
        className={`flex flex-col items-center justify-center gap-0.5 w-14 h-9 rounded transition disabled:cursor-not-allowed ${
          doorLocked
            ? lockedClass
            : hasMain && mode === 'door'
              ? 'bg-indigo-500/25 text-indigo-300 cursor-pointer'
              : 'text-[var(--ink)] hover:bg-[var(--bg-soft)]/60 cursor-pointer disabled:opacity-40'
        }`}
      >
        <span className="text-[11px] leading-none">문 설정</span>
      </button>

      <button
        onClick={() => onToggleMode('align')}
        disabled={!hasMain}
        title={
          !hasMain
            ? '먼저 파일을 불러오세요'
            : !hasMetadata && mode !== 'align'
              ? '정합 시작 시 건물/층/모듈 정보가 필요합니다'
              : '정합'
        }
        className={`flex flex-col items-center justify-center gap-0.5 w-14 h-9 rounded transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
          hasMain && mode === 'align'
            ? 'bg-indigo-500/25 text-indigo-300'
            : 'text-[var(--ink)] hover:bg-[var(--bg-soft)]/60'
        }`}
      >
        <span className="text-[11px] leading-none">정합</span>
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        multiple
        onChange={handleFile}
        className="hidden"
      />
    </div>
  );
}
