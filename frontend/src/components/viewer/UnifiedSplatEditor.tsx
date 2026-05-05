'use client';

import { useRef, useState, useCallback, useEffect, useMemo, Suspense, lazy } from 'react';
import SplatViewerCore, { SplatViewerCoreRef, SplatData } from './SplatViewerCore';
import ViewerSidebar from './ViewerSidebar';
import LayerPanel from './LayerPanel';
import MetadataPickerModal, { MetadataResult } from './MetadataPickerModal';
import { useRefineTool } from './tools/useRefineTool';
import { useRefinedMeshLoader } from './tools/useRefinedMeshLoader';
import { useAdditionalGsplats, AdditionalGsplatSource } from './tools/useAdditionalGsplats';
import { destroyMainDerivedMeshes, splitSceneFilesByExtension } from './tools/sourceManager';
import { api } from '@/lib/api';
import { ActiveBasemapResponse } from '@/types';

const DoorAlignModal = lazy(() => import('./tools/DoorAlignModal'));
const Sam3PromptModal = lazy(() => import('./tools/Sam3PromptModal'));
export type EditorMode = 'refine' | 'door' | 'align' | null;

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
  // 로컬 파일 크기 (문 설정 완료 시 register-local 의 quota 추적용 — 서버 파일이면 미사용)
  const localFileSizeRef = useRef<number>(0);

  // ── 현재 작업 메타데이터 (문 설정 완료 시 register-local 결과 또는 정합 진입 시 채워짐) ──
  const [metadata, setMetadata] = useState<MetadataResult | null>(null);

  // ── 모드 ──
  const [mode, setMode] = useState<EditorMode>(initialMode);

  // ── 메타데이터 모달 (목적: 'save' = 다듬기 결과 저장, 'align' = 정합 진입) ──
  const [metadataModal, setMetadataModal] = useState<{
    purpose: 'save' | 'align';
    saveResolve?: (m: MetadataResult) => void;
    saveReject?: () => void;
  } | null>(null);

  // ── 다듬기 → 정합 모드 전환 시 align 도구 상태 ──
  // 다듬기 완료 직후 띄우는 SAM3 프롬프트 팝업 + 자동 문 추출 진행 상태.
  const [sam3PromptOpen, setSam3PromptOpen] = useState(false);
  const [autoExtracting, setAutoExtracting] = useState(false);
  const [, setSam3Prompt] = useState('');

  // ── 단방향 진행 잠금 ──
  // 완료 버튼으로 다음 단계로 넘어간 이전 단계는 되돌릴 수 없음 (변경 시 후속 단계 의존성이 깨지므로).
  // 다듬기 완료 → 'upload' + 'refine' 잠금. 문 설정 완료 → 'door' 추가 잠금.
  const [lockedStages, setLockedStages] = useState<Set<'upload' | 'refine' | 'door'>>(() => new Set());

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
  // - purpose='save': 다듬기 결과 저장 (건물/층/모듈 입력)
  // - purpose='align': 정합 모드 진입 (basemap 위치 지정)
  const requestMetadata = useCallback((purpose: 'save' | 'align'): Promise<MetadataResult> => {
    return new Promise((resolve, reject) => {
      setMetadataModal({ purpose, saveResolve: resolve, saveReject: reject });
    });
  }, []);

  const handleMetadataConfirm = useCallback(async (result: MetadataResult) => {
    let enriched: MetadataResult & { upload_id?: string } = result;
    // 로컬 파일에서 문 설정 완료 또는 정합 진입 시 → register-local 로 upload 등록.
    // (정합 모달은 uploadId 가 있어야 doors.json 로드/저장 가능. save/align 둘 다 등록 필요.)
    if (!uploadId && (metadataModal?.purpose === 'save' || metadataModal?.purpose === 'align')) {
      try {
        const reg = await api.post<{ upload_id: string; minio_path: string }>(
          '/uploads/register-local',
          {
            filename: displayName ?? 'local.ply',
            building_id: result.building_id,
            floor_id: result.floor_id,
            module_id: result.module_id,
            file_size: localFileSizeRef.current || 0,
            content_type: 'application/octet-stream',
          },
        );
        setUploadId(reg.upload_id);
        setSource('server');
        enriched = { ...result, upload_id: reg.upload_id };
      } catch (e: any) {
        alert(`업로드 등록 실패: ${e?.message || e}`);
        metadataModal?.saveReject?.();
        setMetadataModal(null);
        return;
      }
    }
    setMetadata(result);
    metadataModal?.saveResolve?.(enriched);
    setMetadataModal(null);
  }, [metadataModal, uploadId, displayName]);

  const handleMetadataClose = useCallback(() => {
    metadataModal?.saveReject?.();
    setMetadataModal(null);
  }, [metadataModal]);

  // ── 페이지 이탈 경고 — 다듬기/문 설정 단계에선 저장되지 않은 변경사항이 있으므로 닫기/새로고침 시 경고. ──
  useEffect(() => {
    if (mode !== 'refine' && mode !== 'door') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '저장되지 않은 변경사항이 있습니다.';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [mode]);

  // ── 모드 토글 ──
  // useRefineTool 보다 먼저 정의해야 onSwitchToAlign 콜백에서 안전하게 참조 가능.
  const handleToggleMode = useCallback(async (next: 'refine' | 'door' | 'align', opts: { force?: boolean } = {}) => {
    // 잠긴 단계로 되돌아가는 시도 차단 — 완료 버튼(force) 외 사용자 조작은 무시.
    if (!opts.force && (next === 'refine' || next === 'door') && lockedStages.has(next)) {
      return;
    }
    // 다듬기/문 설정 단계에서 이탈 시도 시 경고. force=true (= 완료 버튼) 면 bypass.
    if (!opts.force && (mode === 'refine' || mode === 'door') && next !== mode) {
      const ok = window.confirm('저장되지 않은 변경사항이 있습니다. 정말 나가시겠습니까? 다듬기 / 문 설정 작업이 모두 사라집니다.');
      if (!ok) return;
    }
    if (mode === next) {
      setMode(null);
      return;
    }
    if (next === 'align') {
      // 정합 진입 시 metadata 보장 (force=true 면 메타데이터 이미 있다고 가정 — 문 설정 완료 경로).
      let meta = metadata;
      if (!opts.force && (!meta || !uploadId)) {
        try {
          meta = await requestMetadata('align');
        } catch {
          return; // 사용자 취소
        }
      }
      // basemap 자동 fetch — meta 있을 때만.
      if (meta?.floor_id) {
        try {
          const bm = await api.get<ActiveBasemapResponse>(`/basemaps/active?floor_id=${meta.floor_id}`);
          const alreadyHas = additional.items.some(
            it => it.source === 'basemap' && it.url === bm.url,
          );
          if (!alreadyHas) {
            const resp = await fetch(bm.url);
            if (!resp.ok) throw new Error(`basemap 다운로드 실패: ${resp.status}`);
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            additional.add(blobUrl, { name: `basemap v${bm.version} (${bm.filename})`, source: 'basemap' }).ready.catch(() => {});
          }
        } catch (e: any) {
          alert(`basemap 가져오기 실패: ${e?.message || e}`);
        }
      }
    }
    setMode(next);
  }, [mode, metadata, uploadId, requestMetadata, additional, lockedStages]);

  // ── Refine tool ──
  // 다듬기 완료 시 호출 — 서버 업로드면 skip, 로컬 파일은 모달 (register-local 이 유효 UUID 요구).
  const requestSaveMetadata = useCallback(async (): Promise<MetadataResult> => {
    return await requestMetadata('save');
  }, [requestMetadata]);

  const refine = useRefineTool(coreRef, {
    active: mode === 'refine',
    uploadId,
    currentUrl: currentUrl ?? undefined,
    reloadWithUrl,
    originalFilename: displayName ?? undefined,
    // 다듬기 완료 → 문 설정 단계 + SAM3 프롬프트 팝업 자동 오픈.
    // 단 이미 'door' 또는 'align' 이면 transition 안 함 (saveRefined 가 재호출된 경우).
    onSwitchToAlign: () => {
      setMode((prev) => {
        if (prev === 'refine') {
          // 다듬기 완료 → 업로드 + 다듬기 단계 잠금. 이후 되돌릴 수 없음.
          setLockedStages(s => {
            const n = new Set(s);
            n.add('upload');
            n.add('refine');
            return n;
          });
          setSam3PromptOpen(true);
          return 'door';
        }
        return prev;
      });
    },
    onRequestMetadata: requestSaveMetadata,
  });

  // 정제된 wall mesh + 텍스처 자동 로드 (저장된 mesh.json + tex_*.png).
  // door 단계에서는 register-local 로 uploadId 가 먼저 생기고 refined save 가 뒤따르므로
  // loader 를 켜면 /refine/refined-bundle 이 save 완료 전에 404 를 낸다. align 진입 후 로드한다.
  useRefinedMeshLoader(coreRef, uploadId, Boolean(uploadId) && mode !== 'door');

  const handleSplatLoaded = useCallback((data: SplatData) => {
    refine.onSplatLoaded(data);
  }, [refine]);

  // ── 파일 선택 (로컬, 다중) ──
  // - 메인이 아직 없으면: 첫 파일을 메인으로, 나머지는 추가 레이어
  // - 메인이 이미 있으면: 모두 추가 레이어 (덮어쓰지 않음)
  const handlePickFiles = useCallback((files: File[]) => {
    const { valid, rejected } = splitSceneFilesByExtension(files);
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
      localFileSizeRef.current = first.size;

      setCurrentUrl(url);
      setUploadId(undefined);
      setDisplayName(first.name);
      setSource('local');
      setMainVisible(true);
      setMetadata(null);
      setMode('refine');
      startIdx = 1;
    }

    // 나머지 파일들은 추가 레이어로
    for (let i = startIdx; i < valid.length; i++) {
      const f = valid[i];
      const blobUrl = URL.createObjectURL(f);
      additional.add(blobUrl, { name: f.name, source: 'local' }).ready.catch(() => {});
    }
  }, [currentUrl, additional]);

  // ── 메인 제거 (레이어 패널 X 버튼) ──
  const handleRemoveMain = useCallback(() => {
    // 메인 PLY 제거 시 연결된 텍스쳐 mesh (wallMesh_*, doorMesh_*) 도 같이 destroy.
    // 다듬기 단계에서 만든 막 (wallMesh) + 정합 단계에서 만든 도어 mesh 모두 메인 surface 기준이라
    // 메인이 사라지면 함께 사라져야 함.
    const app = coreRef.current?.getApp();
    destroyMainDerivedMeshes(app?.root);

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
    setMode('refine');

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
      }).ready.catch(() => {});
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

  // ── 메인 splat 가시성 토글 (코어에 반영) ──
  const handleToggleMainVisible = useCallback(() => {
    const next = !mainVisible;
    setMainVisible(next);
    coreRef.current?.setMainVisible(next);
  }, [mainVisible]);

  // 정합 transform 저장 — 정합 결과를 DB에
  const handleSaveAlignmentTransform = useCallback(async () => {
    // SPEC: upload-scoped 변환행렬 저장 — POST /uploads/{id}/alignment.
    // upload_id 가 없으면(로컬 파일만 띄운 상태) 저장 불가.
    if (!uploadId) {
      alert('정합 완료는 서버에 등록된 업로드에서만 가능합니다.');
      return;
    }
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
      await api.post(`/uploads/${uploadId}/alignment`, {
        transform,
        rmsd: null,
        // matches: 정합 UI(DoorAlignModal) 가 별도로 채우므로 여기서는 빈 배열.
        matches: [],
      });
      alert('정합 완료');
    } catch (e: any) {
      alert(`정합 완료 실패: ${e?.message || e}`);
    }
  }, [uploadId]);

  // ── 레이어 패널용 메인 정보 ──
  const mainLayerInfo = useMemo(() => {
    if (!currentUrl) return null;
    return {
      name: displayName ?? '파일',
      source,
      visible: mainVisible,
    };
  }, [currentUrl, displayName, source, mainVisible]);

  // 좌측 패널(사이드바 + 레이어 + 툴) 숨김 토글 — 캔버스 가득 보고 싶을 때.
  const [panelHidden, setPanelHidden] = useState(false);
  const handleCollapsePanel = useCallback(() => setPanelHidden(true), []);
  const handleExpandPanel = useCallback(() => setPanelHidden(false), []);

  const alignPanel = mode === 'align' && currentUrl && !uploadId ? (
    <div className="bg-black/70 backdrop-blur-sm border border-white/10 text-gray-300 text-xs rounded-lg shadow-lg p-3 select-none w-72">
      <div className="text-[11px] text-amber-300 bg-amber-900/30 border border-amber-700 rounded px-2 py-1.5 leading-tight">
        업로드 등록이 필요합니다. 정합 모드를 잠깐 껐다 다시 켜서 메타데이터를 입력하세요.
      </div>
    </div>
  ) : null;

  return (
    <SplatViewerCore ref={coreRef} sogUrl={currentUrl} onSplatLoaded={handleSplatLoaded}>
      {/* 패널 숨김 시: 좌측 가장자리에 펼치기 핸들 노출 */}
      {panelHidden && (
        <button
          onClick={handleExpandPanel}
          title="패널 보이기"
          className="absolute top-3 left-3 z-50 flex items-center justify-center w-9 h-9 bg-black/70 backdrop-blur-sm border border-white/10 text-gray-300 hover:text-white hover:bg-gray-700/80 rounded-lg shadow-lg cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}

      {/* 좌측 컬럼: 사이드바 → 레이어 패널 → 도구 패널. panelHidden 일 때 화면 밖으로 슬라이드. */}
      <div
        className={`absolute top-3 left-3 z-50 flex flex-col gap-2 items-start transition-transform duration-200 ${
          panelHidden ? '-translate-x-[120%] pointer-events-none' : 'translate-x-0'
        }`}
      >
        <ViewerSidebar
          mode={mode}
          hasMain={!!currentUrl}
          hasMetadata={!!metadata}
          lockedStages={lockedStages}
          onPickFiles={handlePickFiles}
          onToggleMode={handleToggleMode}
          onCollapse={handleCollapsePanel}
        />

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

        {mode === 'refine' && currentUrl && refine.panel}
        {alignPanel}
        {/* 문 설정 단계 — DoorAlignModal 의 setup view 항상 표시. uploadId 없어도 렌더 (문 설정 완료 시점에 register-local). */}
        {mode === 'door' && currentUrl && (
          <Suspense fallback={null}>
            <DoorAlignModal
              coreRef={coreRef}
              uploadId={uploadId ?? ''}
              currentUrl={currentUrl}
              onDone={(u) => { void handleToggleMode('align'); reloadWithUrl(u); }}
              onClose={() => { void handleToggleMode('align'); }}
              view="setup"
              autoExtracting={autoExtracting}
              onManualPickStart={() => setAutoExtracting(false)}
              ensureUploadId={async () => {
                // 로컬 파일에서 문 설정 완료 시 호출. 메타데이터 모달 → register-local → 새 uploadId 반환.
                if (uploadId) return uploadId;
                let meta: MetadataResult & { upload_id?: string };
                try {
                  meta = await requestMetadata('save');
                } catch {
                  throw new Error('cancelled');
                }
                const newId = meta.upload_id;
                if (!newId) throw new Error('register failed');
                return newId;
              }}
              onCommitRefined={async (id) => {
                // refined PLY + mesh.json + tex_*.png 일괄 업로드. 베이크된 회전값 그대로 반환.
                return await refine.commitRefinedToServer(id);
              }}
              getCurrentKeepMask={() => refine.getCurrentKeepMask?.() ?? null}
              onSetupSaveDone={async () => {
                // 문 설정 완료 (모든 영속화 끝) → 'door' 단계 추가 잠금 → 정합 진입.
                setLockedStages(s => {
                  const n = new Set(s);
                  n.add('door');
                  return n;
                });
                await handleToggleMode('align', { force: true });
              }}
            />
          </Suspense>
        )}
        {/* 다듬기 완료 직후 — SAM3 프롬프트 팝업. */}
        {mode === 'door' && sam3PromptOpen && (
          <Suspense fallback={null}>
            <Sam3PromptModal
              onStartAuto={(prompt) => {
                setSam3Prompt(prompt);
                setSam3PromptOpen(false);
                setAutoExtracting(true);
                // 백그라운드: refined PLY 업로드 → SAM3 dispatch.
                // 로컬 파일(아직 register-local 안 한 경우) 이면 자동 추출 시작이 불가능하므로
                // 그 경우 dispatch는 건너뛰고 사용자는 수동 지정으로 진행 (autoExtracting 은 UI 라벨만).
                (async () => {
                  if (!uploadId) {
                    console.warn('[Sam3] uploadId 미확보 — 자동 추출 dispatch 스킵 (로컬 파일은 문 설정 완료 시 register-local).');
                    return;
                  }
                  try {
                    const { plyKey } = await refine.commitRefinedToServer(uploadId);
                    await api.post(`/uploads/${uploadId}/sam3/start`, {
                      refined_ply_key: plyKey,
                      prompt,
                    });
                  } catch (e) {
                    console.warn('[Sam3] dispatch 실패 — 사용자가 수동 지정으로 진행 가능', e);
                    // dispatch 실패 시에도 autoExtracting 은 그대로 둠: DoorAlignModal 의 setup view 가
                    // sam3_status 를 폴링해 failed 로 떨어지면 수동 모드로 자동 복귀하도록 처리.
                  }
                })();
              }}
              onSkipToManual={() => {
                setSam3PromptOpen(false);
                setAutoExtracting(false);
              }}
              onClose={() => setSam3PromptOpen(false)}
            />
          </Suspense>
        )}
        {/* 정합 단계 — DoorAlignModal align view 항상 표시 (basemap PLY/4 코너/정합 시작/확정 저장). */}
        {mode === 'align' && currentUrl && uploadId && (
          <Suspense fallback={null}>
            <DoorAlignModal
              coreRef={coreRef}
              uploadId={uploadId}
              currentUrl={currentUrl}
              onDone={(u) => { reloadWithUrl(u); }}
              onClose={() => {}}
              view="align"
            />
          </Suspense>
        )}
        {/* 정합 완료 — 모든 단계의 마지막. mode='align' + metadata 있을 때만 표시. */}
        {mode === 'align' && currentUrl && uploadId && metadata && (
          <div className="bg-black/70 backdrop-blur-sm border border-white/10 rounded-lg shadow-lg p-3 select-none w-72">
            <button onClick={handleSaveAlignmentTransform}
              className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded cursor-pointer text-xs font-bold">
              정합 완료
            </button>
          </div>
        )}
      </div>

      {/* 빈 viewer 안내 — 메인 + 추가 레이어 모두 없을 때만 표시 */}
      {!currentUrl && additional.items.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="bg-black/50 backdrop-blur-sm border border-white/10 rounded-lg px-6 py-4 text-center pointer-events-auto">
            <p className="text-sm text-gray-300 mb-1">파일을 업로드하세요</p>
            <p className="text-xs text-gray-500">왼쪽 <span className="text-blue-400">업로드</span> 버튼으로 .ply / .splat / .sog 선택</p>
          </div>
        </div>
      )}

      {/* 다듬기 모드 — 캔버스 오버레이 (브러쉬 커서 / 미리보기 / 모달) */}
      {mode === 'refine' && currentUrl && (
        <>
          {refine.overlay}
          {refine.modals}
        </>
      )}

      {/* 정합 모드 — DoorAlignModal 은 좌측 컬럼 안에서 렌더 (위쪽 다듬기 panel 들과 동일 위치). */}
      {/* 좌하단 파일명 오버레이 제거 — 레이어 패널에 같은 정보 + 기즈모(Z/Y/X 축) 가림 방지. */}

      {/* 모듈 정보 입력 모달 — 문 설정 완료 또는 정합 진입 시. SAM3 프롬프트는 별도 팝업이라 여기선 안 받음. */}
      {metadataModal && (
        <MetadataPickerModal
          title="모듈 정보 입력"
          description="저장할 건물 / 층 / 모듈을 지정하세요. 완료를 누르면 정합 단계로 넘어갑니다."
          showSamPrompt={false}
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
