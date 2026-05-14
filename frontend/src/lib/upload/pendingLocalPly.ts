// /upload 페이지가 .ply (또는 .splat/.sog) 파일을 받아 /viewer 로 넘길 때 사용하는 핸드오프 페이로드.
// 같은 document 안에서만 유효한 blob URL 을 sessionStorage 로 전달한다.
export const PENDING_LOCAL_PLY_KEY = 'pendingLocalPly';

export interface PendingLocalPlyPayload {
  blobUrl: string;
  filename: string;
  fileSize: number;
  purpose: string;
  building_id?: string;
  building_name: string;
  floor_id?: string;
  floor_number: number;
  module_name: string;
  place_id?: string;
  address_name?: string;
  road_address_name?: string;
  lat?: number;
  lng?: number;
  createdAt: number;
}

export function readPendingLocalPly(): PendingLocalPlyPayload | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(PENDING_LOCAL_PLY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingLocalPlyPayload;
    if (!parsed.blobUrl || !parsed.filename) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingLocalPly() {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(PENDING_LOCAL_PLY_KEY);
  } catch {
    // ignore
  }
}
