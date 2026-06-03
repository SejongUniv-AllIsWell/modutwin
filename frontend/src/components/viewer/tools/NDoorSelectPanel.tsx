'use client';

/**
 * N-door 자동 추출 결과 선택 패널.
 *
 * 자동 추출로 N개 문이 감지됐을 때 표시. 각 문을 번호로 나열하고
 * "이 문 사용" 클릭 시 해당 문 corners 를 onSelect 로 전달.
 * 3D 와이어프레임 하이라이트는 onHover 로 호버 index 를 부모에 전달.
 */

import { createPortal } from 'react-dom';

export type DoorCorners = Array<[number, number, number]>;

interface Props {
  doors: DoorCorners[];           // N개 문 corners (raw 프레임)
  onSelect: (idx: number) => void; // "이 문 사용" 클릭
  onHover: (idx: number | null) => void; // 마우스 호버 (와이어프레임 하이라이트)
  onClose: () => void;
}

const DOOR_COLORS = [
  '#60a5fa', // blue-400
  '#34d399', // emerald-400
  '#f472b6', // pink-400
  '#fb923c', // orange-400
  '#a78bfa', // violet-400
  '#facc15', // yellow-400
  '#2dd4bf', // teal-400
  '#e879f9', // fuchsia-400
];

export default function NDoorSelectPanel({ doors, onSelect, onHover, onClose }: Props) {
  if (typeof document === 'undefined') return null;
  return createPortal((
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
         onClick={onClose}>
      <div
        className="bg-[var(--paper)] border border-[var(--rule)] rounded-xl shadow-2xl text-[var(--ink)] w-[480px] max-w-[92vw] p-6 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-lg font-bold">검출된 문 {doors.length}개</div>
          <button onClick={onClose}
            className="text-[var(--muted)] hover:text-[var(--ink)] text-xl cursor-pointer leading-none">✕</button>
        </div>
        <div className="text-xs text-[var(--muted)]">
          자동 추출된 문 후보입니다. 설정할 문을 선택하세요.
          (나머지 문은 이후 문 설정 단계에서 추가할 수 있습니다.)
        </div>

        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {doors.map((corners, idx) => {
            const color = DOOR_COLORS[idx % DOOR_COLORS.length];
            const lt = corners[0];
            const rb = corners[3];
            const w = Math.sqrt((lt[0]-corners[1][0])**2 + (lt[2]-corners[1][2])**2);
            const h = Math.sqrt((lt[0]-corners[2][0])**2 + (lt[1]-corners[2][1])**2 + (lt[2]-corners[2][2])**2);
            return (
              <div
                key={idx}
                className="flex items-center gap-3 p-3 rounded-lg border border-[var(--rule)] hover:bg-[var(--bg-soft)] cursor-default"
                onMouseEnter={() => onHover(idx)}
                onMouseLeave={() => onHover(null)}
              >
                {/* 색상 배지 */}
                <div className="w-4 h-10 rounded-sm shrink-0" style={{ backgroundColor: color }} />

                {/* 문 정보 */}
                <div className="flex-1 text-xs font-mono space-y-0.5">
                  <div className="font-bold text-sm text-[var(--ink)]">문 {idx + 1}</div>
                  <div className="text-[var(--muted)]">
                    너비 {w.toFixed(2)}m · 높이 {h.toFixed(2)}m
                  </div>
                  <div className="text-[var(--muted)]">
                    LT ({lt[0].toFixed(2)}, {lt[1].toFixed(2)}, {lt[2].toFixed(2)})
                  </div>
                </div>

                {/* 선택 버튼 */}
                <button
                  onClick={() => onSelect(idx)}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold cursor-pointer shrink-0"
                >
                  이 문 사용
                </button>
              </div>
            );
          })}
        </div>

        <div className="text-xs text-[var(--muted)] pt-1 border-t border-[var(--rule)]">
          3D 뷰에서 각 문이 컬러 윤곽선으로 표시됩니다.
        </div>
      </div>
    </div>
  ), document.body);
}
