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
import { useRouter } from 'next/navigation';
import { copyRefineState } from '@/lib/refine/persistence';

const DoorAlignModal = lazy(() => import('./tools/DoorAlignModal'));
const Sam3PromptModal = lazy(() => import('./tools/Sam3PromptModal'));
const AlignPanel = lazy(() => import('./tools/AlignPanel'));

export type EditorMode = 'refine' | 'door' | 'align' | null;
export type RegistrationPurpose = 'basemap' | 'module';
export interface RegistrationContext {
  purpose: RegistrationPurpose;
  building_id?: string;
  building_name: string;
  floor_id?: string;
  floor_number: number;
  module_name?: string;
  kakao_place_id?: string;
  address_name?: string;
  road_address_name?: string;
  latitude?: number;
  longitude?: number;
}

interface Props {
  /** 서버 진입 시 (대시보드에서 업로드 클릭 → /viewer?upload_id=X). */
  initialSogUrl?: string | null;
  initialUploadId?: string;
  initialDisplayName?: string;
  initialMode?: EditorMode;
  /** 백엔드가 실제로 서빙한 PLY variant — 'original' = raw frame, 'refined' = A'+Y baked frame.
   *  SAM3 자동추출 prefill 의 좌표 frame 분기에 사용. */
  initialServedVariant?: 'original' | 'refined' | null;
  initialRegistrationContext?: RegistrationContext | null;
}

interface EnsureRegistrationContextResponse {
  building_id: string;
  building_name: string;
  floor_id: string;
  floor_number: number;
  module_id: string | null;
  module_name: string | null;
}

