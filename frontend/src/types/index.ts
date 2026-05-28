// ── Auth ──

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: 'user' | 'admin';
  created_at: string;
}

// ── Building / Floor / Module ──

export interface Building {
  id: string;
  name: string;
  is_visible: boolean;
  is_confirmed?: boolean;
  kakao_place_id?: string | null;
  address_name?: string | null;
  road_address_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  created_at: string;
}

export interface BuildingListItem extends Building {
  floor_count: number;
}

export interface Floor {
  id: string;
  building_id: string;
  floor_number: number;
  is_visible: boolean;
  is_confirmed?: boolean;
  created_at: string;
}

export interface Module {
  id: string;
  floor_id: string;
  user_id: string;
  name: string;
  alignment_transform: Record<string, unknown> | null;
  is_visible: boolean;
  is_confirmed?: boolean;
  created_at: string;
}

export interface FloorOverviewManifestEntry {
  floor_id: string;
  floor_number: number;
  overview_dirty: boolean;
  overview_version: string | null;
  topdown_url: string | null;
  meta_url: string | null;
  module_count: number;
  has_active_basemap: boolean;
  has_pending_basemap?: boolean;
}

export interface FloorOverviewManifest {
  building_id: string;
  building_name: string;
  building_is_confirmed?: boolean;
  generated_at: string;
  floors: FloorOverviewManifestEntry[];
}

export interface FloorDetailBasemapEntry {
  id: string;
  version: number;
  source_upload_id: string | null;
  url: string | null;
  filename: string;
}

export interface FloorDetailModuleEntry {
  id: string;
  name: string;
  user_id: string;
  uploader_name: string | null;
  alignment_transform: Record<string, unknown> | null;
  is_visible: boolean;
  version: string | null;
  url: string | null;
  source_upload_id: string | null;
}

export interface FloorDetailManifest {
  building_id: string;
  building_name: string;
  floor_id: string;
  floor_number: number;
  basemap: FloorDetailBasemapEntry | null;
  /** 활성 basemap 이 없을 때 pending basemap (관리자 승인 대기) 존재 여부. */
  basemap_pending_approval?: boolean;
  modules: FloorDetailModuleEntry[];
}

export interface ActiveBasemapResponse {
  basemap_id: string;
  floor_id: string;
  building_id: string;
  version: number;
  url: string;
  filename: string;
  source_upload_id: string | null;
}

export interface MetadataModuleOption {
  id: string;
  name: string;
}

export interface MetadataFloorOption {
  id: string;
  building_id: string;
  floor_number: number;
  modules: MetadataModuleOption[];
}

export interface BuildingMetadataOptions {
  id: string;
  name: string;
  floors: MetadataFloorOption[];
}

// ── Upload ──

export interface UploadInitRequest {
  filename: string;
  file_size: number;
  content_type: string;
  building_id: string;
  floor_id: string;
  module_id: string;
  ply_target?: 'gsplat' | 'alignment' | 'refined' | 'colmap';
}

export interface UploadInitResponse {
  upload_id: string;
  minio_upload_id: string;
  presigned_urls: string[];
  part_size: number;
  part_count: number;
}

export interface UploadCompleteRequest {
  upload_id: string;
  minio_upload_id: string;
  parts: { part_number: number; etag: string }[];
}

export type Sam3Status = 'pending' | 'running' | 'done' | 'failed';

export interface Upload {
  id: string;
  module_id: string;
  original_filename: string;
  file_size: number;
  status: 'uploaded' | 'processing' | 'completed' | 'failed';
  ply_target: string | null;
  uploaded_at: string;
  // SAM3 자동 문 추출 + 정합 파이프라인 파생 플래그.
  sam3_status?: Sam3Status | null;
  sam3_prompt?: string | null;
  has_refined?: boolean;
  has_doors_json?: boolean;
  has_alignment?: boolean;
  has_gsplat_ply?: boolean;
  is_basemap_source?: boolean;
  is_basemap_upload?: boolean;
}

// ── Task ──

export interface Task {
  id: string;
  upload_id: string;
  task_type: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface TaskProgress {
  task_id: string;
  progress: number;
  module: string;
  status: string;
}

// ── Scene ──

export interface Scene {
  id: string;
  module_id: string;
  is_aligned: boolean;
  created_at: string;
  sog_url?: string;
}

// ── Notification ──

export interface Notification {
  id: number;
  message: string;
  type: string;
  related_task_id: string | null;
  is_read: boolean;
  created_at: string;
}

// ── WebSocket ──

export interface WsMessage {
  type:
    | 'progress'
    | 'task_complete'
    | 'task_failed'
    | 'notification'
    | 'ping'
    | 'pong'
    | 'floor.overview_ready'
    | 'module.sog_ready';
  task_id?: string;
  progress?: number;
  module?: string;
  message?: string;
  notification_type?: string;
}

// ── Door Position ──

export interface DoorPosition {
  module_door_indices: number[];
  basemap_door_indices?: number[];
}
