import { WsMessage } from '@/types';
import { api } from '@/lib/api';

type WsListener = (message: WsMessage) => void;
type StatusListener = (status: WsStatus) => void;

export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';

// 인증 실패 — 재시도 자체는 의미 있지만(다음 ticket이 통할 수 있음),
// backoff와 별개로 새 ticket을 매번 발급한다.
const CLOSE_CODE_AUTH_FAILED = 4401;

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 0; // 0 = 무한, 단 backoff로 빈도 자체가 작아짐

const HEARTBEAT_INTERVAL_MS = 25_000;        // 클라 → 서버 ping
const HEARTBEAT_TIMEOUT_MS = 60_000;         // 이 시간 내 서버로부터 메시지 없으면 dead 판정
const WS_TICKET_SUBPROTOCOL = 'ticket';
const WS_TICKET_PROTOCOL_PREFIX = 'ticket.';

class WebSocketClient {
  private ws: WebSocket | null = null;
  private listeners: Set<WsListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private status: WsStatus = 'idle';

  private wantConnected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  private onlineHandler = () => this.kickReconnect('online');
  private visibilityHandler = () => {
    if (document.visibilityState === 'visible') this.kickReconnect('visible');
  };
  private listenersInstalled = false;

  /** 인증된 상태에서 호출. 내부적으로 ticket을 받아 핸드셰이크를 수행한다. */
  connect() {
    if (typeof window === 'undefined') return;
    this.wantConnected = true;
    this.installGlobalListeners();
    if (this.status === 'open' || this.status === 'connecting') return;
    this.openSocket();
  }

  disconnect() {
    this.wantConnected = false;
    this.removeGlobalListeners();
    this.clearReconnect();
    this.clearHeartbeat();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      try { this.ws.close(1000, 'client disconnect'); } catch {}
      this.ws = null;
    }
    this.setStatus('idle');
    this.reconnectAttempts = 0;
  }

  subscribe(listener: WsListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: StatusListener) {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): WsStatus {
    return this.status;
  }

  // ───── internals ─────────────────────────────────────────────────

  private setStatus(s: WsStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach(fn => fn(s));
  }

  private installGlobalListeners() {
    if (this.listenersInstalled || typeof window === 'undefined') return;
    window.addEventListener('online', this.onlineHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.listenersInstalled = true;
  }

  private removeGlobalListeners() {
    if (!this.listenersInstalled || typeof window === 'undefined') return;
    window.removeEventListener('online', this.onlineHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.listenersInstalled = false;
  }

  private async openSocket() {
    if (!this.wantConnected) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // 오프라인 — 'online' 이벤트가 들어오면 다시 시도
      this.setStatus('reconnecting');
      return;
    }

    this.setStatus(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    const ticket = await api.getWsTicket();
    if (!this.wantConnected) return;
    if (!ticket) {
      // ticket 발급 실패(401/네트워크). API 클라이언트가 401 처리에서 토큰 갱신을 시도하므로
      // 여기서는 backoff로 다시 시도한다.
      this.scheduleReconnect();
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;
    const ticketProtocol = this.encodeTicketSubprotocol(ticket);
    if (!ticketProtocol) {
      this.scheduleReconnect();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, [WS_TICKET_SUBPROTOCOL, ticketProtocol]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus('open');
      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      this.bumpWatchdog();
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      // 서버 keepalive ping에는 pong으로 답한다.
      if (msg?.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
        return;
      }
      if (msg?.type === 'pong') return; // 우리 ping에 대한 응답 — 무시
      this.listeners.forEach(fn => {
        try { fn(msg as WsMessage); } catch {}
      });
    };

    ws.onerror = () => {
      // close가 곧 따라오므로 여기서는 별도 close 호출하지 않는다(중복 cleanup 방지).
    };

    ws.onclose = (ev: CloseEvent) => {
      this.clearHeartbeat();
      this.ws = null;

      if (!this.wantConnected || ev.code === 1000) {
        this.setStatus('idle');
        return;
      }

      // 인증 실패: refresh access token이 갱신되어 다음 ticket 발급은 성공할 수 있다.
      // backoff 없이 즉시(다음 tick) 재시도하되, 시도 횟수는 증가시켜 지속 실패 시 backoff로 수렴.
      if (ev.code === CLOSE_CODE_AUTH_FAILED) {
        this.reconnectAttempts += 1;
        this.scheduleReconnect(0);
        return;
      }

      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(forceDelayMs?: number) {
    if (!this.wantConnected) return;
    if (this.reconnectTimer) return; // 이미 예약됨
    if (MAX_RECONNECT_ATTEMPTS > 0 && this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setStatus('failed');
      return;
    }

    const attempt = this.reconnectAttempts++;
    const baseDelay = forceDelayMs ?? Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** attempt,
      MAX_RECONNECT_DELAY_MS,
    );
    const jitter = Math.random() * 0.3 * baseDelay;
    const delay = Math.floor(baseDelay + jitter);

    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private kickReconnect(_why: string) {
    if (!this.wantConnected) return;
    if (this.status === 'open' || this.status === 'connecting') return;
    // 백오프 대기 중이라면 즉시 재시도로 단축
    this.clearReconnect();
    this.openSocket();
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.bumpWatchdog();
  }

  private bumpWatchdog() {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      // 일정 시간 서버로부터 어떤 메시지도 못 받음 → half-open으로 간주하고 강제 종료
      try { this.ws?.close(4000, 'heartbeat timeout'); } catch {}
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.watchdogTimer) { clearTimeout(this.watchdogTimer); this.watchdogTimer = null; }
  }

  private encodeTicketSubprotocol(ticket: string): string | null {
    if (!ticket) return null;
    try {
      const bytes = new TextEncoder().encode(ticket);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      if (!base64url) return null;
      return `${WS_TICKET_PROTOCOL_PREFIX}${base64url}`;
    } catch {
      return null;
    }
  }
}

export const wsClient = new WebSocketClient();
