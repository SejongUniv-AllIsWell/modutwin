'use client';

import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import MultipartUploader from '@/components/upload/MultipartUploader';

export default function UploadPage() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      window.location.href = '/';
    }
  }, [user, loading]);

  if (loading || !user) return <div className="flex items-center justify-center h-64 text-gray-500">로딩 중...</div>;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-2">업로드</h1>
      <p className="text-gray-400 text-sm mb-8">건물 내부 영상 또는 3D 씬 파일(.ply, .splat, .sog)을 업로드하세요.</p>
      <MultipartUploader />
    </div>
  );
}
