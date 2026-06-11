'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { wsClient } from '@/lib/ws';
import { Upload, Notification, Task, TaskProgress, WsMessage } from '@/types';
import { useToast } from '@/components/ui/Toast';
import {
  abortLocalUpload,
  clearLocalUploadProgress,
  isActiveLocalUploadProgress,
  type LocalUploadProgress,
  useLocalUploadProgress,
} from '@/lib/upload/localUploadProgress';

const VIEWABLE_EXTENSIONS = new Set(['.ply', '.splat', '.sog']);

function isViewable(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return VIEWABLE_EXTENSIONS.has(ext);
}

// 파이프라인 진행 단계 라벨 — 업로드(MinIO) 상태가 아니라 사용자가 어디까지 진행했는지 표시.
//   failed → 실패
//   basemap → Basemap (관리자가 basemap 으로 등록 완료)
//   has_alignment → 정합 완료 (정합 행렬 저장됨)
//   has_doors_json → 문 꼭짓점 지정 (정합 진행 중)
//   has_refined → 다듬기 완료
//   completed (refined 없음) → 업로드 완료
//   uploaded / processing → 그대로
// basemap 목적 업로드(is_basemap_upload)는 모듈 업로드와 달리 문지정/정합 단계를 거치지 않으므로
//   등록 전엔 '업로드 완료', 등록 후엔 'Basemap' 만 표시한다.
type ProgressStage =
  | 'failed' | 'basemap' | 'aligned' | 'doors' | 'refined'
  | 'uploaded_only' | 'uploaded' | 'processing';

const STAGE_LABEL: Record<ProgressStage, string> = {
  failed:        '실패',
  basemap:       'Basemap',
  aligned:       '정합 완료',
  doors:         '문 꼭짓점 지정',
  refined:       '다듬기 완료',
  uploaded_only: '업로드 완료',
  uploaded:      '업로드됨',
  processing:    '처리 중',
};

const STAGE_COLOR: Record<ProgressStage, string> = {
  failed:        'text-red-400',
  basemap:       'text-cyan-400',
  aligned:       'text-cyan-400',
  doors:         'text-purple-400',
  refined:       'text-cyan-300',
  uploaded_only: 'text-green-400',
  uploaded:      'text-[var(--muted)]',
  processing:    'text-yellow-400',
};

function progressStage(u: { status: string; has_refined?: boolean; has_doors_json?: boolean; has_alignment?: boolean; is_basemap_upload?: boolean; is_basemap_active?: boolean }): ProgressStage {
  if (u.status === 'failed') return 'failed';
  if (u.status === 'processing') return 'processing';
  if (u.status === 'uploaded') return 'uploaded';
  // basemap 목적 업로드: 문지정/정합 단계를 거치지 않는다.
  if (u.is_basemap_upload) {
    // 관리자 승인(=활성화)으로 등록 완료 → 'Basemap', 그 전(제출/대기) → '업로드 완료'.
    // pending Basemap row 도 source_upload 를 갖기 때문에 is_basemap_source 가 아니라 is_basemap_active 로 판단.
    return u.is_basemap_active ? 'basemap' : 'uploaded_only';
  }
  // status === 'completed': 다듬기/정합 진행 단계로 더 세분화.
  if (u.has_alignment) return 'aligned';
  if (u.has_doors_json) return 'doors';
  if (u.has_refined) return 'refined';
  return 'uploaded_only';
}

const WORKER_PROGRESS_POLL_MS = 5000;
const LOCAL_UPLOAD_REFRESH_MS = 3000;

function uploadPercentLabel(progress: LocalUploadProgress | undefined): string | null {
  if (!progress || progress.phase === 'failed' || progress.phase === 'processing') return null;
  return `${Math.round(progress.percent)}%`;
}

function latestTaskByUpload(tasks: Task[]): Record<string, Task> {
  return tasks.reduce<Record<string, Task>>((acc, task) => {
    const current = acc[task.upload_id];
    if (!current || Date.parse(task.created_at) > Date.parse(current.created_at)) {
      acc[task.upload_id] = task;
    }
    return acc;
  }, {});
}

