declare global {
  interface Window {
    d3?: any;
    topojson?: any;
    __landingGlobeSdkPromise__?: Promise<{ d3: any; topojson: any }>;
  }
}

const D3_URL = 'https://unpkg.com/d3@7.9.0/dist/d3.min.js';
const TOPOJSON_URL = 'https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js';

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.head.appendChild(script);
  });
}

export function loadGlobeSdk(): Promise<{ d3: any; topojson: any }> {
  if (window.d3 && window.topojson) {
    return Promise.resolve({ d3: window.d3, topojson: window.topojson });
  }
  if (window.__landingGlobeSdkPromise__) return window.__landingGlobeSdkPromise__;
  window.__landingGlobeSdkPromise__ = (async () => {
    await loadScript(D3_URL);
    await loadScript(TOPOJSON_URL);
    return { d3: (window as any).d3, topojson: (window as any).topojson };
  })();
  return window.__landingGlobeSdkPromise__;
}
