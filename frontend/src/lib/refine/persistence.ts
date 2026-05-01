// 정제 작업 설정을 브라우저 localStorage에 저장/복원.
// PLY 자체는 메모리에서만 다루고, 사용자가 "정제 결과 저장"을 누를 때만 MinIO에 올라간다.
// 따라서 여기에는 PLY 참조 없이 사용자가 확정한 파라미터만 보관한다.
// upload_id별로 독립된 엔트리.

const KEY_PREFIX = 'refine_state_v4_';
const STATE_VERSION = 4;

export type Surface = 'ceiling' | 'floor' | 'w1a' | 'w1b' | 'w2a' | 'w2b';

export interface PersistedRefineState {
  version: number;

  cfConfirmed: boolean;
  ceilingY: number;
  floorY: number;

  wallConfirmed: boolean;
  wallAngle: number | null;
  wallDistances: [number, number, number, number] | null;

  selectedSurfaces: Surface[];
  // 모든 경계면이 공유하는 단일 안전거리 (m)
  globalOffset: number;
  globalOffsetText: string;
}

function storageKey(uploadId: string): string {
  return `${KEY_PREFIX}${uploadId}`;
}

export function saveRefineState(uploadId: string, state: Omit<PersistedRefineState, 'version'>): void {
  try {
    const payload: PersistedRefineState = { version: STATE_VERSION, ...state };
    localStorage.setItem(storageKey(uploadId), JSON.stringify(payload));
  } catch (e) {
    console.warn('[refine] persist save failed', e);
  }
}

export function loadRefineState(uploadId: string): PersistedRefineState | null {
  try {
    const raw = localStorage.getItem(storageKey(uploadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedRefineState;
    if (parsed.version !== STATE_VERSION) return null;
    return parsed;
  } catch (e) {
    console.warn('[refine] persist load failed', e);
    return null;
  }
}

export function clearRefineState(uploadId: string): void {
  try {
    localStorage.removeItem(storageKey(uploadId));
  } catch { /* ignore */ }
}
