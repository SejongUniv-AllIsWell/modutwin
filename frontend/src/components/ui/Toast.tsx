'use client';

import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';

type ToastKind = 'info' | 'error';

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

interface ToastContextType {
  show: (text: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextType>({ show: () => {} });

// Why: window.alert 가 페이지마다 흩어져 있어 UI 가 블로킹 모달로 끊기는 문제가 있었다.
// 단일 stack 형 토스트로 통합한다. 3초 후 자동 소멸.
const TOAST_TTL_MS = 3000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const show = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++idRef.current;
    setItems((prev) => [...prev, { id, text, kind }]);
  }, []);

  useEffect(() => {
    if (items.length === 0) return;
    const timer = window.setTimeout(() => {
      setItems((prev) => prev.slice(1));
    }, TOAST_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [items]);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div
        aria-live="polite"
        className="fixed top-4 right-4 z-[2000] flex flex-col gap-2 pointer-events-none"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className="px-3 py-2 rounded-sm border text-xs max-w-sm shadow-sm pointer-events-auto"
            style={{
              background: 'var(--paper)',
              borderColor: t.kind === 'error' ? '#d9a0a0' : 'var(--rule)',
              color: t.kind === 'error' ? '#b04646' : 'var(--ink)',
            }}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
