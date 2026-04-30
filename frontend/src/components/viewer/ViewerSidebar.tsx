'use client';

import { useRef } from 'react';
import { EditorMode } from './UnifiedSplatEditor';

interface Props {
  mode: EditorMode;
  hasMain: boolean;
  hasMetadata: boolean;
  onPickFiles: (files: File[]) => void;
  onToggleMode: (next: 'refine' | 'align') => void;
  onBack: () => void;
}

const ACCEPT = '.ply,.splat,.sog';

export default function ViewerSidebar({
  mode, hasMain, hasMetadata, onPickFiles, onToggleMode, onBack,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (list && list.length > 0) onPickFiles(Array.from(list));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="absolute top-3 left-3 z-50 flex flex-col gap-1.5 bg-black/70 backdrop-blur-sm border border-white/10 rounded-lg p-1.5 shadow-lg">
      <button
        onClick={onBack}
        title="뒤로가기"
        className="flex items-center justify-center w-9 h-9 text-gray-300 hover:text-white hover:bg-gray-700/60 rounded transition cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <div className="h-px bg-white/10 mx-1" />

      <button
        onClick={() => fileInputRef.current?.click()}
        title="로컬 파일 선택 (.ply / .splat / .sog)"
        className="flex flex-col items-center gap-0.5 w-9 h-12 justify-center text-gray-200 hover:bg-gray-700/60 rounded transition cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span className="text-[10px]">파일</span>
      </button>

      <button
        onClick={() => onToggleMode('refine')}
        disabled={!hasMain}
        title={!hasMain ? '먼저 파일을 불러오세요' : '다듬기'}
        className={`flex flex-col items-center gap-0.5 w-9 h-12 justify-center rounded transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
          mode === 'refine'
            ? 'bg-orange-500/25 text-orange-300'
            : 'text-gray-200 hover:bg-gray-700/60'
        }`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        <span className="text-[10px]">다듬기</span>
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
        className={`flex flex-col items-center gap-0.5 w-9 h-12 justify-center rounded transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
          mode === 'align'
            ? 'bg-blue-500/25 text-blue-300'
            : 'text-gray-200 hover:bg-gray-700/60'
        }`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
        <span className="text-[10px]">정합</span>
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
