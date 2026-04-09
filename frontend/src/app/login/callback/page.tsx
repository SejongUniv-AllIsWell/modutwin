'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Suspense } from 'react';

function CallbackHandler() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [message, setMessage] = useState('로그인 처리 중...');

  useEffect(() => {
    const code = searchParams.get('code');

    // 코드가 URL에 남지 않도록 즉시 제거 (브라우저 히스토리/Referer 노출 방지)
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', '/login/callback');
    }

    if (!code) {
      setStatus('error');
      setMessage('로그인에 실패했습니다.');
      return;
    }

    (async () => {
      const ok = await api.exchangeAuthCode(code);
      if (ok) {
        setStatus('success');
        setMessage('로그인 성공! 이동합니다...');
        setTimeout(() => { window.location.href = '/explore'; }, 1000);
      } else {
        setStatus('error');
        setMessage('로그인에 실패했습니다.');
      }
    })();
  }, [searchParams]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-56px)]">
      <div className="text-center">
        {status === 'processing' && <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />}
        <p className={`text-lg ${status === 'error' ? 'text-red-400' : 'text-gray-300'}`}>{message}</p>
      </div>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[calc(100vh-56px)]"><p className="text-gray-400">로딩 중...</p></div>}>
      <CallbackHandler />
    </Suspense>
  );
}
