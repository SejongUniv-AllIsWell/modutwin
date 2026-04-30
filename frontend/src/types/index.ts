// ── Auth ──

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: 'user' | 'admin';
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

// ── Building / Floor / Module ──

export interface Building {
  id: string;
  name: string;
  is_visible: boolean;
  created_at: string;
}

export interface Floor {
  id: string;
  building_id: string;
  floor_number: number;
  is_visible: boolean;
  created_at: string;
}

export interface Module {
  id: string;
  floor_id: string;
  name: string;
  alignment_transform: Record<string, unknown> | null;
  is_visible: boolean;
  created_at: string;
}

export interface ActiveBasemapResponse {
  basemap_id: string;
  floor_id: string;
  building_id: string;
  version: number;
  url: string;
  filename: string;
}

// ── Upload ──

export interface UploadInitRequest {
  filename: string;
  file_size: number;
  content_type: string;
  building_id: string;
  floor_id: string;
  module_id: string;
  ply_target?: 'gsplat' | 'alignment' | 'refined';
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

export interface Upload {
  id: string;
  module_id: string;
  original_filename: string;
  file_size: number;
  status: 'uploaded' | 'processing' | 'completed' | 'failed';
  ply_target: string | null;
  uploaded_at: string;
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
  type: 'progress' | 'task_complete' | 'task_failed' | 'notification' | 'pong';
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
