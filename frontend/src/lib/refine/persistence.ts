// 정제 작업 설정을 브라우저 localStorage에 저장/복원.
// PLY 자체는 메모리에서만 다루고, 사용자가 "정제 결과 저장"을 누를 때만 MinIO에 올라간다.
// 따라서 여기에는 PLY 참조 없이 사용자가 확정한 파라미터만 보관한다.
// upload_id별로 독립된 엔트리.

// v6: 4벽 wallDistances → N벽 wallPolygon (cycle 순서의 N개 점). 마이그레이션 미지원.
const KEY_PREFIX = 'refine_state_v6_';
const STATE_VERSION = 6;

// surfaceId 가 동적 (`w0..w(N-1)`) 이라 string. refineTypes.Surface 와 동일.
export type Surface = string;

/** 벽 폴리곤 한 꼭짓점 (XZ 평면). cycle 순서로 배열. */
export interface WallPolygonPoint {
  x: number;
  z: number;
}

export interface PersistedRefineState {
  version: number;

  cfConfirmed: boolean;
  ceilingY: number;
  floorY: number;
  // pendingRotation (radians) — 천장/바닥 모달에서 잡은 X/Z 축 정렬.
  // surfacePlanesFromPolygon 의 평면이 정의되는 A' 프레임을 표현.
  rotX: number;
  rotZ: number;

  wallConfirmed: boolean;
  // 벽 베이크용 Y회전 (도). 폴리곤의 PCA 또는 첫 변 방향 등에서 derive. 폴리곤 변경 시에도
  // 일관된 베이크 회전을 위해 한 번 freeze 한다 (Phase 4 에서 정책 확정).
  wallAngle: number | null;
  // 사용자가 정의한 벽 폴리곤. 4점이면 직사각, N점이면 N각형. surfacePlanesFromPolygon 입력.
  wallPolygon: WallPolygonPoint[] | null;

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

export function copyRefineState(sourceUploadId: string, targetUploadId: string): void {
  try {
    const raw = localStorage.getItem(storageKey(sourceUploadId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedRefineState;
    if (parsed.version !== STATE_VERSION) return;
    localStorage.setItem(storageKey(targetUploadId), raw);
  } catch (e) {
    console.warn('[refine] persist copy failed', e);
  }
}
