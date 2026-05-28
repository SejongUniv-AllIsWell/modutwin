'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Building, Floor, Module, UploadInitResponse } from '@/types';
import { Button } from '@/components/ui/Button';
import type { UploaderFixedContext } from './MultipartUploader';

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

function fileExt(filename: string): string {
  return `.${filename.split('.').pop()?.toLowerCase() ?? ''}`;
}

const EXT_TO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  zip: 'application/zip',
};

function resolveContentType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

type UploadKind = 'video' | 'zip';

/**
 * 영상 / 사진묶음(zip) 을 받아 COLMAP 전처리 파이프라인으로 보내는 등록 업로더.
 *
 * - 두 종류 모두 ply_target='colmap' 로 init → multipart 업로드 → /dashboard.
 *   (워커 FFmpegModule 이 확장자로 zip 해제 / 영상 프레임추출 을 분기 처리.)
 * - basemap 목적이면 숨김 '__basemap__' 모듈에 묶고, module 목적이면 실제 모듈을 만든다.
 * - 업로드는 백그라운드로 계속 진행 — 페이지 이동 후에도 fetch 는 살아 있음.
 */
export default function ColmapRegisterUploader({
  fixedContext,
  kind,
}: {
  fixedContext: UploaderFixedContext;
  kind: UploadKind;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState<'error' | 'info' | null>(null);

  const accept = kind === 'video' ? VIDEO_EXTENSIONS.join(',') : '.zip';
  const isAccepted = (f: File): boolean =>
    kind === 'video' ? VIDEO_EXTENSIONS.includes(fileExt(f.name)) : fileExt(f.name) === '.zip';
  const rejectMsg =
    kind === 'video'
      ? '영상 파일(.mp4 / .mov / .avi / .mkv / .webm)만 업로드할 수 있습니다.'
      : '사진 묶음(.zip) 파일만 업로드할 수 있습니다.';
  const hintText = kind === 'video' ? '.mp4 / .mov / .avi / .mkv / .webm' : '.zip (사진 묶음)';

  const findOrCreateBuilding = async (): Promise<string> => {
    if (fixedContext.building_id) return fixedContext.building_id;
    const b = await api.post<Building>('/buildings', {
      name: fixedContext.building_name,
      ...(fixedContext.place_id ? { kakao_place_id: fixedContext.place_id } : {}),
      ...(fixedContext.address_name ? { address_name: fixedContext.address_name } : {}),
      ...(fixedContext.road_address_name ? { road_address_name: fixedContext.road_address_name } : {}),
      ...(fixedContext.lat ? { latitude: Number(fixedContext.lat) } : {}),
      ...(fixedContext.lng ? { longitude: Number(fixedContext.lng) } : {}),
    });
    return b.id;
  };

  const findOrCreateFloor = async (buildingId: string): Promise<string> => {
    if (fixedContext.floor_id) return fixedContext.floor_id;
    const list = await api.get<Floor[]>(`/buildings/${buildingId}/floors`);
    const existing = list.find((f) => f.floor_number === fixedContext.floor_number);
    if (existing) return existing.id;
    const f = await api.post<Floor>(`/buildings/${buildingId}/floors`, { floor_number: fixedContext.floor_number });
    return f.id;
  };

  const findOrCreateModule = async (floorId: string): Promise<string> => {
    const list = await api.get<Module[]>(`/floors/${floorId}/modules`);
    const existing = list.find((m) => m.name === fixedContext.module_name);
    if (existing) return existing.id;
    const m = await api.post<Module>(`/floors/${floorId}/modules`, { name: fixedContext.module_name });
    return m.id;
  };

  // basemap 목적: 숨김 '__basemap__' 모듈을 확보해 일반 모듈/통계 오염을 막는다.
  const ensureBasemapModule = async (buildingId: string, floorId: string): Promise<string> => {
    const res = await api.post<{ module_id: string }>('/uploads/ensure-basemap-module', {
      building_id: buildingId,
      floor_id: floorId,
    });
    return res.module_id;
  };

  const acceptFile = (f: File | null) => {
    if (!f) return;
    if (!isAccepted(f)) {
      setMessage(rejectMsg);
      setMessageKind('error');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setFile(f);
    setMessage('');
    setMessageKind(null);
  };

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      if (submitting) return;
      acceptFile(e.dataTransfer.files?.[0] ?? null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [submitting],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (!submitting) setIsDragging(true);
    },
    [submitting],
  );

  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0] ?? null);
  };

  const handleConfirm = async () => {
    if (!file) return;
    setSubmitting(true);
    setMessage('');
    setMessageKind(null);

    try {
      const buildingId = await findOrCreateBuilding();
      const floorId = await findOrCreateFloor(buildingId);
      const moduleId =
        fixedContext.purpose === 'basemap'
          ? await ensureBasemapModule(buildingId, floorId)
          : await findOrCreateModule(floorId);

      const initRes = await api.post<UploadInitResponse>('/uploads/init', {
        filename: file.name,
        file_size: file.size,
        content_type: resolveContentType(file),
        building_id: buildingId,
        floor_id: floorId,
        module_id: moduleId,
        ply_target: 'colmap',
      });

      const { upload_id, minio_upload_id, presigned_urls, part_size } = initRes;

      // 백그라운드 업로드 — router.push 직후에도 fetch promise 는 살아남는다.
      runColmapUpload({ file, upload_id, minio_upload_id, presigned_urls, part_size }).catch(() => {
        // dashboard 에서 status='failed' 로 표시됨.
      });

      router.push('/dashboard');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessage(msg || '업로드 처리에 실패했습니다.');
      setMessageKind('error');
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <div>
        <label className="block text-sm text-[var(--muted)] mb-2">파일</label>
        <div
          onClick={() => !submitting && fileRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={`flex flex-col items-center justify-center w-full h-40 rounded-lg border-2 border-dashed cursor-pointer transition-colors
            ${submitting ? 'cursor-not-allowed opacity-50' : ''}
            ${isDragging ? 'border-blue-400 bg-blue-950' : 'border-[var(--rule)] bg-[var(--bg-soft)] hover:border-blue-500'}`}
        >
          <svg className="w-8 h-8 mb-2 text-[var(--muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          {file ? (
            <div className="text-center px-4">
              <p className="text-sm text-blue-400 font-medium truncate max-w-full">{file.name}</p>
              <p className="text-xs text-emerald-400 mt-1">
                업로드 후 백그라운드에서 COLMAP·3DGS 처리 — 마이페이지에서 결과 확인
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-[var(--ink-2)]">파일을 끌어다 놓거나 클릭하여 선택</p>
              <p className="text-xs text-[var(--muted)] mt-1">{hintText}</p>
            </>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          onChange={handleFileChange}
          className="hidden"
          disabled={submitting}
        />
      </div>

      {message && (
        <p className={`text-sm ${messageKind === 'error' ? 'text-red-400' : 'text-yellow-400'}`}>{message}</p>
      )}

      <Button onClick={handleConfirm} disabled={submitting || !file} className="w-full">
        {submitting ? '처리 중...' : '확인'}
      </Button>
    </div>
  );
}

// 백그라운드에서 multipart 업로드를 계속 진행. router.push 직후에도 fetch promise 는 살아남는다.
async function runColmapUpload(params: {
  file: File;
  upload_id: string;
  minio_upload_id: string;
  presigned_urls: string[];
  part_size: number;
}) {
  const { file, presigned_urls, part_size, upload_id, minio_upload_id } = params;
  const parts: { part_number: number; etag: string }[] = [];
  for (let i = 0; i < presigned_urls.length; i++) {
    const start = i * part_size;
    const end = Math.min(start + part_size, file.size);
    const chunk = file.slice(start, end);
    const res = await fetch(presigned_urls[i], { method: 'PUT', body: chunk });
    if (!res.ok) throw new Error(`part ${i + 1} upload failed`);
    const etag = res.headers.get('etag')?.replace(/"/g, '') || '';
    parts.push({ part_number: i + 1, etag });
  }
  await api.post('/uploads/complete', { upload_id, minio_upload_id, parts });
}
