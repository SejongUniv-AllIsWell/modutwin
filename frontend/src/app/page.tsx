'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';

export default function Home() {
  const { user, login, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) {
      router.replace('/explore');
    }
  }, [user, loading, router]);

  return (
    <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-56px)] px-4 overflow-hidden">
      <video
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover opacity-30"
      >
        <source src="/tmp.mp4" type="video/mp4" />
      </video>
      <div className="relative z-10 flex flex-col items-center px-4">
      <h1 className="text-5xl font-bold mb-4 text-center">3DGS Digital Twin</h1>
      <p className="text-gray-400 text-lg mb-8 text-center max-w-xl">
        건물 내부를 3D Gaussian Splatting으로 디지털 트윈화하는 플랫폼
      </p>

      <div className="flex gap-4">
        {user ? (
          <Link
            href="/explore"
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg text-sm font-medium transition"
          >
            탐색하기
          </Link>
        ) : (
          <button
            onClick={login}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg text-sm font-medium transition"
          >
            Google로 시작하기
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
