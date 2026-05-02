'use client';

import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import BasemapManager from '@/components/dashboard/BasemapManager';

export default function AdminBasemapsPage() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && (!user || user.role !== 'admin')) {
      window.location.href = '/dashboard';
    }
  }, [user, loading]);

  if (loading || !user || user.role !== 'admin') {
    return <div className="flex items-center justify-center h-64 text-gray-500">로딩 중...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <BasemapManager />
    </div>
  );
}
