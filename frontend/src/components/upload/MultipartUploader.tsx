'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Building, Floor, Module, UploadInitResponse } from '@/types';
import { PENDING_LOCAL_PLY_KEY, type PendingLocalPlyPayload } from '@/lib/upload/pendingLocalPly';
import { Button } from '@/components/ui/Button';

const SCENE_3D_EXTENSIONS = ['.ply', '.splat', '.sog'];

function fileExt(filename: string): string {
  return `.${filename.split('.').pop()?.toLowerCase() ?? ''}`;
}

function isScene3DFile(filename: string): boolean {
  return SCENE_3D_EXTENSIONS.includes(fileExt(filename));
}

function isZipFile(file: File): boolean {
  return fileExt(file.name) === '.zip';
}

const EXT_TO_MIME: Record<string, string> = {
  ply: 'application/octet-stream',
  splat: 'application/octet-stream',
  sog: 'application/octet-stream',
  zip: 'application/zip',
};

function resolveContentType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

function isAcceptedFile(file: File): boolean {
  return isScene3DFile(file.name) || isZipFile(file);
}

export interface UploaderFixedContext {
  purpose: string;
  building_id: string;
  building_name: string;
  floor_id: string;
  floor_number: number;
  module_name: string;
  place_id?: string;
  address_name?: string;
  road_address_name?: string;
  lat?: string;
  lng?: string;
}

export default function MultipartUploader({
  fixedContext,
}: {
  fixedContext: UploaderFixedContext;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState<'error' | 'info' | null>(null);

  // .zip 분기 — 같은 building/floor/module 로 server upload 진행 후 /dashboard 이동.
  // basemap purpose 에서는 register-local-basemap 흐름이 필요해 zip(COLMAP) 미지원.
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

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (submitting) return;
    const dropped = e.dataTransfer.files?.[0];
    if (!dropped) return;
    if (!isAcceptedFile(dropped)) {
      setMessage('.ply / .splat / .sog 또는 사진 묶음(.zip) 파일만 업로드할 수 있습니다.');
      setMessageKind('error');
      return;
    }
    setFile(dropped);
    setMessage('');
    setMessageKind(null);
  }, [submitting]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!submitting) setIsDragging(true);
  }, [submitting]);

  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    if (f && !isAcceptedFile(f)) {
      setMessage('.ply / .splat / .sog 또는 사진 묶음(.zip) 파일만 업로드할 수 있습니다.');
      setMessageKind('error');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setFile(f);
    setMessage('');
    setMessageKind(null);
  };

  const handleConfirm = async () => {
    if (!file) return;
    setSubmitting(true);
    setMessage('');
    setMessageKind(null);

    try {
      // 분기 1: .ply / .splat / .sog → 업로드 없이 blob URL 로 viewer 이동 (다듬기 시작)
      if (isScene3DFile(file.name)) {
        const blobUrl = URL.createObjectURL(file);
        const payload: PendingLocalPlyPayload = {
          blobUrl,
          filename: file.name,
          fileSize: file.size,
          purpose: fixedContext.purpose,
          building_id: fixedContext.building_id || undefined,
          building_name: fixedContext.building_name,
          floor_id: fixedContext.floor_id || undefined,
          floor_number: fixedContext.floor_number,
          module_name: fixedContext.module_name,
          place_id: fixedContext.place_id || undefined,
          address_name: fixedContext.address_name || undefined,
          road_address_name: fixedContext.road_address_name || undefined,
          lat: fixedContext.lat ? Number(fixedContext.lat) : undefined,
          lng: fixedContext.lng ? Number(fixedContext.lng) : undefined,
          createdAt: Date.now(),
        };
        try {
          sessionStorage.setItem(PENDING_LOCAL_PLY_KEY, JSON.stringify(payload));
        } catch {
          // sessionStorage 가 막혀있어도 blob URL 은 같은 document 안에서 유효하므로 그대로 진행.
        }
        router.push('/viewer');
        return;
      }

      // 분기 2: .zip → COLMAP 파이프라인. 업로드 시작과 동시에 /dashboard 로 이동.
      if (isZipFile(file)) {
        if (fixedContext.purpose === 'basemap') {
          setMessage('Basemap 등록은 .ply / .splat / .sog 파일만 지원합니다.');
          setMessageKind('error');
          setSubmitting(false);
          return;
        }
        // basemap 이면 module_name 으로 별도 모듈을 생성하지 않도록 막아야 하지만, 현 흐름에서
        // basemap+zip 조합은 위에서 차단했으므로 이하 module purpose 만 도달.
        const buildingId = await findOrCreateBuilding();
        const floorId = await findOrCreateFloor(buildingId);
        const moduleId = await findOrCreateModule(floorId);

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

        // 업로드는 백그라운드로 계속 진행 — 페이지 이동 후에도 fetch 는 살아 있음.
        runColmapUpload({
          file,
          upload_id,
          minio_upload_id,
          presigned_urls,
          part_size,
        }).catch(() => {
          // dashboard 에서 status='failed' 로 표시됨.
        });

        router.push('/dashboard');
        return;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessage(msg || '확인 처리에 실패했습니다.');
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
              {isZipFile(file) && (
                <p className="text-xs text-emerald-400 mt-1">COLMAP 사진 묶음 — 백그라운드 학습 후 마이페이지에서 결과 확인</p>
              )}
              {isScene3DFile(file.name) && (
                <p className="text-xs text-blue-300 mt-1">불러온 PLY 로 곧바로 다듬기 단계가 시작됩니다</p>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-[var(--ink-2)]">파일을 끌어다 놓거나 클릭하여 선택</p>
              <p className="text-xs text-[var(--muted)] mt-1">.ply / .splat / .sog</p>
              <p className="text-xs text-emerald-600 mt-0.5">또는 사진 묶음 .zip (COLMAP)</p>
            </>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".ply,.splat,.sog,.zip"
          onChange={handleFileChange}
          className="hidden"
          disabled={submitting}
        />
      </div>

      {message && (
        <p className={`text-sm ${messageKind === 'error' ? 'text-red-400' : 'text-yellow-400'}`}>
          {message}
        </p>
      )}

      <Button
        onClick={handleConfirm}
        disabled={submitting || !file}
        className="w-full"
      >
        {submitting ? '처리 중...' : '확인'}
      </Button>
    </div>
  );
}

// 백그라운드에서 multipart 업로드를 계속 진행. router.push 직후에도 fetch promise 는 살아남는다.
// 실패해도 사용자는 /dashboard 에서 상태(=failed) 로 확인 가능.
async function runColmapUpload(params: {
  file: File;
  upload_id: string;
  minio_upload_id: string;
  presigned_urls: string[];
  part_size: number;
}) {
  const { file, upload_id, minio_upload_id, presigned_urls, part_size } = params;
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
