'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import BasemapManager from '@/components/dashboard/BasemapManager';

export default function AdminBasemapsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && (!user || user.role !== 'admin')) {
      router.replace('/dashboard');
    }
  }, [user, loading, router]);

  if (loading || !user || user.role !== 'admin') {
    return <div className="flex items-center justify-center h-64 text-[var(--muted)]">로딩 중...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <BasemapManager />
    </div>
  );
}
