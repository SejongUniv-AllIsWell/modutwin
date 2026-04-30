'use client';

import { useRef, useState, useCallback, useEffect, useMemo, Suspense, lazy } from 'react';
import SplatViewerCore, { SplatViewerCoreRef, SplatData } from './SplatViewerCore';
import ViewerSidebar from './ViewerSidebar';
import LayerPanel from './LayerPanel';
import MetadataPickerModal, { MetadataResult } from './MetadataPickerModal';
import { useGaussianSelector } from './tools/useGaussianSelector';
import { useDoorAnimation } from './tools/useDoorAnimation';
import { usePivotEditor } from './tools/usePivotEditor';
import { useTransformTool } from './tools/useTransformTool';
import { useRefineTool } from './tools/useRefineTool';
import { useAdditionalGsplats, AdditionalGsplatSource } from './tools/useAdditionalGsplats';
import { api } from '@/lib/api';
import { ActiveBasemapResponse, UploadInitResponse } from '@/types';

const DoorAlignModal = lazy(() => import('./tools/DoorAlignModal'));

export type EditorMode = 'refine' | 'align' | null;

const SCENE_3D_EXTS = ['ply', 'splat', 'sog'];

interface Props {
  /** 서버 진입 시 (대시보드에서 업로드 클릭 → /viewer?upload_id=X). */
  initialSogUrl?: string | null;
  initialUploadId?: string;
  initialDisplayName?: string;
  initialMode?: EditorMode;
}

