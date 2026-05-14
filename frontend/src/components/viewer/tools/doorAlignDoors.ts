import { api } from '@/lib/api';

export type Vec3 = [number, number, number];

export interface PickedCorner {
  pos: Vec3; // raw splat frame
  surfaceId: string; // 어느 면(벽/천장/바닥)에 떨어졌는지
}

// doors.json 은 서버 (`uploads/{id}/refined/doors.json`) 에 저장된다. 통째 덮어쓰기 —
// 이력 보존 안 함. 본 모달은 단일 문(door_1)만 다루지만 SAM3 결과로 여러 문이 들어와있을 수
// 있으므로 door_1 (또는 첫 번째 항목) 만 추출해서 편집.
export const PRIMARY_DOOR_ID = 'door_1';

// 서버 doors.json 스키마 — corners 외에 힌지/회전 메타 + 추출 분류 파라미터도 함께 저장.
// 후속 뷰어가 basemap 위에서 사용자 상호작용 (문 열기) 할 때 어느 변/방향/각도로 열어야 하는지,
// 그리고 동일 분류 결과 재현 (decompose 입력) 위해 사용.
//   hingeEdge: 0..3 (P0→P1=0, P1→P2=1, P2→P3=2, P3→P0=3). null = 미설정.
//   swing: 1 (방 안쪽) | -1 (방 바깥쪽).
//   angleDeg: 열림 각도 (도).
//   wallSurfaceId: 'w1a' | 'w1b' | 'w2a' | 'w2b' | 'ceiling' | 'floor'. 어느 면 도어인지.
//   doorThickness: 슬랩 깊이 (m, 방 안쪽 단방향).
//   boundarySplitEnabled: 경계 분할 ON/OFF.
//   safetyMargin: 분할 안전 마진.
export interface DoorMeshMeta {
  corners: number[][];      // 4 × 3 (A'+Y 프레임, z-fight 오프셋 적용)
  uvs: number[][];          // 4 × 2
  normalInward: number[];   // [x, y, z]
  textureFilename: string;  // "tex_door_<doorId>.png"
  textureWidth: number;
  textureHeight: number;
}

export interface DoorSplatMeta {
  filename: string;         // "door_<doorId>.ply"
}

interface DoorMeta {
  id: string;
  corners: number[][];
  unitName?: string;
  hingeEdge?: number | null;
  swing?: 1 | -1;
  angleDeg?: number;
  wallSurfaceId?: string;
  doorThickness?: number;
  boundarySplitEnabled?: boolean;
  safetyMargin?: number;
  doorMesh?: DoorMeshMeta;
  doorSplat?: DoorSplatMeta;
}

interface DoorsJson {
  doors: DoorMeta[];
}

export function emptyPicked(): Array<PickedCorner | null> {
  return [null, null, null, null];
}

export interface FetchedDoor {
  picked: Array<PickedCorner | null>;
  hingeEdge: number | null;
  swing: 1 | -1;
  angleDeg: number;
  wallSurfaceId: string | null;
  doorThickness: number | null;
  boundarySplitEnabled: boolean | null;
  safetyMargin: number | null;
}

export async function fetchDoorsFromServer(uploadId: string): Promise<FetchedDoor> {
  const empty: FetchedDoor = {
    picked: emptyPicked(),
    hingeEdge: null,
    swing: 1,
    angleDeg: 75,
    wallSurfaceId: null,
    doorThickness: null,
    boundarySplitEnabled: null,
    safetyMargin: null,
  };
  if (!uploadId.trim()) return empty;
  try {
    const data = await api.get<DoorsJson>(`/uploads/${uploadId}/doors`);
    if (!data.doors || data.doors.length === 0) return empty;
    const target = data.doors.find(d => d.id === PRIMARY_DOOR_ID) ?? data.doors[0];
    if (!target?.corners || target.corners.length !== 4) return empty;
    const surfaceId = typeof target.wallSurfaceId === 'string' ? target.wallSurfaceId : '';
    return {
      picked: target.corners.map(c => ({ pos: [c[0], c[1], c[2]] as Vec3, surfaceId })),
      hingeEdge: typeof target.hingeEdge === 'number' ? target.hingeEdge : null,
      swing: target.swing === -1 ? -1 : 1,
      angleDeg: typeof target.angleDeg === 'number' ? target.angleDeg : 75,
      wallSurfaceId: surfaceId || null,
      doorThickness: typeof target.doorThickness === 'number' ? target.doorThickness : null,
      boundarySplitEnabled: typeof target.boundarySplitEnabled === 'boolean' ? target.boundarySplitEnabled : null,
      safetyMargin: typeof target.safetyMargin === 'number' ? target.safetyMargin : null,
    };
  } catch (e: any) {
    return empty;
  }
}

