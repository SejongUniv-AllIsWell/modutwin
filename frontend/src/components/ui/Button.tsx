'use client';

import { ButtonHTMLAttributes, forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

// Why: 페이지마다 직접 지정한 색이 흩어지면 테마가 쉽게 어긋난다.
// 공통 버튼은 토큰화한 색만 쓰도록 이 컴포넌트로 모은다.
const variantClass: Record<Variant, string> = {
  primary:
    'bg-[var(--accent)] text-[#04131f] border border-[var(--accent)] hover:brightness-110 active:brightness-95 disabled:opacity-50',
  secondary:
    'bg-[var(--paper)] text-[var(--ink)] border border-[var(--rule)] hover:bg-sky-400/10 disabled:opacity-50',
  danger:
    'bg-[var(--paper)] text-red-300 border border-red-400/40 hover:bg-red-500/10 disabled:opacity-50',
  ghost:
    'bg-transparent text-[var(--ink)] hover:bg-sky-400/10 disabled:opacity-50',
};

const sizeClass: Record<Size, string> = {
  sm: 'text-xs px-3 py-1.5 rounded-sm',
  md: 'text-[13.5px] px-4 py-2 rounded-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className = '', ...rest },
  ref,
) {
  const merged = `${variantClass[variant]} ${sizeClass[size]} disabled:cursor-not-allowed transition ${className}`;
  return <button ref={ref} className={merged} {...rest} />;
});
