'use client';

import { useEffect } from 'react';

function canRegisterServiceWorker(): boolean {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;
  return window.location.protocol === 'https:'
    || window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1';
}

export default function AssetCacheServiceWorker() {
  useEffect(() => {
    if (!canRegisterServiceWorker()) return;
    navigator.serviceWorker
      .register('/asset-cache-sw.js', { scope: '/' })
      .catch((error) => {
        console.warn('[asset-cache-sw] registration failed', error);
      });
  }, []);

  return null;
}