function latestFailedTaskByUpload(tasks: Task[]): Record<string, Task> {
  return tasks.reduce<Record<string, Task>>((acc, task) => {
    if (task.status !== 'failed') return acc;
    const current = acc[task.upload_id];
    if (!current || Date.parse(task.created_at) > Date.parse(current.created_at)) {
      acc[task.upload_id] = task;
    }
    return acc;
  }, {});
}

function workerProgressLabel(progress: TaskProgress | undefined): string | null {
  if (!progress || progress.progress < 0) return null;
  const percent = Math.max(0, Math.min(100, Math.round(progress.progress)));
  return `${percent}%`;
}

function taskStageName(task: Task | undefined): 'COLMAP' | '3DGS' | '정합' | 'SAM3' | null {
  if (!task) return null;
  if (task.task_type === 'colmap_preprocessing') return 'COLMAP';
  if (task.task_type === '3dgs_training') return '3DGS';
  if (task.task_type === 'door_alignment') return '정합';
  if (task.task_type === 'sam3_door_detection') return 'SAM3';
  return null;
}

function failedTaskLabel(task: Task | undefined): string | null {
  const stage = taskStageName(task);
  return stage ? `${stage} 실패` : null;
}

function completedTaskLabel(task: Task | undefined): string | null {
  const stage = taskStageName(task);
  return stage ? `${stage} 완료` : null;
}

function colmapStatusLabel(
  upload: Upload,
  progress: LocalUploadProgress | undefined,
  workerProgress: TaskProgress | undefined,
  latestTask: Task | undefined,
  latestFailedTask: Task | undefined,
): string {
  const activeProgress = progress ? isActiveLocalUploadProgress(progress) : false;
  const percent = uploadPercentLabel(progress);
  const workerLabel = workerProgressLabel(workerProgress);
  const failedTask = latestTask?.status === 'failed'
    ? latestTask
    : upload.status === 'failed'
      ? latestFailedTask
      : undefined;
  const failedLabel = failedTaskLabel(failedTask);
  const latestCompletedLabel = completedTaskLabel(latestTask);

  if (failedTask) return failedLabel ?? '업로드 실패';
  if (progress?.phase === 'failed') return '업로드 실패';
  if (upload.status === 'failed') return failedLabel ?? '업로드 실패';
  if (upload.status === 'completed' && upload.has_gsplat_ply) return '3DGS 완료';
  if (latestTask?.status === 'completed') return latestCompletedLabel ?? '업로드 완료';
  if (upload.status === 'processing' || progress?.phase === 'processing') {
    const stage = taskStageName(latestTask) ?? 'COLMAP';
    const taskPercent = latestTask ? `${Math.max(0, Math.min(100, Math.round(latestTask.progress)))}%` : '0%';
    return `${stage}(${workerLabel ?? taskPercent})`;
  }
  if (upload.status === 'uploaded') {
    if (progress?.phase === 'completing') return activeProgress ? '업로드 완료 처리 중' : '업로드 완료 확인 실패';
    if (progress?.phase === 'uploading') return activeProgress ? `업로드(${percent ?? '0%'})` : '업로드 실패';
    return '업로드 실패';
  }
  return '업로드 완료';
}

function colmapStatusColor(
  upload: Upload,
  progress: LocalUploadProgress | undefined,
  workerProgress: TaskProgress | undefined,
  latestTask: Task | undefined,
  latestFailedTask: Task | undefined,
): string {
  const failedTask = latestTask?.status === 'failed'
    ? latestTask
    : upload.status === 'failed'
      ? latestFailedTask
      : undefined;
  if (failedTask || upload.status === 'failed' || progress?.phase === 'failed') return 'text-red-400';
  if (workerProgress && workerProgress.progress < 0) return 'text-red-400';
  if (upload.status === 'completed' && upload.has_gsplat_ply) return 'text-cyan-300';
  if (latestTask?.status === 'completed') return 'text-cyan-300';
  if (upload.status === 'processing' || progress?.phase === 'processing') return 'text-yellow-400';
  if (upload.status === 'uploaded' && progress?.phase === 'completing' && isActiveLocalUploadProgress(progress)) {
    return 'text-yellow-400';
  }
  if (upload.status === 'uploaded' && progress?.phase === 'uploading' && isActiveLocalUploadProgress(progress)) {
    return 'text-emerald-400';
  }
  if (upload.status === 'uploaded') return 'text-red-400';
  return 'text-emerald-400';
}