export default function UnifiedSplatEditor({
  initialSogUrl = null,
  initialUploadId,
  initialDisplayName,
  initialMode = null,
}: Props) {
  const coreRef = useRef<SplatViewerCoreRef>(null);

  // ── 메인 splat 상태 ──
  // currentUrl만 바뀌어도 SplatViewerCore가 entity만 in-place 교체하므로 reloadKey 같은
  // 강제 remount 트리거는 더 이상 필요 없음 (앱/카메라/추가 레이어 모두 유지).
  const [currentUrl, setCurrentUrl] = useState<string | null>(initialSogUrl ?? null);
  const [uploadId, setUploadId] = useState<string | undefined>(initialUploadId);
  const [displayName, setDisplayName] = useState<string | null>(initialDisplayName ?? null);
  const [source, setSource] = useState<'local' | 'server'>(initialUploadId ? 'server' : 'local');
  const [mainVisible, setMainVisible] = useState(true);

  // 로컬 파일 → Object URL 추적 (revoke 위해)
  const localObjectUrlRef = useRef<string | null>(null);

  // ── 현재 작업 메타데이터 (다듬기 저장 후 또는 정합 진입 시 채워짐) ──
  const [metadata, setMetadata] = useState<MetadataResult | null>(null);

  // ── 모드 ──
  const [mode, setMode] = useState<EditorMode>(initialMode);

  // ── 메타데이터 모달 (목적: 'save' = 다듬기 저장, 'align' = 정합 진입) ──
  const [metadataModal, setMetadataModal] = useState<{
    purpose: 'save' | 'align';
    saveResolve?: (m: MetadataResult) => void;
    saveReject?: () => void;
  } | null>(null);

  // ── 다듬기 → 정합 모드 전환 시 align 도구 상태 ──
  const [doorAlignOpen, setDoorAlignOpen] = useState(false);
  const [doorIndices, setDoorIndices] = useState<number[] | null>(null);

  const reloadWithUrl = useCallback((newUrl: string) => {
    setCurrentUrl(newUrl);
  }, []);

  // 서버 진입 — initialSogUrl 변화 시 동기화
  const lastInitialUrlRef = useRef(initialSogUrl);
  useEffect(() => {
    if (lastInitialUrlRef.current === initialSogUrl) return;
    lastInitialUrlRef.current = initialSogUrl ?? null;
    if (initialSogUrl) {
      setCurrentUrl(initialSogUrl);
    }
  }, [initialSogUrl]);

  // 추가 레이어 (basemap 등)
  const additional = useAdditionalGsplats(coreRef);

  // ── 메타데이터 입력 모달 흐름 ──
  const requestMetadata = useCallback((purpose: 'save' | 'align'): Promise<MetadataResult> => {
    return new Promise((resolve, reject) => {
      setMetadataModal({ purpose, saveResolve: resolve, saveReject: reject });
    });
  }, []);

  const handleMetadataConfirm = useCallback(async (result: MetadataResult) => {
    setMetadata(result);
    metadataModal?.saveResolve?.(result);
    setMetadataModal(null);
  }, [metadataModal]);

  const handleMetadataClose = useCallback(() => {
    metadataModal?.saveReject?.();
    setMetadataModal(null);
  }, [metadataModal]);

  // ── 다듬기 결과를 서버에 업로드 (메타데이터 없으면 모달) ──
  const onRequestUpload = useCallback(async (bytes: Uint8Array, filename: string) => {
    const meta = metadata ?? await requestMetadata('save');

    // 1. /uploads/init
    const initRes = await api.post<UploadInitResponse>('/uploads/init', {
      filename,
      file_size: bytes.byteLength,
      content_type: 'application/octet-stream',
      building_id: meta.building_id,
      floor_id: meta.floor_id,
      module_id: meta.module_id,
      ply_target: 'refined',
    });

    // 2. parts PUT
    const parts: { part_number: number; etag: string }[] = [];
    for (let i = 0; i < initRes.presigned_urls.length; i++) {
      const start = i * initRes.part_size;
      const end = Math.min(start + initRes.part_size, bytes.byteLength);
      const chunk = bytes.slice(start, end);
      const res = await fetch(initRes.presigned_urls[i], { method: 'PUT', body: chunk });
      if (!res.ok) throw new Error(`파트 ${i + 1} 업로드 실패`);
      const etag = res.headers.get('etag')?.replace(/"/g, '') || '';
      parts.push({ part_number: i + 1, etag });
    }

    // 3. /uploads/complete
    await api.post('/uploads/complete', {
      upload_id: initRes.upload_id,
      minio_upload_id: initRes.minio_upload_id,
      parts,
    });
  }, [metadata, requestMetadata]);

  // ── Refine tool ──
  const refine = useRefineTool(coreRef, {
    uploadId,
    reloadWithUrl,
    currentUrl: currentUrl ?? '',
    onRequestUpload: source === 'local' ? onRequestUpload : undefined,
  });

  // ── Align tool ──
  const selector = useGaussianSelector(coreRef);
  const { openDoor, closeDoor } = useDoorAnimation(coreRef);
  const pivotEditor = usePivotEditor(coreRef);
  const transform = useTransformTool(coreRef);

  const handleSplatLoaded = useCallback((data: SplatData) => {
    refine.onSplatLoaded(data);
    selector.onSplatLoaded(data);
  }, [refine, selector]);

  // ── 파일 선택 (로컬, 다중) ──
  // - 메인이 아직 없으면: 첫 파일을 메인으로, 나머지는 추가 레이어
  // - 메인이 이미 있으면: 모두 추가 레이어 (덮어쓰지 않음)
  const handlePickFiles = useCallback((files: File[]) => {
    const valid: File[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase();
      if (ext && SCENE_3D_EXTS.includes(ext)) valid.push(f);
      else rejected.push(f.name);
    }
    if (rejected.length > 0) {
      alert(`지원하지 않는 파일은 무시됨 (.ply / .splat / .sog 만 지원):\n${rejected.join('\n')}`);
    }
    if (valid.length === 0) return;

    let startIdx = 0;
    if (!currentUrl) {
      // 메인 없음 → 첫 파일을 메인으로
      const first = valid[0];
      // 이전 메인 Object URL revoke (방어)
      if (localObjectUrlRef.current) {
        URL.revokeObjectURL(localObjectUrlRef.current);
        localObjectUrlRef.current = null;
      }
      const url = URL.createObjectURL(first);
      localObjectUrlRef.current = url;

      setCurrentUrl(url);
      setUploadId(undefined);
      setDisplayName(first.name);
      setSource('local');
      setMainVisible(true);
      setMetadata(null);
      setMode(null);
      startIdx = 1;
    }

    // 나머지 파일들은 추가 레이어로
    for (let i = startIdx; i < valid.length; i++) {
      const f = valid[i];
      const blobUrl = URL.createObjectURL(f);
      additional.add(blobUrl, { name: f.name, source: 'local' });
    }
  }, [currentUrl, additional]);

  // ── 메인 제거 (레이어 패널 X 버튼) ──
  const handleRemoveMain = useCallback(() => {
    if (localObjectUrlRef.current) {
      URL.revokeObjectURL(localObjectUrlRef.current);
      localObjectUrlRef.current = null;
    }
    setCurrentUrl(null);
    setUploadId(undefined);
    setDisplayName(null);
    setSource('local');
    setMainVisible(true);
    setMetadata(null);
    setMode(null);
  }, []);

  // ── 추가 레이어를 활성(메인) 으로 승격: 기존 메인은 추가 레이어로 강등 ──
  // basemap은 편집 대상이 아니므로 무시. 메인이 없으면 단순 승격.
  const handleSelectAdditional = useCallback((id: string) => {
    const target = additional.items.find(it => it.id === id);
    if (!target || target.source === 'basemap') return;
    if (!target.loaded || target.error) return;

    // 1) 선택 항목을 list에서 떼어내며 URL 소유권 인수 (revoke 안 함)
    const detached = additional.detach(id);
    if (!detached) return;

    // 2) 현재 메인이 있으면 추가 레이어로 강등 (URL 소유권은 useAdditionalGsplats 가 인수)
    const prevMainUrl = currentUrl;
    const prevMainName = displayName ?? '파일';
    const prevMainSource = source;
    const prevMainVisible = mainVisible;
    const prevMainMeta = { uploadId, metadata };

    // 3) 새 메인 상태 적용 (URL 소유권은 메인의 localObjectUrlRef 가 인수 — blob일 때만)
    const newSource: 'local' | 'server' =
      detached.source === 'server' ? 'server' : 'local';
    const newUploadId = detached.meta?.uploadId as string | undefined;
    const newMetadata = (detached.meta?.metadata ?? null) as MetadataResult | null;

    setCurrentUrl(detached.url);
    setDisplayName(detached.name);
    setSource(newSource);
    setUploadId(newUploadId);
    setMetadata(newMetadata);
    setMainVisible(detached.visible);
    setMode(null);

    // 메인이 추적하던 (이전) blob URL은 추가 레이어로 넘어가므로 더 이상 메인이 revoke 안 한다.
    localObjectUrlRef.current = detached.url.startsWith('blob:') ? detached.url : null;

    // 4) 기존 메인을 추가 레이어로 추가 (URL 소유권 이전)
    if (prevMainUrl) {
      const prevAddSource: AdditionalGsplatSource = prevMainSource;
      additional.add(prevMainUrl, {
        name: prevMainName,
        source: prevAddSource,
        visible: prevMainVisible,
        meta: prevMainMeta,
      });
    }
  }, [additional, currentUrl, displayName, source, mainVisible, uploadId, metadata]);

  // 언마운트 시 로컬 Object URL 정리
  useEffect(() => {
    return () => {
      if (localObjectUrlRef.current) {
        URL.revokeObjectURL(localObjectUrlRef.current);
        localObjectUrlRef.current = null;
      }
    };
  }, []);

  // ── 모드 토글 ──
  const handleToggleMode = useCallback(async (next: 'refine' | 'align') => {
    if (mode === next) {
      setMode(null);
      return;
    }
    if (next === 'align') {
      // 정합 진입: 메타데이터 없으면 모달
      let meta = metadata;
      if (!meta) {
        try {
          meta = await requestMetadata('align');
        } catch {
          return; // 사용자 취소
        }
      }
      // basemap 자동 fetch → 추가 레이어
      try {
        const bm = await api.get<ActiveBasemapResponse>(`/basemaps/active?floor_id=${meta.floor_id}`);
        // 같은 floor의 basemap이 이미 추가되어 있으면 중복 추가 방지
        const alreadyHas = additional.items.some(
          it => it.source === 'basemap' && it.url === bm.url,
        );
        if (!alreadyHas) {
          // presigned URL을 fetch → blob → object URL로 변환해서 클라이언트 임시 다운로드
          const resp = await fetch(bm.url);
          if (!resp.ok) throw new Error(`basemap 다운로드 실패: ${resp.status}`);
          const blob = await resp.blob();
          const blobUrl = URL.createObjectURL(blob);
          additional.add(blobUrl, { name: `basemap v${bm.version} (${bm.filename})`, source: 'basemap' });
        }
      } catch (e: any) {
        alert(`basemap 가져오기 실패: ${e?.message || e}`);
      }
    }
    setMode(next);
  }, [mode, metadata, requestMetadata, additional]);

  // ── Align 도구 핸들러 ──
  const handleStartTransform = () => {
    const indices = selector.selectedIndices();
    if (indices.length === 0) return;
    transform.startTransform(indices);
  };
  const handleSetDoor = () => {
    const indices = selector.selectedIndices();
    if (indices.length === 0) return;
    setDoorIndices(indices);
  };
  const handlePivotEdit = () => {
    if (!doorIndices) return;
    pivotEditor.startEditing(doorIndices);
  };
  const handleOpen = () => {
    if (!doorIndices) return;
    const pivotData = pivotEditor.getPivotForAnimation();
    openDoor(doorIndices, {
      pivotAxis: pivotData?.pivotAxis ?? 'y',
      angleDeg: 90,
      durationSec: 1.0,
      pivot: pivotData?.pivot,
    });
  };
  const handleClose = () => {
    closeDoor({ durationSec: 1.0 });
  };

  // ── 메인 splat 가시성 토글 (코어에 반영) ──
  const handleToggleMainVisible = useCallback(() => {
    const next = !mainVisible;
    setMainVisible(next);
    coreRef.current?.setMainVisible(next);
  }, [mainVisible]);

  // 정합 transform 저장 — 정합 결과를 DB에
  const handleSaveAlignmentTransform = useCallback(async () => {
    if (!metadata) return;
    const ent = (coreRef.current?.getSplatData() as any)?.splatEntity;
    if (!ent) return;
    const p = ent.getLocalPosition();
    const q = ent.getLocalRotation();
    const s = ent.getLocalScale();
    const transform = {
      position: [p.x, p.y, p.z],
      rotation: [q.x, q.y, q.z, q.w],
      scale: [s.x, s.y, s.z],
    };
    try {
      await api.put(`/modules/${metadata.module_id}/alignment-transform`, { transform });
      alert('정합 결과 저장 완료');
    } catch (e: any) {
      alert(`정합 결과 저장 실패: ${e?.message || e}`);
    }
  }, [metadata]);

  // ── 레이어 패널용 메인 정보 ──
  const mainLayerInfo = useMemo(() => {
    if (!currentUrl) return null;
    return {
      name: displayName ?? '파일',
      source,
      visible: mainVisible,
    };
  }, [currentUrl, displayName, source, mainVisible]);

  const handleBack = useCallback(() => {
    if (typeof window !== 'undefined') window.history.back();
  }, []);

  return (
    <SplatViewerCore ref={coreRef} sogUrl={currentUrl} onSplatLoaded={handleSplatLoaded}>
      {/* 좌측 사이드바 */}
      <ViewerSidebar
        mode={mode}
        hasMain={!!currentUrl}
        hasMetadata={!!metadata}
        onPickFiles={handlePickFiles}
        onToggleMode={handleToggleMode}
        onBack={handleBack}
      />

      {/* 우상단 레이어 패널 */}
      <LayerPanel
        main={mainLayerInfo}
        onMainToggleVisible={handleToggleMainVisible}
        onMainRemove={handleRemoveMain}
        additional={additional.items}
        onAdditionalToggleVisible={(id) => {
          const item = additional.items.find(it => it.id === id);
          if (item) additional.setVisible(id, !item.visible);
        }}
        onAdditionalRemove={additional.remove}
        onAdditionalSelect={handleSelectAdditional}
      />

      {/* 빈 viewer 안내 */}
      {!currentUrl && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="bg-black/50 backdrop-blur-sm border border-white/10 rounded-lg px-6 py-4 text-center pointer-events-auto">
            <p className="text-sm text-gray-300 mb-1">파일을 불러오세요</p>
            <p className="text-xs text-gray-500">왼쪽 <span className="text-blue-400">파일</span> 버튼으로 .ply / .splat / .sog 선택</p>
          </div>
        </div>
      )}

      {/* 다듬기 모드 UI */}
      {mode === 'refine' && currentUrl && refine.ui}

      {/* 정합 모드 UI */}
      {mode === 'align' && currentUrl && (
        <>
          {selector.ui}
          {(uploadId || metadata) && (
            <button
              onClick={() => setDoorAlignOpen(v => !v)}
              className={`absolute top-3 left-[110px] z-40 px-3 py-1.5 rounded cursor-pointer text-xs font-bold ${
                doorAlignOpen ? 'bg-yellow-500 text-black' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
              }`}
            >
              {doorAlignOpen ? '문 정합 닫기' : '문 정합'}
            </button>
          )}
          {doorAlignOpen && uploadId && (
            <Suspense fallback={null}>
              <DoorAlignModal
                coreRef={coreRef}
                uploadId={uploadId}
                currentUrl={currentUrl}
                onDone={(u) => { setDoorAlignOpen(false); reloadWithUrl(u); }}
                onClose={() => setDoorAlignOpen(false)}
              />
            </Suspense>
          )}
          <div className="absolute bottom-16 right-3 bg-black/70 text-gray-300 text-xs rounded p-3 flex flex-col gap-2 select-none min-w-[200px] z-40">
            <div className="text-white font-bold text-sm">변환</div>
            {!transform.active ? (
              <button
                onClick={handleStartTransform}
                className="px-2 py-1 bg-teal-600 hover:bg-teal-500 text-white rounded cursor-pointer"
              >
                선택 → 변환 시작
              </button>
            ) : (
              <div className="flex flex-col gap-1">
                <div className="flex gap-1">
                  <button
                    onClick={() => transform.setMode('translate')}
                    className={`flex-1 px-2 py-1 rounded cursor-pointer ${transform.mode === 'translate' ? 'bg-teal-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}
                  >이동</button>
                  <button
                    onClick={() => transform.setMode('rotate')}
                    className={`flex-1 px-2 py-1 rounded cursor-pointer ${transform.mode === 'rotate' ? 'bg-teal-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}
                  >회전</button>
                </div>
                <p className="text-[10px] text-gray-400">
                  {transform.mode === 'translate' ? '축 화살표를 드래그하여 이동' : '축 링을 드래그하여 회전'}
                </p>
                <div className="flex gap-1">
                  <button onClick={transform.confirmTransform}
                    className="flex-1 px-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded cursor-pointer">확정</button>
                  <button onClick={transform.cancelTransform}
                    className="flex-1 px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded cursor-pointer">취소</button>
                </div>
              </div>
            )}

            <div className="border-t border-gray-600 my-1" />

            <div className="text-white font-bold text-sm">문 애니메이션</div>
            <button
              onClick={handleSetDoor}
              className="px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded cursor-pointer"
            >
              선택 → 문 지정 ({doorIndices ? `${doorIndices.length}개` : '없음'})
            </button>

            {doorIndices && !pivotEditor.editing && (
              <button
                onClick={handlePivotEdit}
                className="px-2 py-1 bg-yellow-600 hover:bg-yellow-500 text-white rounded cursor-pointer"
              >
                {pivotEditor.confirmed ? '경첩 재지정' : '경첩 지정'}
              </button>
            )}
            {pivotEditor.editing && (
              <div className="flex flex-col gap-1">
                <p className="text-[10px] text-gray-400">
                  끝점: 개별 이동 | 중앙: 평행이동
                  <br />Shift+드래그 또는 링: 회전
                </p>
                <div className="flex gap-1">
                  <button onClick={pivotEditor.confirmAxis}
                    className="flex-1 px-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded cursor-pointer">확정</button>
                  <button onClick={pivotEditor.stopEditing}
                    className="flex-1 px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded cursor-pointer">취소</button>
                </div>
              </div>
            )}

            {doorIndices && pivotEditor.confirmed && !pivotEditor.editing && (
              <div className="flex gap-1">
                <button onClick={handleOpen}
                  className="flex-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded cursor-pointer">열기</button>
                <button onClick={handleClose}
                  className="flex-1 px-2 py-1 bg-orange-600 hover:bg-orange-500 text-white rounded cursor-pointer">닫기</button>
              </div>
            )}

            {/* 정합 결과 transform 저장 (메타데이터 있을 때) */}
            {metadata && (
              <>
                <div className="border-t border-gray-600 my-1" />
                <button onClick={handleSaveAlignmentTransform}
                  className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded cursor-pointer">
                  정합 결과 저장
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* 파일명 표시 (모드 비활성 시 좌하단에 두어 사이드바 가림 방지) */}
      {displayName && (
        <div className="absolute bottom-3 left-16 z-40 bg-black/60 backdrop-blur-sm border border-white/10 rounded px-2.5 py-1.5 text-xs text-gray-300 max-w-[360px] truncate shadow-lg" title={displayName}>
          {displayName}
          {metadata && <span className="ml-2 text-[10px] text-gray-500">[{metadata.building_name} / {metadata.floor_number}F / {metadata.module_name}]</span>}
        </div>
      )}

      {/* 메타데이터 모달 */}
      {metadataModal && (
        <MetadataPickerModal
          title={metadataModal.purpose === 'save' ? '다듬기 결과 저장' : '정합 시작 — 위치 정보'}
          description={
            metadataModal.purpose === 'save'
              ? '이 결과를 어느 건물 / 층 / 모듈에 저장할지 지정하세요.'
              : '정합에 사용할 basemap을 찾을 위치를 지정하세요.'
          }
          initial={metadata
            ? { building_name: metadata.building_name, floor_number: metadata.floor_number, module_name: metadata.module_name }
            : undefined}
          onConfirm={handleMetadataConfirm}
          onClose={handleMetadataClose}
        />
      )}
    </SplatViewerCore>
  );
}
