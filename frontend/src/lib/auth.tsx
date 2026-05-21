'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { User } from '@/types';
import { api, ApiError } from '@/lib/api';
import { wsClient } from '@/lib/ws';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    api.get<User>('/auth/me')
      .then((u) => {
        if (!mounted) return;
        setUser(u);
        wsClient.connect();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          api.clearSessionState();
        }
        if (!mounted) return;
        setUser(null);
        wsClient.disconnect();
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const login = async () => {
    try {
      const data = await api.get<{ url: string }>('/auth/login');
      window.location.href = data.url;
    } catch (e) {
      console.error('로그인 URL 요청 실패:', e);
    }
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {}
    api.clearSessionState();
    wsClient.disconnect();
    setUser(null);
    window.location.href = '/';
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

// 보호된 페이지에서 unauthenticated 사용자를 redirectTo 로 보낸다.
// loading 중에는 아무것도 하지 않으므로 깜빡임 없이 안전하게 게이트.
export function useRequireAuth(redirectTo: string = '/') {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !user) {
      router.replace(redirectTo);
    }
  }, [loading, user, redirectTo, router]);
  return { user, loading };
}