export default function UnifiedSplatEditor({
  initialSogUrl = null,
  initialUploadId,
  initialDisplayName,
  initialMode = null,
  initialServedVariant = null,
  initialRegistrationContext = null,
}: Props) {
  const router = useRouter();
  const coreRef = useRef<SplatViewerCoreRef>(null);
  const isBasemapPurpose = initialRegistrationContext?.purpose === 'basemap';
  const isModulePurpose = initialRegistrationContext?.purpose === 'module';

  // ── 메인 splat 상태 ──
  // currentUrl만 바뀌어도 SplatViewerCore가 entity만 in-place 교체하므로 reloadKey 같은
  // 강제 remount 트리거는 더 이상 필요 없음 (앱/카메라/추가 레이어 모두 유지).
  const [currentUrl, setCurrentUrl] = useState<string | null>(initialSogUrl ?? null);
  const [uploadId, setUploadId] = useState<string | undefined>(initialUploadId);
  const [displayName, setDisplayName] = useState<string | null>(initialDisplayName ?? null);
  const [source, setSource] = useState<'local' | 'server'>(initialUploadId ? 'server' : 'local');
  const [mainVisible, setMainVisible] = useState(true);
  // 서빙된 PLY variant — DoorAlignModal SAM3 prefill 의 좌표 frame 분기에 사용.
  //   'original' = 메모리 PLY 가 raw frame (다듬기 회전 미적용) → ayToRaw 변환 필요.
  //   'refined'  = 메모리 PLY 가 A'+Y baked (회전 베이크됨) → 항등 변환.
  // 로컬 파일 진입은 항상 raw (사용자 머신의 원본) 이므로 'original'.
  const [servedVariant, setServedVariant] = useState<'original' | 'refined' | null>(initialServedVariant ?? (initialUploadId ? null : 'original'));

  // 로컬 파일 → Object URL 추적 (revoke 위해)
  const localObjectUrlRef = useRef<string | null>(null);
  // 로컬 파일 크기 (문 설정 완료 시 register-local 의 quota 추적용 — 서버 파일이면 미사용)
  const localFileSizeRef = useRef<number>(0);

  // ── 현재 작업 메타데이터 (문 설정 완료 시 register-local 결과 또는 정합 진입 시 채워짐) ──
  const [metadata, setMetadata] = useState<MetadataResult | null>(null);
  // metadata state 의 closure 캡처 stale 회피용 ref. handleMetadataConfirm 가 setMetadata 직후
  // onSetupSaveDone 콜백에서 fetchBasemapAndMatchDoor(meta) 등을 호출하는 흐름에서 필요.
  const metadataRef = useRef<MetadataResult | null>(null);
  useEffect(() => { metadataRef.current = metadata; }, [metadata]);

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
  // SAM3 자동 추출 완료 시 doors.json 에서 가져온 4 corner. DoorAlignModal 에 prefill 로 전달.
  const [autoExtractedCorners, setAutoExtractedCorners] = useState<Array<[number, number, number]> | null>(null);
  // /sam3/start 응답을 받아 backend 가 sam3_status='running' 으로 commit 한 시점 이후에만 폴링을
  // 시작하기 위한 가드. 이전 dispatch 의 stale 'done' 을 새 시도의 결과로 오인하는 race 차단.
  const [sam3DispatchSent, setSam3DispatchSent] = useState(false);

  // ── 단방향 진행 잠금 ──
  // 완료 버튼으로 다음 단계로 넘어간 이전 단계는 되돌릴 수 없음 (변경 시 후속 단계 의존성이 깨지므로).
  // 다듬기 완료 → 'upload' + 'refine' 잠금. 문 설정 완료 → 'door' 추가 잠금.
  const [lockedStages, setLockedStages] = useState<Set<'upload' | 'refine' | 'door'>>(() => new Set());

  // 문 설정 완료 직후 정합 단계 진입 시점 — 메모리에 이미 wall mesh / 도어 entity 가 살아있어서
  // 서버에서 mesh.json + tex 를 다시 받아오는 useRefinedMeshLoader 가 동작하면 punch 가 풀림.
  // 이 플래그가 true 인 동안 loader 를 비활성. 페이지 reload (새 세션) 시 false 로 초기화.
  const [meshIsFreshInMemory, setMeshIsFreshInMemory] = useState(false);
  const [basemapDone, setBasemapDone] = useState(false);

  // 정합 단계 자동 매칭에 쓸 basemap 의 4 코너 (모듈 호수와 매칭된 문). null 이면 매칭 실패 상태.
  const [basemapDoorCorners, setBasemapDoorCorners] = useState<Array<[number, number, number]> | null>(null);
  const [basemapMatchError, setBasemapMatchError] = useState<string | null>(null);
  // 모듈측 (현재 작업 중인 모듈) 의 1차 도어 (door_1) 4 코너. 백엔드 doors.json 에서 가져옴 (A'+Y 프레임).
  const [moduleDoorCorners, setModuleDoorCorners] = useState<Array<[number, number, number]> | null>(null);

  const reloadWithUrl = useCallback((newUrl: string) => {
    setCurrentUrl(newUrl);
  }, []);

  // 서버 진입 — initialSogUrl 변화 시 동기화 (servedVariant 도 함께)
  const lastInitialUrlRef = useRef(initialSogUrl);
  useEffect(() => {
    if (lastInitialUrlRef.current === initialSogUrl) return;
    lastInitialUrlRef.current = initialSogUrl ?? null;
    if (initialSogUrl) {
      setCurrentUrl(initialSogUrl);
      setServedVariant(initialServedVariant ?? 'original');
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
    // ref 즉시 갱신 — onSetupSaveDone 콜백이 setState 사이클 기다리지 않고 사용 가능.
    metadataRef.current = result;
    // 로컬 파일에서 문 설정 완료 또는 정합 진입 시 → register-local 로 upload 등록.
    // (정합 모달은 uploadId 가 있어야 doors.json 로드/저장 가능. save/align 둘 다 등록 필요.)
    if (!uploadId && (metadataModal?.purpose === 'save' || metadataModal?.purpose === 'align')) {
      try {
        const regPath = isBasemapPurpose ? '/uploads/register-local-basemap' : '/uploads/register-local';
        const regBody = isBasemapPurpose ? {
          filename: displayName ?? 'local.ply',
          building_id: result.building_id,
          floor_id: result.floor_id,
          file_size: localFileSizeRef.current || 0,
          content_type: 'application/octet-stream',
        } : {
          filename: displayName ?? 'local.ply',
          building_id: result.building_id,
          floor_id: result.floor_id,
          module_id: result.module_id,
          file_size: localFileSizeRef.current || 0,
          content_type: 'application/octet-stream',
        };
        const reg = await api.post<{ upload_id: string; minio_path: string }>(
          regPath,
          regBody,
        );
        copyRefineState('', reg.upload_id);
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
  }, [metadataModal, uploadId, displayName, isBasemapPurpose]);

  const handleMetadataClose = useCallback(() => {
    // 정합 단계 진입용 모달은 dismiss 시 작업이 저장되지 않으므로 경고. save 용도는 그냥 닫음.
    if (metadataModal?.purpose === 'align') {
      const ok = window.confirm(
        '모듈 정보를 입력하지 않으면 지금까지 작업한 내용이 저장되지 않습니다. 정말 나가시겠습니까?',
      );
      if (!ok) return;
    }
    metadataModal?.saveReject?.();
    setMetadataModal(null);
  }, [metadataModal]);

  // ── SAM3 자동 추출 진행 폴링 ──
  // 다듬기 완료 직후 dispatch 한 SAM3 작업 상태(`/uploads/{id}/sam3`)를 2.5s 주기로 조회.
  // status='done' 이면 doors.json 가져와 4 corner 를 DoorAlignModal 에 prefill 후 autoExtracting=false.
  // status='failed' 면 autoExtracting=false (사용자가 수동 picking 으로 진행).
  // sam3DispatchSent: /sam3/start 응답을 받은 이후에만 폴링. 이전 시도의 stale 'done' 을 새 시도의
  // 결과로 오인해 로딩 표시가 즉시 사라지는 race 방지.
  useEffect(() => {
    if (!autoExtracting || !uploadId || !sam3DispatchSent) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.get<{ sam3_status?: string | null }>(`/uploads/${uploadId}/sam3`);
        if (cancelled) return;
        if (s.sam3_status === 'done') {
          try {
            const doors = await api.get<{ doors: Array<{ id: string; corners: number[][] }> }>(`/uploads/${uploadId}/doors`);
            if (cancelled) return;
            const target = doors.doors.find(d => d.id === 'door_1') ?? doors.doors[0];
            if (target?.corners?.length === 4) {
              setAutoExtractedCorners(target.corners.map(c => [c[0], c[1], c[2]]) as Array<[number, number, number]>);
            }
          } catch (e) {
            console.warn('[Sam3] doors.json fetch 실패', e);
          }
          setAutoExtracting(false);
          return;
        }
        if (s.sam3_status === 'failed') {
          console.warn('[Sam3] 자동 추출 실패 — 수동 모드로 전환');
          setAutoExtracting(false);
          return;
        }
      } catch (e) {
        // 네트워크 일시 오류 — 다음 tick 재시도.
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, 2500);
      }
    };
    let timer = window.setTimeout(tick, 1500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [autoExtracting, uploadId, sam3DispatchSent]);

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
    setMode(next);
    // 다듬기 단계를 건너뛰고 바로 문 설정으로 진입하는 경우 — SAM3 자동 추출 프롬프트 자동 오픈.
    // (정상 흐름인 다듬기 완료 → onSwitchToAlign 경로와 별개로, 문 코너 검출만 빠르게 테스트할 수 있도록.)
    if (next === 'door' && mode !== 'refine') {
      setLockedStages(s => {
        const n = new Set(s);
        n.add('upload');
        n.add('refine');
        return n;
      });
      // 로컬 파일이라 uploadId 가 아직 없으면 먼저 모듈 정보 모달 → register-local 으로 uploadId 확보.
      // 그래야 SAM3 dispatch (`/uploads/{id}/sam3/start`) 가 동작.
      if (!uploadId) {
        requestMetadata('save').then(() => {
          setSam3PromptOpen(true);
        }).catch(e => {
          console.warn('[skip-refine] register-local 실패 — 모달 미오픈', e);
        });
      } else {
        setSam3PromptOpen(true);
      }
    }
  }, [mode, lockedStages, uploadId, requestMetadata]);

  // 모듈 측 (자기 자신) 의 첫 도어 (door_1) 4 코너 가져옴. 백그라운드 저장 후엔 서버 doors.json 에 있음.
  // 백그라운드 저장 직후엔 아직 없을 수 있으니 retry. 정합 단계 진입 직후 호출.
  const fetchModuleDoorCorners = useCallback(async (id: string) => {
    setModuleDoorCorners(null);
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const doors = await api.get<{ doors: Array<{ id: string; corners: number[][] }> }>(`/uploads/${id}/doors`);
        const primary = doors.doors.find(d => d.id === 'door_1') ?? doors.doors[0];
        if (primary && Array.isArray(primary.corners) && primary.corners.length === 4) {
          setModuleDoorCorners(primary.corners.map(c => [c[0], c[1], c[2]]) as Array<[number, number, number]>);
          return;
        }
      } catch { /* ignore — retry */ }
      await new Promise(r => setTimeout(r, 500));
    }
    console.warn('[align] 모듈 도어 코너 fetch 실패 (10회 재시도 모두 실패)');
  }, []);

  // basemap fetch + 호수 문 자동 매칭. 모듈 정보 확정 후 정합 진입 시 호출.
  // 매칭 실패 시 basemapMatchError 설정 → 정합 버튼 비활성.
  const fetchBasemapAndMatchDoor = useCallback(async (meta: MetadataResult) => {
    setBasemapDoorCorners(null);
    setBasemapMatchError(null);
    try {
      const bm = await api.get<ActiveBasemapResponse>(`/basemaps/active?floor_id=${meta.floor_id}`);
      // basemap PLY 를 layer 로 추가 (이미 있으면 스킵)
      const alreadyHas = additional.items.some(
        it => it.source === 'basemap' && it.url === bm.url,
      );
      if (!alreadyHas) {
        const resp = await fetch(bm.url);
        if (resp.ok) {
          const blob = await resp.blob();
          const blobUrl = URL.createObjectURL(blob);
          additional.add(blobUrl, { name: `basemap v${bm.version} (${bm.filename})`, source: 'basemap' }).ready.catch(() => {});
        }
      }

      // basemap 의 doors.json 가져와 호수 매칭.
      if (!bm.source_upload_id) {
        setBasemapMatchError('basemap 에 source upload 정보가 없습니다 (basemap 등록을 다시 확인하세요).');
        return;
      }
      const doors = await api.get<{ doors: Array<{ id: string; corners: number[][]; unitName?: string | null }> }>(
        `/basemaps/${bm.basemap_id}/doors`,
      );
      const target = doors.doors.find(d => d.unitName === meta.module_name);
      if (!target) {
        setBasemapMatchError(`basemap 에 "${meta.module_name}" 이름의 문 정보가 없습니다. (basemap 등록 시작 시 저장 이름 확인)`);
        return;
      }
      if (!Array.isArray(target.corners) || target.corners.length !== 4) {
        setBasemapMatchError('basemap 의 매칭된 문 corners 형식이 올바르지 않습니다.');
        return;
      }
      setBasemapDoorCorners(target.corners.map(c => [c[0], c[1], c[2]]) as Array<[number, number, number]>);
    } catch (e: any) {
      setBasemapMatchError(`basemap 가져오기 실패: ${e?.message || e}`);
    }
  }, [additional]);

  // ── Refine tool ──
  // 다듬기 완료 시 호출 — 서버 업로드면 skip, 로컬 파일은 모달 (register-local 이 유효 UUID 요구).
  const requestSaveMetadata = useCallback(async (): Promise<MetadataResult> => {
    return await requestMetadata('save');
  }, [requestMetadata]);

  const refine = useRefineTool(coreRef, {
    active: mode === 'refine',
    basemapMode: isBasemapPurpose,
    uploadId,
    currentUrl: currentUrl ?? undefined,
    reloadWithUrl,
    originalFilename: displayName ?? undefined,
    servedVariant,
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
          // 로컬 파일이라 uploadId 가 아직 없으면 → 모듈 정보 모달 → register-local 으로
          // uploadId 확보 후에야 SAM3 자동 추출 dispatch 가 동작. 모달 처리 후 SAM3 프롬프트 오픈.
          if (!isBasemapPurpose && !uploadId) {
            requestMetadata('save').then(() => {
              setSam3PromptOpen(true);
            }).catch(e => {
              console.warn('[refine→door] register-local 실패 — SAM3 모달 미오픈', e);
            });
          } else if (!isBasemapPurpose) {
            setSam3PromptOpen(true);
          }
          return 'door';
        }
        return prev;
      });
    },
    onRequestMetadata: requestSaveMetadata,
  });

  // 정제된 wall mesh + 텍스처 자동 로드 (저장된 mesh.json + tex_*.png).
  // 비활성 조건 두 가지:
  //   - door 단계: register-local 로 uploadId 가 먼저 생기고 refined save 가 뒤따라 /refine/refined-bundle 이 404 를 낼 수 있음.
  //   - meshIsFreshInMemory: 문 설정 완료 직후 정합 진입 시 메모리에 이미 punch 된 텍스처 + 메시가 있어 서버 fetch 가 덮어쓰면 안 됨.
  useRefinedMeshLoader(coreRef, uploadId, Boolean(uploadId) && mode !== 'door' && !meshIsFreshInMemory);

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

  const ensureRegistrationContext = useCallback(async (moduleName?: string | null) => {
    const fixed = initialRegistrationContext;
    if (!fixed) throw new Error('missing registration context');
    const resolvedModuleName = moduleName === undefined ? fixed.module_name : moduleName ?? undefined;
    const payload = {
      building_id: fixed.building_id,
      floor_id: fixed.floor_id,
      building_name: fixed.building_name,
      floor_number: fixed.floor_number,
      module_name: resolvedModuleName,
      kakao_place_id: fixed.kakao_place_id,
      address_name: fixed.address_name,
      road_address_name: fixed.road_address_name,
      latitude: fixed.latitude,
      longitude: fixed.longitude,
    };
    return await api.post<EnsureRegistrationContextResponse>(
      '/buildings/ensure-registration-context',
      payload,
    );
  }, [initialRegistrationContext]);

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
              onDone={(u) => { if (!isBasemapPurpose) { void handleToggleMode('align'); reloadWithUrl(u); } }}
              onClose={() => { if (!isBasemapPurpose) { void handleToggleMode('align'); } }}
              view="setup"
              autoExtracting={autoExtracting}
              autoExtractedCorners={autoExtractedCorners}
              servedVariant={servedVariant}
              basemapMode={isBasemapPurpose}
              basemapUnitName={isBasemapPurpose ? initialRegistrationContext?.module_name : undefined}
              onManualPickStart={() => { setAutoExtracting(false); setSam3DispatchSent(false); setAutoExtractedCorners(null); }}
              ensureUploadId={async () => {
                // 등록 진입 시 받은 컨텍스트가 있으면 모달 없이 확정하고, 레거시 진입만 모달로 보완한다.
                if (isBasemapPurpose) {
                  const ensured = await ensureRegistrationContext(null);
                  const result: MetadataResult = {
                    building_id: ensured.building_id,
                    building_name: ensured.building_name,
                    floor_id: ensured.floor_id,
                    floor_number: ensured.floor_number,
                    module_id: 'basemap',
                    module_name: 'basemap',
                  };
                  metadataRef.current = result;
                  setMetadata(result);
                  let newId = uploadId;
                  if (!newId) {
                    const reg = await api.post<{ upload_id: string; minio_path: string }>(
                      '/uploads/register-local-basemap',
                      {
                        filename: displayName ?? 'local.ply',
                        building_id: ensured.building_id,
                        floor_id: ensured.floor_id,
                        file_size: localFileSizeRef.current || 0,
                        content_type: 'application/octet-stream',
                      },
                    );
                    copyRefineState('', reg.upload_id);
                    newId = reg.upload_id;
                    setUploadId(reg.upload_id);
                    setSource('server');
                  }
                  if (!newId) throw new Error('register failed');
                  return newId;
                }
                if (isModulePurpose && initialRegistrationContext?.module_name?.trim()) {
                  const ensured = await ensureRegistrationContext(initialRegistrationContext.module_name);
                  const result: MetadataResult = {
                    building_id: ensured.building_id,
                    building_name: ensured.building_name,
                    floor_id: ensured.floor_id,
                    floor_number: ensured.floor_number,
                    module_id: ensured.module_id ?? '',
                    module_name: ensured.module_name ?? initialRegistrationContext.module_name.trim(),
                  };
                  if (!result.module_id) throw new Error('module registration failed');
                  metadataRef.current = result;
                  setMetadata(result);
                  let newId = uploadId;
                  if (!newId) {
                    const reg = await api.post<{ upload_id: string; minio_path: string }>(
                      '/uploads/register-local',
                      {
                        filename: displayName ?? 'local.ply',
                        building_id: ensured.building_id,
                        floor_id: ensured.floor_id,
                        module_id: result.module_id,
                        file_size: localFileSizeRef.current || 0,
                        content_type: 'application/octet-stream',
                      },
                    );
                    copyRefineState('', reg.upload_id);
                    newId = reg.upload_id;
                    setUploadId(reg.upload_id);
                    setSource('server');
                  }
                  if (!newId) throw new Error('register failed');
                  return newId;
                }
                let meta: MetadataResult & { upload_id?: string };
                try { meta = await requestMetadata('align'); } catch { throw new Error('cancelled'); }
                const newId = meta.upload_id ?? uploadId;
                if (!newId) throw new Error('register failed');
                return newId;
              }}
              onCommitRefined={async (id) => {
                // refined PLY + mesh.json + tex_*.png 일괄 업로드. 베이크된 회전값 그대로 반환.
                return await refine.commitRefinedToServer(id);
              }}
              getCurrentKeepMask={() => refine.getCurrentKeepMask?.() ?? null}
              getBakeRgba={(sid) => refine.getBakeRgba?.(sid) ?? null}
              getCurrentBakedRotation={() => refine.getCurrentBakedRotation?.() ?? { rotX: 0, rotZ: 0, wallAngleRad: 0 }}
              onSetupSaveDone={async (activeUploadId: string) => {
                // 문 설정 완료 (메모리 직주입 + 백그라운드 저장 + 정합 진입).
                // - 메모리에 이미 모든 자산 (PLY, wall mesh, doors) 이 있으니 서버 fetch 안 한다.
                // - useRefinedMeshLoader 우회 + alignmentGroup 으로 reparent.
                setMeshIsFreshInMemory(true);
                setLockedStages(s => {
                  const n = new Set(s);
                  n.add('door');
                  return n;
                });
                // 정합 모드 entity 재구성 — splat + wall mesh + door mesh + module-side 추가 splat 을 한 부모 아래.
                if (!isBasemapPurpose) {
                  coreRef.current?.enterAlignmentMode?.();
                  await handleToggleMode('align', { force: true });
                }
                // basemap fetch + 호수 매칭 + 모듈 도어 코너 fetch (백그라운드 저장 끝나면 서버 doors.json 에 있음).
                const meta = metadataRef.current;
                if (meta && !isBasemapPurpose) {
                  void fetchBasemapAndMatchDoor(meta);
                }
                // 백그라운드 PLY 업로드 → doors.json PUT 이 끝나야 fetch 가 성공. retry 로 처리.
                if (!isBasemapPurpose) {
                  void fetchModuleDoorCorners(activeUploadId);
                } else {
                  await refine.commitRefinedToServer(activeUploadId);
                  await api.post('/basemaps/register', { upload_id: activeUploadId });
                  setBasemapDone(true);
                  setTimeout(() => router.push('/dashboard'), 1400);
                }
              }}
            />
          </Suspense>
        )}
        {/* 다듬기 완료 직후 — SAM3 프롬프트 팝업. */}
        {mode === 'door' && sam3PromptOpen && !isBasemapPurpose && (
          <Suspense fallback={null}>
            <Sam3PromptModal
              onStartAuto={(prompt) => {
                setSam3Prompt(prompt);
                setSam3PromptOpen(false);
                setAutoExtracting(true);
                setSam3DispatchSent(false);
                setAutoExtractedCorners(null);
                // 백그라운드: refined PLY 업로드 → SAM3 dispatch.
                // 로컬 파일(아직 register-local 안 한 경우) 이면 자동 추출 시작이 불가능하므로
                // 그 경우 dispatch는 건너뛰고 사용자는 수동 지정으로 진행 (autoExtracting 은 UI 라벨만).
                (async () => {
                  if (!uploadId) {
                    console.warn('[Sam3] uploadId 미확보 — 자동 추출 dispatch 스킵 (로컬 파일은 문 설정 완료 시 register-local).');
                    return;
                  }
                  try {
                    const { plyKey, rotX, rotZ, wallAngleRad } = await refine.commitRefinedToServer(uploadId);
                    // SAM3 검출은 백엔드가 원본 PLY (upload.minio_path) 로 수행 — 다듬기 후 PLY 는
                    // 벽이 분리돼 SAM3 가 문을 못 봐 본질적 검출 불가능. refined_ply_key 는 doors.json
                    // 저장 위치 도출용. bake_rotation 은 원본 좌표계 corner → refined 좌표계 변환에 사용.
                    await api.post(`/uploads/${uploadId}/sam3/start`, {
                      refined_ply_key: plyKey,
                      prompt,
                      bake_rotation: { rotX, rotZ, wallAngleRad },
                    });
                    // backend 가 sam3_status='running' 으로 commit 한 시점 이후 폴링 안전.
                    setSam3DispatchSent(true);
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
                setSam3DispatchSent(false);
              }}
              onClose={() => setSam3PromptOpen(false)}
            />
          </Suspense>
        )}
        {/* 정합 단계 — 새 AlignPanel (basemap 자동 매칭 + 슝 애니메이션 + 수동 핸들 + 4×4 저장). */}
        {mode === 'align' && !isBasemapPurpose && (
          <>
            {/* 진단용: 어느 조건이 막고 있는지 표시 */}
            {(!currentUrl || !uploadId || !metadata) && (
              <div className="bg-amber-900/80 border border-amber-600 rounded p-3 text-amber-100 text-xs space-y-1">
                <div className="font-bold">정합 패널 미표시 — 누락 조건:</div>
                {!currentUrl && <div>• currentUrl 없음 (파일 미로드)</div>}
                {!uploadId && <div>• uploadId 없음 (모듈 정보 모달 미완료)</div>}
                {!metadata && <div>• metadata 없음 (모듈 정보 모달 미완료)</div>}
              </div>
            )}
            {currentUrl && uploadId && metadata && (
              <Suspense fallback={<div className="text-xs text-gray-400 p-3">패널 로딩...</div>}>
                <AlignPanel
                  coreRef={coreRef}
                  uploadId={uploadId}
                  metadata={metadata}
                  basemapDoorCorners={basemapDoorCorners}
                  basemapMatchError={basemapMatchError}
                  moduleDoorCorners={moduleDoorCorners}
                />
              </Suspense>
            )}
          </>
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
          fixedContext={isModulePurpose && initialRegistrationContext ? {
            building_id: initialRegistrationContext.building_id,
            building_name: initialRegistrationContext.building_name,
            floor_id: initialRegistrationContext.floor_id,
            floor_number: initialRegistrationContext.floor_number,
            module_name: initialRegistrationContext.module_name,
            kakao_place_id: initialRegistrationContext.kakao_place_id,
            address_name: initialRegistrationContext.address_name,
            road_address_name: initialRegistrationContext.road_address_name,
            latitude: initialRegistrationContext.latitude,
            longitude: initialRegistrationContext.longitude,
          } : null}
          initial={metadata
            ? { building_name: metadata.building_name, floor_number: metadata.floor_number, module_name: metadata.module_name }
            : undefined}
          onConfirm={handleMetadataConfirm}
          onClose={handleMetadataClose}
        />
      )}
      {basemapDone && (
        <div className="absolute inset-0 z-[70] bg-black/70 flex items-center justify-center">
          <div className="text-center text-white text-xl font-bold">basemap 등록 신청이 완료되었습니다</div>
        </div>
      )}
    </SplatViewerCore>
  );
}
