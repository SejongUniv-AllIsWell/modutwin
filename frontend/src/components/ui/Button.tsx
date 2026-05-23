'use client';

import { ButtonHTMLAttributes, forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

// Why: 페이지마다 bg-blue-600 / bg-green-600 / bg-red-600 가 흩어져 cream/paper 팔레트와
// 충돌했다. 모든 인터랙티브 액션을 이 컴포넌트로 라우팅해서 토큰화한 색만 쓰도록 강제한다.
const variantClass: Record<Variant, string> = {
  primary:
    'bg-[var(--ink)] text-[var(--bg)] border border-[var(--ink)] hover:opacity-90 disabled:opacity-50',
  secondary:
    'bg-[var(--paper)] text-[var(--ink)] border border-[var(--rule)] hover:bg-[var(--bg-soft)] disabled:opacity-50',
  danger:
    'bg-[var(--paper)] text-[#b04646] border border-[#d9a0a0] hover:bg-[#f6e6e6] disabled:opacity-50',
  ghost:
    'bg-transparent text-[var(--ink)] hover:bg-[var(--bg-soft)] disabled:opacity-50',
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
