'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'modutwin:local-upload-progress:v1';
const EVENT_NAME = 'modutwin:local-upload-progress';
const ACTIVE_STALE_MS = 10 * 60 * 1000;

export type LocalUploadPhase = 'uploading' | 'completing' | 'processing' | 'failed';

export interface LocalUploadProgress {
  uploadId: string;
  filename: string;
  minioUploadId?: string;
  completedParts: number;
  totalParts: number;
  percent: number;
  phase: LocalUploadPhase;
  updatedAt: number;
  error?: string;
}

type ProgressMap = Record<string, LocalUploadProgress>;

let beforeUnloadGuardInstalled = false;
const activeUploadControllers = new Map<string, AbortController>();

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function normalizeProgress(raw: unknown): LocalUploadProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<LocalUploadProgress>;
  if (!item.uploadId || !item.filename || !item.totalParts) return null;
  const totalParts = Math.max(1, Number(item.totalParts) || 1);
  const completedParts = Math.max(0, Math.min(totalParts, Number(item.completedParts) || 0));
  const phase: LocalUploadPhase =
    item.phase === 'completing' || item.phase === 'processing' || item.phase === 'failed'
      ? item.phase
      : 'uploading';

  return {
    uploadId: item.uploadId,
    filename: item.filename,
    ...(item.minioUploadId ? { minioUploadId: String(item.minioUploadId) } : {}),
    completedParts,
    totalParts,
    percent: clampPercent(Number(item.percent) || (completedParts / totalParts) * 100),
    phase,
    updatedAt: Number(item.updatedAt) || Date.now(),
    ...(item.error ? { error: String(item.error) } : {}),
  };
}

export function readLocalUploadProgress(): ProgressMap {
  if (!canUseLocalStorage()) return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const result: ProgressMap = {};
    for (const [uploadId, raw] of Object.entries(parsed)) {
      const normalized = normalizeProgress(raw);
      if (normalized) result[uploadId] = normalized;
    }
    return result;
  } catch {
    return {};
  }
}

function writeLocalUploadProgress(progress: ProgressMap): void {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    window.dispatchEvent(new Event(EVENT_NAME));
  } catch {
    // 진행률 저장 실패는 업로드 자체를 막지 않는다.
  }
}

function updateLocalUploadProgress(
  uploadId: string,
  updater: (current: LocalUploadProgress | null) => LocalUploadProgress | null,
): void {
  const progress = readLocalUploadProgress();
  const next = updater(progress[uploadId] ?? null);
  if (next) progress[uploadId] = next;
  else delete progress[uploadId];
  writeLocalUploadProgress(progress);
}

export function isActiveLocalUploadProgress(item: LocalUploadProgress, now = Date.now()): boolean {
  if (item.phase !== 'uploading' && item.phase !== 'completing') return false;
  return now - item.updatedAt <= ACTIVE_STALE_MS;
}

function hasActiveLocalUploads(): boolean {
  const now = Date.now();
  return Object.values(readLocalUploadProgress()).some(item => isActiveLocalUploadProgress(item, now));
}

function beforeUnloadHandler(event: BeforeUnloadEvent): string | void {
  if (!hasActiveLocalUploads()) return;
  event.preventDefault();
  event.returnValue = '';
  return '';
}

export function installLocalUploadBeforeUnloadGuard(): void {
  if (typeof window === 'undefined' || beforeUnloadGuardInstalled) return;
  window.addEventListener('beforeunload', beforeUnloadHandler);
  beforeUnloadGuardInstalled = true;
}

export function startLocalUploadProgress(params: {
  uploadId: string;
  filename: string;
  minioUploadId?: string;
  totalParts: number;
}): void {
  installLocalUploadBeforeUnloadGuard();
  const totalParts = Math.max(1, params.totalParts);
  updateLocalUploadProgress(params.uploadId, () => ({
    uploadId: params.uploadId,
    filename: params.filename,
    ...(params.minioUploadId ? { minioUploadId: params.minioUploadId } : {}),
    completedParts: 0,
    totalParts,
    percent: 0,
    phase: 'uploading',
    updatedAt: Date.now(),
  }));
}

export function setLocalUploadPartProgress(uploadId: string, completedParts: number, totalParts: number): void {
  installLocalUploadBeforeUnloadGuard();
  updateLocalUploadProgress(uploadId, current => {
    if (!current) return null;
    const total = Math.max(1, totalParts || current.totalParts);
    const completed = Math.max(0, Math.min(total, completedParts));
    return {
      ...current,
      completedParts: completed,
      totalParts: total,
      percent: clampPercent((completed / total) * 100),
      phase: 'uploading',
      updatedAt: Date.now(),
      error: undefined,
    };
  });
}

export function markLocalUploadCompleting(uploadId: string): void {
  updateLocalUploadProgress(uploadId, current => (
    current
      ? { ...current, completedParts: current.totalParts, percent: 100, phase: 'completing', updatedAt: Date.now() }
      : null
  ));
}

export function markLocalUploadProcessing(uploadId: string): void {
  updateLocalUploadProgress(uploadId, current => (
    current
      ? { ...current, completedParts: current.totalParts, percent: 100, phase: 'processing', updatedAt: Date.now() }
      : null
  ));
}

export function markLocalUploadFailed(uploadId: string, error: unknown): void {
  updateLocalUploadProgress(uploadId, current => (
    current
      ? {
          ...current,
          phase: 'failed',
          updatedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }
      : null
  ));
}

export function clearLocalUploadProgress(uploadId: string): void {
  updateLocalUploadProgress(uploadId, () => null);
}

export function createLocalUploadAbortController(uploadId: string): AbortController {
  abortLocalUpload(uploadId);
  const controller = new AbortController();
  activeUploadControllers.set(uploadId, controller);
  return controller;
}

export function releaseLocalUploadAbortController(uploadId: string, controller: AbortController): void {
  if (activeUploadControllers.get(uploadId) === controller) {
    activeUploadControllers.delete(uploadId);
  }
}

export function abortLocalUpload(uploadId: string): boolean {
  const controller = activeUploadControllers.get(uploadId);
  if (!controller) return false;
  controller.abort();
  activeUploadControllers.delete(uploadId);
  return true;
}

export function useLocalUploadProgress(): ProgressMap {
  const [progress, setProgress] = useState<ProgressMap>({});

  useEffect(() => {
    installLocalUploadBeforeUnloadGuard();
    const refresh = () => setProgress(readLocalUploadProgress());
    refresh();

    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) refresh();
    };
    window.addEventListener(EVENT_NAME, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return progress;
}
