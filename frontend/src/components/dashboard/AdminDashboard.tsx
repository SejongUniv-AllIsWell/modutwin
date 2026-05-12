'use client';

import UserDashboard from './UserDashboard';
import BasemapManager from './BasemapManager';
import VisibilityManager from './VisibilityManager';

export default function AdminDashboard() {
  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">대시보드</h1>
          <span className="text-xs bg-purple-600/20 text-purple-300 px-2 py-0.5 rounded">관리자</span>
        </div>
      </div>

      <div className="space-y-8">
        <BasemapManager />
        <VisibilityManager />
        <UserDashboard showHeader={false} />
      </div>
    </div>
  );
}
