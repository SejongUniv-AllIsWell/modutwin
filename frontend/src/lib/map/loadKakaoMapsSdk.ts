const KAKAO_SDK_URL = 'https://dapi.kakao.com/v2/maps/sdk.js';

declare global {
  interface Window {
    kakao: any;
    __kakaoMapsSdkPromise__?: Promise<any>;
  }
}

export const loadKakaoMapsSdk = (appKey: string): Promise<any> => {
  if (window.kakao?.maps) {
    return new Promise<any>((resolve) => {
      window.kakao.maps.load(() => resolve(window.kakao));
    });
  }

  if (window.__kakaoMapsSdkPromise__) return window.__kakaoMapsSdkPromise__;

  window.__kakaoMapsSdkPromise__ = new Promise<any>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src^="${KAKAO_SDK_URL}"]`);
    const onReady = () => {
      window.kakao.maps.load(() => resolve(window.kakao));
    };
    const onError = () => {
      window.__kakaoMapsSdkPromise__ = undefined;
      reject(new Error('Kakao Maps SDK load failed'));
    };

    if (existing) {
      if (window.kakao?.maps) {
        onReady();
        return;
      }
      existing.addEventListener('load', onReady, { once: true });
      existing.addEventListener('error', onError, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = `${KAKAO_SDK_URL}?appkey=${appKey}&autoload=false&libraries=services`;
    script.addEventListener('load', onReady, { once: true });
    script.addEventListener('error', onError, { once: true });
    document.head.appendChild(script);
  });

  return window.__kakaoMapsSdkPromise__;
};
