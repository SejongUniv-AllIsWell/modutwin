'use client';

import { useEffect, useRef } from 'react';
import { floorLabelKo } from '@/lib/format/floor';

const ITEM_HEIGHT = 44;
const VISIBLE_PADDING = ITEM_HEIGHT * 2;

export function roomNumberLabel(floorNumber: number, suffix: number): string {
  return `${floorNumber}${String(suffix).padStart(2, '0')}호`;
}

function WheelPicker({
  items,
  value,
  onChange,
  format,
}: {
  items: number[];
  value: number;
  onChange: (next: number) => void;
  format: (item: number) => string;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  // 스크롤 중 rAF 로 강조 인덱스만 갱신하고, 정지(idle) 가 감지되면
  // 가까운 항목으로 smooth scrollTo. CSS scroll-snap 은 wheel 한 틱마다
  // 강제로 끊는 느낌을 주기 때문에 제거하고 수동 idle-snap 으로 대체.
  const rafRef = useRef<number | null>(null);
  const snapTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!listRef.current) return;
    const idx = items.indexOf(value);
    listRef.current.scrollTop = Math.max(0, idx) * ITEM_HEIGHT;
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (snapTimerRef.current != null) window.clearTimeout(snapTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleIdleSnap = () => {
    if (snapTimerRef.current != null) window.clearTimeout(snapTimerRef.current);
    snapTimerRef.current = window.setTimeout(() => {
      snapTimerRef.current = null;
      if (!listRef.current) return;
      const idx = Math.round(listRef.current.scrollTop / ITEM_HEIGHT);
      const clamped = Math.max(0, Math.min(items.length - 1, idx));
      const targetTop = clamped * ITEM_HEIGHT;
      if (Math.abs(listRef.current.scrollTop - targetTop) > 0.5) {
        listRef.current.scrollTo({ top: targetTop, behavior: 'smooth' });
      }
    }, 160);
  };

  const handleScroll = () => {
    if (!listRef.current) return;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (!listRef.current) return;
        const idx = Math.round(listRef.current.scrollTop / ITEM_HEIGHT);
        const clamped = Math.max(0, Math.min(items.length - 1, idx));
        const next = items[clamped];
        if (next !== value) onChange(next);
      });
    }
    scheduleIdleSnap();
  };

  return (
    <div className="relative h-[220px] w-40 mx-auto select-none">
      {/* 중앙 강조 라인 — 텍스트 뒤에 깔리도록 z-0, 텍스트는 z-10. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-[44px] border-y z-0"
        style={{ borderColor: 'var(--ink)' }}
      />
      <ul
        ref={listRef}
        onScroll={handleScroll}
        className="relative z-10 h-full overflow-y-auto"
        style={{
          scrollbarWidth: 'none',
          paddingTop: VISIBLE_PADDING,
          paddingBottom: VISIBLE_PADDING,
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
        }}
      >
        {items.map((item, idx) => {
          const active = item === value;
          return (
            <li
              key={item}
              style={{
                height: ITEM_HEIGHT,
                transform: active ? 'scale(1.08)' : 'scale(1)',
                opacity: active ? 1 : 0.55,
                transition: 'transform 120ms ease-out, opacity 120ms ease-out, color 120ms ease-out',
              }}
              className={`flex items-center justify-center text-lg ${
                active ? 'text-[var(--ink)] font-bold' : 'text-[var(--muted)]'
              }`}
              onClick={() => {
                listRef.current?.scrollTo({
                  top: idx * ITEM_HEIGHT,
                  behavior: 'smooth',
                });
              }}
            >
              {format(item)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function RoomWheelPicker({
  floorNumber,
  value,
  onChange,
}: {
  floorNumber: number;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <WheelPicker
      items={Array.from({ length: 99 }, (_, i) => i + 1)}
      value={value}
      onChange={onChange}
      format={(suffix) => roomNumberLabel(floorNumber, suffix)}
    />
  );
}

// 0층은 존재하지 않음 — F50 ~ B5 (내림차순, 0 제외).
// 좌측 패널의 층 목록이 내림차순으로 표시되는 컨벤션을 휠 피커에도 그대로 적용.
const FLOOR_ITEMS: number[] = (() => {
  const list: number[] = [];
  for (let i = 50; i >= -5; i -= 1) {
    if (i === 0) continue;
    list.push(i);
  }
  return list;
})();

export function FloorWheelPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <WheelPicker
      items={FLOOR_ITEMS}
      value={value}
      onChange={onChange}
      format={floorLabelKo}
    />
  );
}
