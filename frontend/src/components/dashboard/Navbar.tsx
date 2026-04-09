'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth';

export default function Navbar() {
  const { user, login, logout } = useAuth();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-gray-900 border-b border-gray-800" style={{ minWidth: '500px' }}>
      <div className="px-10 flex items-center justify-between h-14">
        <Link href="/" className="text-white font-bold text-lg whitespace-nowrap">
          3DGS Platform
        </Link>

        <div className="flex items-center gap-4">
          {user ? (
            <>
              <Link href="/dashboard" className="text-gray-300 hover:text-white text-sm whitespace-nowrap">
                마이페이지
              </Link>
              <span className="text-gray-400 text-sm whitespace-nowrap">{user.name}</span>
              <button onClick={logout} className="text-gray-400 hover:text-white text-sm whitespace-nowrap">
                로그아웃
              </button>
            </>
          ) : (
            <button onClick={login} className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-1.5 rounded whitespace-nowrap">
              로그인
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
