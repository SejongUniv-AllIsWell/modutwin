'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';

export default function Navbar() {
  const { user, login, logout } = useAuth();
  const pathname = usePathname();

  if (pathname === '/' || pathname === '/about') return null;

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 border-b backdrop-blur-sm"
      style={{ minWidth: 0, background: 'var(--bg)', borderColor: 'var(--rule)' }}
    >
      <div className="px-4 sm:px-10 flex items-center justify-between h-14 gap-4">
        <Link
          href="/"
          className="flex items-baseline gap-[10px] no-underline serif font-semibold text-xl whitespace-nowrap"
          style={{ color: 'var(--ink)', letterSpacing: 0 }}
        >
          modu
          <span
            className="inline-block w-[6px] h-[6px] -translate-y-[3px]"
            style={{ background: 'var(--ink)' }}
          />
          twin
        </Link>

        <div className="flex items-center gap-4">
          {user ? (
            <>
              <Link
                href="/dashboard"
                className="text-sm whitespace-nowrap hover:underline underline-offset-4"
                style={{ color: 'var(--ink-2)' }}
              >
                마이페이지
              </Link>
              <span className="text-sm whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                {user.name}
              </span>
              <button
                onClick={logout}
                className="text-sm whitespace-nowrap hover:underline underline-offset-4"
                style={{ color: 'var(--muted)' }}
              >
                로그아웃
              </button>
            </>
          ) : (
            <button
              onClick={login}
              className="text-sm px-4 py-1.5 rounded-sm whitespace-nowrap border"
              style={{
                background: 'var(--accent)',
                color: '#04131f',
                borderColor: 'var(--accent)',
              }}
            >
              로그인
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
