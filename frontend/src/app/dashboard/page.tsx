'use client';

import { useRequireAuth } from '@/lib/auth';
import UserDashboard from '@/components/dashboard/UserDashboard';
import AdminDashboard from '@/components/dashboard/AdminDashboard';

export default function DashboardPage() {
  const { user, loading } = useRequireAuth();

  if (loading || !user) {
    return <div className="flex items-center justify-center h-64 text-[var(--muted)]">로딩 중...</div>;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      {user.role === 'admin' ? <AdminDashboard /> : <UserDashboard />}
    </div>
  );
}
