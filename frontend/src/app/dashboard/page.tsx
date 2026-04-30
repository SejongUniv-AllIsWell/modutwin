'use client';

import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import UserDashboard from '@/components/dashboard/UserDashboard';
import AdminDashboard from '@/components/dashboard/AdminDashboard';

export default function DashboardPage() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      window.location.href = '/';
    }
  }, [user, loading]);

  if (loading || !user) {
    return <div className="flex items-center justify-center h-64 text-gray-500">로딩 중...</div>;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      {user.role === 'admin' ? <AdminDashboard /> : <UserDashboard />}
    </div>
  );
}