interface Props {
  showHeader?: boolean;
}

export default function UserDashboard({ showHeader = true }: Props) {
  const router = useRouter();
  const { show: showToast } = useToast();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workerProgress, setWorkerProgress] = useState<Record<string, TaskProgress>>({});
  const [deleteTarget, setDeleteTarget] = useState<Upload | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [retryingUploadId, setRetryingUploadId] = useState<string | null>(null);
  const localUploadProgress = useLocalUploadProgress();

  const refreshDashboardData = useCallback(async () => {
    const [nextUploads, nextNotifications, nextTasks] = await Promise.all([
      api.get<Upload[]>('/uploads'),
      api.get<Notification[]>('/notifications'),
      api.get<Task[]>('/tasks'),
    ]);
    setUploads(nextUploads);
    setNotifications(nextNotifications);
    setTasks(nextTasks);
  }, []);

  // COLMAP/3DGS 결과는 사용자 PC로 다운로드하지 않고, upload_id만 넘겨 viewer가 서버 URL을 로드한다.
  const handleColmapSelect = (uploadId: string) => {
    router.push(`/viewer?upload_id=${uploadId}`);
  };

  useEffect(() => {
    refreshDashboardData().catch(() => {});

    const unsub = wsClient.subscribe((msg: WsMessage) => {
      if (msg.type === 'task_complete' || msg.type === 'task_failed') {
        refreshDashboardData().catch(() => {});
      }
    });

    return () => { unsub(); };
  }, [refreshDashboardData]);

  useEffect(() => {
    const shouldPoll = Object.values(localUploadProgress).some(progress => (
      progress.phase === 'completing' || progress.phase === 'processing'
    ));
    if (!shouldPoll) return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const [nextUploads, nextTasks] = await Promise.all([
          api.get<Upload[]>('/uploads'),
          api.get<Task[]>('/tasks'),
        ]);
        if (cancelled) return;
        setUploads(nextUploads);
        setTasks(nextTasks);
      } catch {
        // 다음 tick 에 다시 시도.
      }
    };

    refresh();
    const interval = window.setInterval(refresh, LOCAL_UPLOAD_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [localUploadProgress]);

  useEffect(() => {
    for (const upload of uploads) {
      if (upload.ply_target === 'colmap' && upload.status !== 'uploaded') {
        clearLocalUploadProgress(upload.id);
      }
    }
  }, [uploads]);

  useEffect(() => {
    const taskByUpload = latestTaskByUpload(tasks);
    const taskIds = uploads
      .filter(upload => upload.ply_target === 'colmap' && upload.status === 'processing')
      .map(upload => taskByUpload[upload.id]?.id)
      .filter((taskId): taskId is string => !!taskId);

    if (taskIds.length === 0) {
      setWorkerProgress({});
      return;
    }

    let cancelled = false;
    const refreshProgress = async () => {
      const results = await Promise.all(
        taskIds.map(taskId =>
          api.get<TaskProgress>(`/tasks/${taskId}/progress`)
            .then(progress => [taskId, progress] as const)
            .catch(() => null),
        ),
      );
      if (cancelled) return;

      setWorkerProgress(() => {
        const next: Record<string, TaskProgress> = {};
        for (const result of results) {
          if (result) {
            const [taskId, progress] = result;
            next[taskId] = progress;
          }
        }
        return next;
      });
    };

    refreshProgress();
    const interval = window.setInterval(refreshProgress, WORKER_PROGRESS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [uploads, tasks]);

  const taskByUpload = latestTaskByUpload(tasks);
  const failedTaskByUpload = latestFailedTaskByUpload(tasks);

  const markAllRead = async () => {
    await api.post('/notifications/read-all');
    setNotifications([]);
  };

  const deleteUpload = async (target: Upload) => {
    const isHide = !!target.is_basemap_source;
    const targetTaskIds = tasks
      .filter(task => task.upload_id === target.id)
      .map(task => task.id);

    setDeleting(true);
    setDeleteError(null);
    try {
      if (isHide) {
        await api.post(`/uploads/${target.id}/hide`);
      } else {
        abortLocalUpload(target.id);
        const minioUploadId = localUploadProgress[target.id]?.minioUploadId;
        const query = minioUploadId ? `?minio_upload_id=${encodeURIComponent(minioUploadId)}` : '';
        await api.delete(`/uploads/${target.id}${query}`);
      }
      clearLocalUploadProgress(target.id);
      setUploads(prev => prev.filter(u => u.id !== target.id));
      setTasks(prev => prev.filter(task => task.upload_id !== target.id));
      setWorkerProgress(prev => {
        const next = { ...prev };
        for (const taskId of targetTaskIds) delete next[taskId];
        return next;
      });
      setDeleteTarget(null);
    } catch (e: any) {
      const message = e?.message || (isHide ? '업로드 숨김 실패' : '업로드 삭제 실패');
      if (deleteTarget?.id === target.id) {
        setDeleteError(message);
      } else {
        showToast(message, 'error');
      }
    } finally {
      setDeleting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteUpload(deleteTarget);
  };

  const retryUpload = async (target: Upload) => {
    if (retryingUploadId) return;
    setRetryingUploadId(target.id);
    try {
      await api.post(`/uploads/${target.id}/retry`);
      clearLocalUploadProgress(target.id);
      const [nextUploads, nextTasks] = await Promise.all([
        api.get<Upload[]>('/uploads'),
        api.get<Task[]>('/tasks'),
      ]);
      setUploads(nextUploads);
      setTasks(nextTasks);
      setWorkerProgress({});
      showToast('재시도를 시작했습니다.');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`재시도 실패: ${msg}`, 'error');
    } finally {
      setRetryingUploadId(null);
    }
  };

  return (
    <div>
      {showHeader && (
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold">대시보드</h1>
          <div className="flex items-center gap-2">
            <Link href="/viewer" className="bg-[var(--paper)] hover:bg-sky-400/10 border border-[var(--rule)] text-[var(--ink)] text-sm px-4 py-2 rounded">
              뷰어
            </Link>
            <Link href="/upload" className="bg-[var(--accent)] hover:brightness-110 text-[#04131f] text-sm px-4 py-2 rounded">
              업로드
            </Link>
          </div>
        </div>
      )}

      {notifications.length > 0 && (
        <div className="mb-6 bg-[var(--paper)] border border-[var(--rule)] rounded-lg p-4">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-sm font-semibold text-[var(--ink-2)]">알림 ({notifications.length})</h2>
            <button onClick={markAllRead} className="text-xs text-cyan-300 hover:text-cyan-200">모두 읽음</button>
          </div>
          {notifications.slice(0, 5).map(n => (
            <div key={n.id} className="text-sm text-[var(--muted)] py-1 border-b border-[var(--rule)] last:border-0">
              {n.message}
            </div>
          ))}
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-4">업로드 내역</h2>
        {uploads.length === 0 ? (
          <p className="text-[var(--muted)] text-sm">아직 업로드한 파일이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)] text-left border-b border-[var(--rule)]">
                  <th className="py-2 pr-4">파일명</th>
                  <th className="py-2 pr-4">상태</th>
                  <th className="py-2 pr-4">날짜</th>
                  <th className="py-2 pr-4 text-right">작업</th>
                </tr>
              </thead>
              <tbody>
                {uploads.map(u => {
                  const sam = u.sam3_status ?? null;
                  const stage = progressStage(u);
                  const isColmap = u.ply_target === 'colmap';
                  const colmapDone = isColmap && u.status === 'completed' && !!u.has_gsplat_ply;
                  const colmapProcessing = isColmap && u.status === 'processing';
                  const localColmapProgress = isColmap ? localUploadProgress[u.id] : undefined;
                  const colmapTask = isColmap ? taskByUpload[u.id] : undefined;
                  const colmapFailedTask = isColmap ? failedTaskByUpload[u.id] : undefined;
                  const colmapTaskProgress = colmapTask ? workerProgress[colmapTask.id] : undefined;
                  const colmapLocalFailed = localColmapProgress?.phase === 'failed';
                  const colmapUploadPending = isColmap && u.status === 'uploaded' && !colmapLocalFailed;
                  const colmapPipelineStarted = colmapProcessing || localColmapProgress?.phase === 'processing';
                  const colmapFailed = isColmap && u.status === 'failed';
                  const filenameClickable = isViewable(u.original_filename) || colmapDone;
                  const isBasemap = !!u.is_basemap_source;
                  const isBasemapUpload = !!u.is_basemap_upload;
                  // basemap 목적 업로드와 이미 정합 완료된 업로드는 '정합하기' 노출 안 함.
                  const canAlign = !isColmap && !isBasemapUpload && !u.has_alignment && (!!u.has_refined || !!u.has_doors_json);
                  return (
                    <tr key={u.id} className="border-b border-[var(--rule)]/50">
                      <td className="py-3 pr-4">
                        {isColmap && colmapDone ? (
                          <button
                            type="button"
                            onClick={() => handleColmapSelect(u.id)}
                            className="text-cyan-300 hover:underline"
                          >
                            {u.original_filename}
                          </button>
                        ) : filenameClickable ? (
                          <Link
                            href={u.has_refined
                              ? `/viewer?upload_id=${u.id}&mode=align`
                              : `/viewer?upload_id=${u.id}`}
                            className="text-cyan-300 hover:underline"
                          >
                            {u.original_filename}
                          </Link>
                        ) : (
                          <span className="text-[var(--ink-2)]">{u.original_filename}</span>
                        )}
                      </td>
                      <td className={`py-3 pr-4 ${
                        isColmap
                          ? colmapStatusColor(u, localColmapProgress, colmapTaskProgress, colmapTask, colmapFailedTask)
                          : STAGE_COLOR[stage]
                      }`}>
                        {isColmap
                          ? colmapStatusLabel(u, localColmapProgress, colmapTaskProgress, colmapTask, colmapFailedTask)
                          : STAGE_LABEL[stage]}
                      </td>
                      <td className="py-3 pr-4 text-[var(--muted)]">{new Date(u.uploaded_at).toLocaleDateString('ko-KR')}</td>
                      <td className="py-3 pr-4 text-right">
                        {isColmap ? (
                          colmapDone ? (
                            <div className="inline-flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => handleColmapSelect(u.id)}
                                className="inline-block px-3 py-1 rounded bg-[var(--accent)] hover:brightness-110 text-[#04131f] text-xs font-bold"
                                title="서버 결과를 다듬기 단계에서 열기"
                              >
                                뷰어 열기
                              </button>
                              <button
                                type="button"
                                disabled={deleting}
                                onClick={() => setDeleteTarget(u)}
                                aria-label={`${u.original_filename} 업로드와 처리 결과 삭제`}
                                className="w-6 h-6 inline-flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] hover:bg-red-600 rounded text-xs font-bold disabled:opacity-50"
                                title="업로드 파일, COLMAP/3DGS 결과, 관련 DB 데이터 삭제"
                              >
                                X
                              </button>
                            </div>
                          ) : colmapFailed ? (
                            <div className="inline-flex items-center justify-end gap-2">
                              <button
                                type="button"
                                disabled={retryingUploadId === u.id || deleting}
                                onClick={() => { void retryUpload(u); }}
                                className="inline-block px-3 py-1 rounded bg-[var(--accent)] hover:brightness-110 disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] text-[#04131f] text-xs font-bold"
                                title="업로드된 원본 파일로 실패한 단계부터 다시 시도"
                              >
                                {retryingUploadId === u.id ? '시작 중...' : '재시도'}
                              </button>
                              <button
                                type="button"
                                disabled={deleting || retryingUploadId === u.id}
                                onClick={() => { void deleteUpload(u); }}
                                aria-label={`${u.original_filename} 업로드 내역 삭제`}
                                className="w-6 h-6 inline-flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] hover:bg-red-600 rounded text-xs font-bold disabled:opacity-50"
                                title="업로드 내역 삭제"
                              >
                                X
                              </button>
                            </div>
                          ) : colmapUploadPending || colmapLocalFailed ? (
                            <button
                              type="button"
                              disabled={deleting}
                              onClick={() => { void deleteUpload(u); }}
                              aria-label={colmapLocalFailed ? `${u.original_filename} 업로드 내역 삭제` : `${u.original_filename} 업로드 취소`}
                              className="w-6 h-6 inline-flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] hover:bg-red-600 rounded text-xs font-bold disabled:opacity-50"
                              title={colmapLocalFailed ? '업로드 내역 삭제' : '업로드 취소'}
                            >
                              X
                            </button>
                          ) : colmapPipelineStarted ? (
                            <button
                              type="button"
                              disabled={deleting}
                              onClick={() => { void deleteUpload(u); }}
                              aria-label={`${u.original_filename} 처리 취소 및 삭제`}
                              className="w-6 h-6 inline-flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] hover:bg-red-600 rounded text-xs font-bold disabled:opacity-50"
                              title="GPU worker 작업을 취소하고 업로드 파일과 DB 정보를 삭제"
                            >
                              X
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={deleting}
                              onClick={() => { void deleteUpload(u); }}
                              aria-label={`${u.original_filename} 업로드 내역 삭제`}
                              className="w-6 h-6 inline-flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] hover:bg-red-600 rounded text-xs font-bold disabled:opacity-50"
                              title="업로드 내역 삭제"
                            >
                              X
                            </button>
                          )
                        ) : (
                          <div className="inline-flex items-center justify-end gap-2">
                            {canAlign && (
                              <Link
                                href={`/viewer?upload_id=${u.id}&mode=align`}
                                className="inline-block px-3 py-1 rounded bg-[var(--accent)] hover:brightness-110 text-[#04131f] text-xs font-bold"
                                title={sam === 'done' ? 'SAM3 결과로 정합 시작' : '수동으로 문 꼭짓점을 지정해 정합'}
                              >
                                정합하기
                              </Link>
                            )}
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(u)}
                              aria-label={
                                isBasemap
                                  ? `${u.original_filename} 업로드 내역에서 숨김`
                                  : `${u.original_filename} 삭제`
                              }
                              title={
                                isBasemap
                                  ? '업로드 내역에서만 숨김 (basemap 원본은 보존)'
                                  : `${u.original_filename} 삭제`
                              }
                              className="w-6 h-6 inline-flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] hover:bg-red-600 rounded"
                            >
                              X
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deleteTarget && (() => {
        const isHide = !!deleteTarget.is_basemap_source;
        const isProcessing = deleteTarget.status === 'processing';
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
            <div className="w-full max-w-md rounded-lg border border-[var(--rule)] bg-[var(--paper)] p-5 shadow-xl">
              <h3 className="text-base font-semibold text-[var(--ink)]">
                {isHide ? '업로드 내역에서 숨김' : '업로드 삭제'}
              </h3>
              <p className={`mt-3 text-sm ${isHide ? 'text-[var(--ink-2)]' : 'text-red-300'}`}>
                {isHide
                  ? 'basemap 원본 파일과 DB 는 그대로 보존되며, 내 업로드 내역에서만 숨김 처리됩니다.'
                  : isProcessing
                    ? '처리 중인 GPU worker 작업을 취소하고, 업로드한 파일과 관련된 모든 데이터가 삭제됩니다.'
                    : '삭제 시 업로드한 파일과 관련된 모든 데이터가 삭제됩니다.'}
              </p>
              <p className="mt-2 text-sm text-[var(--ink-2)] truncate">
                대상: {deleteTarget.original_filename}
              </p>
              {deleteError && (
                <p className="mt-2 text-xs text-red-400">{deleteError}</p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className={`rounded px-4 py-2 text-sm font-semibold text-[var(--ink)] disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] ${
                    isHide ? 'bg-[var(--accent)] hover:brightness-110 text-[#04131f]' : 'bg-red-600 hover:bg-red-700'
                  }`}
                >
                  {deleting ? (isHide ? '숨김 처리 중...' : '삭제 중...') : (isHide ? '숨김' : '삭제')}
                </button>
                <button
                  type="button"
                  onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(null); } }}
                  disabled={deleting}
                  className="rounded bg-[var(--paper)] border border-[var(--rule)] px-4 py-2 text-sm text-[var(--ink)] hover:bg-sky-400/10 disabled:opacity-50"
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
