const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

class ApiClient {
  // 동시 요청들이 같은 refresh를 공유하도록 in-flight Promise를 보관 (single-flight)
  private refreshInFlight: Promise<boolean> | null = null;

  private getCookie(name: string): string | null {
    if (typeof document === 'undefined') return null;
    const encodedName = encodeURIComponent(name);
    const cookies = document.cookie ? document.cookie.split('; ') : [];
    for (const cookie of cookies) {
      if (!cookie.startsWith(`${encodedName}=`)) continue;
      return decodeURIComponent(cookie.slice(encodedName.length + 1));
    }
    return null;
  }

  private isUnsafeMethod(method?: string): boolean {
    const normalizedMethod = (method ?? 'GET').toUpperCase();
    return UNSAFE_METHODS.has(normalizedMethod);
  }

  private buildHeaders(options: RequestInit = {}): Headers {
    const headers = new Headers(options.headers);
    const method = (options.method ?? 'GET').toUpperCase();
    const hasStringBody = typeof options.body === 'string';

    if (hasStringBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    if (this.isUnsafeMethod(method)) {
      const csrfToken = this.getCookie('csrf_token');
      if (csrfToken) {
        headers.set('X-CSRF-Token', csrfToken);
      }
    }

    return headers;
  }

  clearSessionState() {
    if (typeof window === 'undefined') return;
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
  }

  async exchangeAuthCode(code: string): Promise<boolean> {
    const body = JSON.stringify({ code });
    try {
      const res = await fetch(`${API_BASE}/auth/exchange`, {
        method: 'POST',
        headers: this.buildHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
        body,
        credentials: 'include',
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** WebSocket 핸드셰이크용 1회용 ticket 발급. */
  async getWsTicket(): Promise<string | null> {
    try {
      const data = await this.fetch<{ ticket: string; expires_in: number }>(
        '/auth/ws-ticket',
        { method: 'POST' },
      );
      return data?.ticket ?? null;
    } catch {
      return null;
    }
  }

  private async refreshAccessToken(): Promise<boolean> {
    // 이미 진행 중인 refresh가 있으면 그 결과를 공유한다 (single-flight).
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: this.buildHeaders({ method: 'POST' }),
          credentials: 'include',
        });
        return res.ok;
      } catch {
        return false;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  async fetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase();
    const requestOptions: RequestInit = {
      ...options,
      method,
      headers: this.buildHeaders({ ...options, method }),
      credentials: 'include',
    };
    let res = await fetch(`${API_BASE}${path}`, requestOptions);

    // 401이면 세션 갱신 시도 (refresh 엔드포인트 자체에서는 재시도 금지)
    if (res.status === 401 && path !== '/auth/refresh') {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        const retryOptions: RequestInit = {
          ...options,
          method,
          headers: this.buildHeaders({ ...options, method }),
          credentials: 'include',
        };
        res = await fetch(`${API_BASE}${path}`, retryOptions);
      } else {
        this.clearSessionState();
      }
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({ detail: res.statusText }));
      throw new ApiError(error.detail || '요청에 실패했습니다.', res.status);
    }

    if (res.status === 204) return null as T;
    return res.json();
  }

  async get<T = any>(path: string): Promise<T> {
    return this.fetch<T>(path);
  }

  async post<T = any>(path: string, body?: any): Promise<T> {
    return this.fetch<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async put<T = any>(path: string, body?: any): Promise<T> {
    return this.fetch<T>(path, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async delete<T = any>(path: string): Promise<T> {
    return this.fetch<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient();
