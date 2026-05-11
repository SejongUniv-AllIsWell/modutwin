export const UNDO_STACK_LIMIT = 3;

export type ToolMode = 'none' | 'translate' | 'rotate';
export type RefineMode = 'plane' | 'brush' | 'bbox' | 'rect' | 'transparent';
export type PaintMode = 'union' | 'intersect' | 'diff';
export type SelectSubMode = 'brush' | 'bbox' | 'rect';

export const SELECT_SUB_MODES: ReadonlyArray<SelectSubMode> = ['brush', 'bbox', 'rect'];
export const isSelectMode = (m: RefineMode): m is SelectSubMode => (SELECT_SUB_MODES as readonly string[]).includes(m);

export interface SaveMetadata {
  building_id: string;
  floor_id: string;
  module_id: string;
  building_name?: string;
  floor_number?: number;
  module_name?: string;
  /** SAM3 프롬프트 팝업의 자유 텍스트 (현재는 메타데이터 모달 외부에서 별도 수집). */
  sam_prompt?: string;
  /** 로컬 파일에서 시작했을 때 register-local 로 새로 생성된 upload_id. */
  upload_id?: string;
}

export interface RefineToolOptions {
  // false 이면 캔버스 입력/시각화 핸들러가 다른 단계에 영향을 주지 않는다.
  active?: boolean;
  uploadId?: string;
  // 다듬기가 베이스로 삼는 원본 PLY URL — ensureOriginalScene 에서 fetch&parse.
  currentUrl?: string;
  // resetAll 에서 새 URL로 SplatViewerCore in-place reload.
  reloadWithUrl?: (url: string) => void;
  // 사용자에게 보여주는 파일명 (이미 'refined_' prefix 가 붙어있을 수도 있음 — 이중 prefix 방지용으로 strip).
  // 저장 시 MinIO key 의 파일명에 사용: `refined_<원본>.ply`.
  originalFilename?: string;
  // 저장 성공 후 postSaveModal '예' 선택 시 호출. UnifiedSplatEditor 내부에서 mode='align' 으로 전환.
  // 미지정이면 '예' 버튼은 모달만 닫고 아무 일도 안 함.
  onSwitchToAlign?: () => void;
  // 저장 클릭 시 호출 — 외부에서 메타데이터 입력 모달을 띄우고 결과 반환.
  // 항상 호출되며, 받은 building/floor/module 로 새 upload 를 등록한 뒤 PLY+sidecar 를 그 위에 PUT.
  // reject 되면 저장 흐름 취소.
  onRequestMetadata?: () => Promise<SaveMetadata>;
  // 백엔드가 서빙한 PLY variant. 'refined' 면 메모리 PLY 좌표가 이미 A'+Y baked 이므로
  // applyEntityRotation 이 추가 회전을 적용하면 회전 누적이 되어 mesh 와 frame 어긋남.
  // 이 값을 보고 분기해 누적 차단.
  servedVariant?: 'original' | 'refined' | null;
}

export const ALL_SURFACES = ['ceiling', 'floor', 'w1a', 'w1b', 'w2a', 'w2b'] as const;
export type Surface = typeof ALL_SURFACES[number];
export const CF_SURFACES: Surface[] = ['ceiling', 'floor'];
export const WALL_SURFACES: Surface[] = ['w1a', 'w1b', 'w2a', 'w2b'];

export type OpRecord =
  | { type: 'rotation'; prevRotation: { rotX: number; rotZ: number } }
  | { type: 'flatten'; prevMask: Uint8Array | null; prevActive: boolean }
  | { type: 'floater'; prevMask: Uint8Array | null; prevActive: boolean }
  | { type: 'clipping'; prevSnapshot: Array<{ idx: number; s0: number; s1: number; s2: number }>; prevActive: boolean }
  | { type: 'wallMesh'; prevEntities: any[]; prevActive: boolean };