export interface PersistOpts {
  doorId?: string;
  unitName?: string;
  replaceExistingId?: boolean;
  hingeEdge?: number | null;
  swing?: 1 | -1;
  angleDeg?: number;
  wallSurfaceId?: string;
  doorThickness?: number;
  boundarySplitEnabled?: boolean;
  safetyMargin?: number;
  // basemap 의 다중 도어 영속화 — 각 도어의 mesh quad + door-side gaussian splat 자산 메타.
  // 별도로 PNG/PLY 를 MinIO 에 업로드한 후 그 파일명/메타를 doors.json 에 함께 저장.
  doorMesh?: DoorMeshMeta;
  doorSplat?: DoorSplatMeta;
}

export async function persistDoorsToServer(
  uploadId: string,
  corners: Array<PickedCorner | null>,
  opts: PersistOpts = {},
) {
  if (!uploadId.trim()) return;
  const allFilled = corners.every(c => c !== null);
  if (!allFilled) return;
  const door: DoorMeta = {
    id: opts.doorId || PRIMARY_DOOR_ID,
    corners: corners.map(c => [c!.pos[0], c!.pos[1], c!.pos[2]]),
  };
  if (opts.unitName !== undefined) door.unitName = opts.unitName;
  if (opts.hingeEdge !== undefined) door.hingeEdge = opts.hingeEdge;
  if (opts.swing !== undefined) door.swing = opts.swing;
  if (opts.angleDeg !== undefined) door.angleDeg = opts.angleDeg;
  if (opts.wallSurfaceId !== undefined) door.wallSurfaceId = opts.wallSurfaceId;
  if (opts.doorThickness !== undefined) door.doorThickness = opts.doorThickness;
  if (opts.boundarySplitEnabled !== undefined) door.boundarySplitEnabled = opts.boundarySplitEnabled;
  if (opts.safetyMargin !== undefined) door.safetyMargin = opts.safetyMargin;
  if (opts.doorMesh !== undefined) door.doorMesh = opts.doorMesh;
  if (opts.doorSplat !== undefined) door.doorSplat = opts.doorSplat;
  try {
    const existing = await api.get<DoorsJson>(`/uploads/${uploadId}/doors`).catch(() => ({ doors: [] }));
    // 기존 door_1 의 메타는 새 opts 가 없으면 유지 — partial update.
    const prev = (existing.doors ?? []).find(d => d.id === door.id);
    if (prev) {
      if (door.hingeEdge === undefined && prev.hingeEdge !== undefined) door.hingeEdge = prev.hingeEdge;
      if (door.swing === undefined && prev.swing !== undefined) door.swing = prev.swing;
      if (door.angleDeg === undefined && prev.angleDeg !== undefined) door.angleDeg = prev.angleDeg;
      if (door.wallSurfaceId === undefined && prev.wallSurfaceId !== undefined) door.wallSurfaceId = prev.wallSurfaceId;
      if (door.doorThickness === undefined && prev.doorThickness !== undefined) door.doorThickness = prev.doorThickness;
      if (door.boundarySplitEnabled === undefined && prev.boundarySplitEnabled !== undefined) door.boundarySplitEnabled = prev.boundarySplitEnabled;
      if (door.safetyMargin === undefined && prev.safetyMargin !== undefined) door.safetyMargin = prev.safetyMargin;
    }
    const others = opts.replaceExistingId === false
      ? (existing.doors ?? [])
      : (existing.doors ?? []).filter(d => d.id !== door.id);
    await api.put(`/uploads/${uploadId}/doors`, { doors: [door, ...others] });
  } catch (e: any) {
    console.warn('[doors] persist 실패', e);
  }
}

export async function persistEmptyDoorsToServer(uploadId: string) {
  if (!uploadId.trim()) return;
  await api.put(`/uploads/${uploadId}/doors`, { doors: [] });
}

export async function clearDoorsOnServer(uploadId: string) {
  if (!uploadId.trim()) return;
  // door_1 만 제거 (다른 문은 유지).
  try {
    const existing = await api.get<DoorsJson>(`/uploads/${uploadId}/doors`).catch(() => ({ doors: [] }));
    const others = (existing.doors ?? []).filter(d => d.id !== PRIMARY_DOOR_ID);
    await api.put(`/uploads/${uploadId}/doors`, { doors: others });
  } catch (e: any) {
    console.warn('[doors] clear 실패', e);
  }
}
