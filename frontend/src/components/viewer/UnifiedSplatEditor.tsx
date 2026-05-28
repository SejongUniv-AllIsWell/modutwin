'use client';

import { useRef, useState, useCallback, useEffect, useMemo, Suspense, lazy } from 'react';
import { createPortal } from 'react-dom';
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
import { rawToAY, ayToRaw, type FrameRotation } from '@/lib/refine/coordFrames';
import type { ModuleDoorAssetPayload } from './tools/DoorAlignModal';

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
  initialRegistrationContext?: RegistrationContext | null;
  /** /upload 페이지에서 blob URL 핸드오프로 들어온 로컬 파일의 원본 크기.
   *  blob URL 자체로는 size 를 알 수 없어 register-local 의 quota 계산에 필요. */
  initialLocalFileSize?: number;
  /** 활성 basemap 의 등록된 문 정보만 수정하는 진입. */
  initialBasemapEditMode?: boolean;
  initialBasemapId?: string;
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
  initialRegistrationContext = null,
  initialLocalFileSize = 0,
  initialBasemapEditMode = false,
  initialBasemapId,
}: Props) {
  const router = useRouter();
  const coreRef = useRef<SplatViewerCoreRef>(null);
  const isBasemapPurpose = initialRegistrationContext?.purpose === 'basemap';
  const isModulePurpose = initialRegistrationContext?.purpose === 'module';
  const isBasemapEditMode = isBasemapPurpose && initialBasemapEditMode;

  // ── 메인 splat 상태 ──
  // currentUrl만 바뀌어도 SplatViewerCore가 entity만 in-place 교체하므로 reloadKey 같은
  // 강제 remount 트리거는 더 이상 필요 없음 (앱/카메라/추가 레이어 모두 유지).
  const [currentUrl, setCurrentUrl] = useState<string | null>(initialSogUrl ?? null);
  const [uploadId, setUploadId] = useState<string | undefined>(initialUploadId);
  const [displayName, setDisplayName] = useState<string | null>(initialDisplayName ?? null);
  const [source, setSource] = useState<'local' | 'server'>(initialUploadId ? 'server' : 'local');
  const [mainVisible, setMainVisible] = useState(true);

  // 로컬 파일 → Object URL 추적 (revoke 위해). /upload 페이지에서 blob URL 핸드오프로 들어왔으면 그대로 보관.
  const localObjectUrlRef = useRef<string | null>(
    !initialUploadId && initialSogUrl && initialSogUrl.startsWith('blob:') ? initialSogUrl : null,
  );
  // 로컬 파일 크기 — register-local 의 quota 계산용. 서버 파일이면 미사용.
  const localFileSizeRef = useRef<number>(
    !initialUploadId && initialSogUrl && initialSogUrl.startsWith('blob:') ? (initialLocalFileSize || 0) : 0,
  );
  // 모듈 등록 흐름: 파일 선택 시 백그라운드로 PLY 를 백엔드 임시 보관소에 업로드 → 세션 ID 보관.
  // 자동 문 검출 시 이 세션 ID 만 보내면 됨. 30분 TTL.
  const sam3PrepareSessionIdRef = useRef<string | null>(null);
  const sam3PrepareInFlightRef = useRef<Promise<void> | null>(null);
  // 문 설정 완료 시 DoorAlignModal 이 콜백으로 넘긴 최종 4 corners (A'+Y 프레임).
  // 자동 검출이든 수동 4점이든 동일 경로로 채워짐. 정합 완료 시 commit-final 의 doors.json 으로 직렬화.
  const setupDoorCornersRef = useRef<Array<[number, number, number]> | null>(null);
  const setupDoorAssetsRef = useRef<ModuleDoorAssetPayload | null>(null);

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
  // 정합 대상 basemap 도어의 ID — doorPivotGroup 에서 이 도어만 reparent (다른 호수 wrapper 는 제외).
  const [basemapTargetDoorId, setBasemapTargetDoorId] = useState<string | null>(null);
  // 정합 대상 basemap 도어의 normalInward (baked = A'+Y 프레임). gap 방향 deterministic 산출용.
  const [basemapTargetDoorNormalInward, setBasemapTargetDoorNormalInward] = useState<[number, number, number] | null>(null);
  const [basemapMatchError, setBasemapMatchError] = useState<string | null>(null);
  // basemap 의 mesh.json + tex 를 로드하기 위한 source_upload_id (basemap PLY 자체와 별개).
  const [basemapSourceUploadId, setBasemapSourceUploadId] = useState<string | null>(null);
  // 모듈측 (현재 작업 중인 모듈) 의 1차 도어 (door_1) 4 코너 (raw 프레임).
  const [moduleDoorCorners, setModuleDoorCorners] = useState<Array<[number, number, number]> | null>(null);

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

  // 모듈 등록 컨텍스트가 이미 완전하면 모달 없이 ensure-registration-context 로 즉시 확정.
  // explore → 건물 → 층 → "+ 모듈 추가" → 휠 피커 경로에서 모든 식별자가 URL 로 전달되는 케이스.
  // basemap 등록도 동일하게 처리 (단 module_name 불필요 — placeholder 로 채움).
  const autoFinalizeFromContext = useCallback(async (): Promise<MetadataResult | null> => {
    const ctx = initialRegistrationContext;
    if (!ctx?.building_id || !ctx?.floor_id) return null;
    if (typeof ctx.floor_number !== 'number') return null;
    // basemap: module_name 없이 진행. ensure-registration-context 안 부르고 placeholder 만 반환.
    //   ensureUploadForLocal 가 isBasemapPurpose 일 때 register-local-basemap 으로 uploadId 생성.
    if (isBasemapPurpose) {
      return {
        building_id: ctx.building_id,
        building_name: ctx.building_name ?? '',
        floor_id: ctx.floor_id,
        floor_number: ctx.floor_number,
        module_id: '__basemap__',
        module_name: '__basemap__',
      };
    }
    if (!isModulePurpose) return null;
    if (!ctx.module_name?.trim()) return null;
    const ensured = await api.post<{
      building_id: string;
      building_name: string;
      floor_id: string;
      floor_number: number;
      module_id: string | null;
      module_name: string | null;
    }>('/buildings/ensure-registration-context', {
      building_id: ctx.building_id,
      floor_id: ctx.floor_id,
      building_name: ctx.building_name,
      floor_number: ctx.floor_number,
      module_name: ctx.module_name,
      kakao_place_id: ctx.kakao_place_id,
      address_name: ctx.address_name,
      road_address_name: ctx.road_address_name,
    });
    if (!ensured.building_id || !ensured.floor_id || !ensured.module_id) {
      throw new Error('등록 컨텍스트를 확정하지 못했습니다.');
    }
    return {
      building_id: ensured.building_id,
      building_name: ensured.building_name,
      floor_id: ensured.floor_id,
      floor_number: ensured.floor_number,
      module_id: ensured.module_id,
      module_name: ensured.module_name || ctx.module_name!.trim(),
    };
  }, [initialRegistrationContext, isModulePurpose]);

  // register-local: 로컬 파일이면 upload 행 생성. save/align 진입 시점에 한 번만.
  const ensureUploadForLocal = useCallback(async (result: MetadataResult): Promise<string | null> => {
    if (uploadId) return uploadId;
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
    const reg = await api.post<{ upload_id: string; minio_path: string }>(regPath, regBody);
    copyRefineState('', reg.upload_id);
    setUploadId(reg.upload_id);
    setSource('server');
    return reg.upload_id;
  }, [uploadId, isBasemapPurpose, displayName]);

  // ── 메타데이터 확정 흐름 ──
  // - purpose='save': 다듬기 결과 저장 시점.
  // - purpose='align': 정합 모드 진입 시점.
  //
  // initialRegistrationContext 가 완전히 채워져 있으면 모달 없이 자동 확정:
  //   1) ensure-registration-context 호출 → building/floor/module 확정 (필요하면 생성).
  //   2) 로컬 파일이면 register-local 호출 → uploadId 발급.
  // 컨텍스트가 부족하면 모달로 폴백해서 사용자 입력 받음.
  const requestMetadata = useCallback((purpose: 'save' | 'align'): Promise<MetadataResult> => {
    return (async (): Promise<MetadataResult> => {
      try {
        const auto = await autoFinalizeFromContext();
        if (auto) {
          metadataRef.current = auto;
          let enriched: MetadataResult & { upload_id?: string } = auto;
          if (!uploadId && (purpose === 'save' || purpose === 'align')) {
            try {
              const newUploadId = await ensureUploadForLocal(auto);
              if (newUploadId) enriched = { ...auto, upload_id: newUploadId };
            } catch (e: any) {
              alert(`업로드 등록 실패: ${e?.message || e}`);
              throw e;
            }
          }
          setMetadata(auto);
          return enriched;
        }
      } catch (e: any) {
        console.warn('[metadata] auto-finalize 실패, 모달로 폴백', e);
      }
      return await new Promise<MetadataResult>((resolve, reject) => {
        setMetadataModal({ purpose, saveResolve: resolve, saveReject: reject });
      });
    })();
  }, [autoFinalizeFromContext, ensureUploadForLocal, uploadId]);

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

  // basemap fetch + 호수 문 자동 매칭. 모듈 정보 확정 후 정합 진입 시 호출.
  // 매칭 실패 시 basemapMatchError 설정 → 정합 버튼 비활성.
  const fetchBasemapAndMatchDoor = useCallback(async (meta: MetadataResult) => {
    setBasemapDoorCorners(null);
    setBasemapTargetDoorId(null);
    setBasemapTargetDoorNormalInward(null);
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
      // basemap 의 mesh + 텍스처 로드를 위해 source_upload_id 보관 (useRefinedMeshLoader 가 자동 fetch).
      setBasemapSourceUploadId(bm.source_upload_id);
      const doors = await api.get<{
        doors: Array<{
          id: string;
          corners: number[][];
          unitName?: string | null;
          doorMesh?: { normalInward?: number[] };
        }>;
      }>(
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
      setBasemapTargetDoorId(target.id);
      const ni = target.doorMesh?.normalInward;
      if (Array.isArray(ni) && ni.length === 3) {
        setBasemapTargetDoorNormalInward([ni[0], ni[1], ni[2]] as [number, number, number]);
      } else {
        setBasemapTargetDoorNormalInward(null);
      }
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
  //   - door 단계: 문 설정이 끝나기 전이라 서버 refined bundle 이 아직 없을 수 있음.
  //   - meshIsFreshInMemory: 문 설정 완료 직후 정합 진입 시 메모리에 이미 punch 된 텍스처 + 메시가 있어 서버 fetch 가 덮어쓰면 안 됨.
  // basemap 수정 모드는 등록된 도어 splat 을 별도 레이어로 올리지 않는다. 여러 gsplat entity 가 겹치면
  // 시점별 정렬 아티팩트가 생기므로, 등록된 문은 mesh/라벨/목록으로만 표시한다.
  useRefinedMeshLoader(
    coreRef,
    uploadId,
    Boolean(uploadId) && (mode !== 'door' || isBasemapEditMode) && !meshIsFreshInMemory,
    undefined,
    null,
    true,
    isBasemapEditMode ? refine.registerPersistedBake : undefined,
  );
  // basemap 의 wall mesh + 텍스처 + 도어 (다중) 자산 로드. source_upload_id 가 채워졌을 때만 동작.
  // additional 인스턴스 전달 → 도어 splat 들이 basemap 소속 추가 레이어로 등록됨.
  // 정합 단계에서 매칭된 호수의 도어만 로드 — 다른 호수의 basemapDoor_* wrapper/splat/라벨이 안 생김.
  // metadata.module_name 이 있을 때 (= 모듈 등록 흐름) 만 필터 적용. 베이스맵 자체 뷰어는 모든 도어 노출.
  useRefinedMeshLoader(
    coreRef,
    basemapSourceUploadId ?? undefined,
    !!basemapSourceUploadId,
    additional,
    metadata?.module_name ?? null,
  );

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

      // basemap 외 흐름(모듈 등록 / null purpose): 백그라운드로 PLY 를 임시 보관소에 업로드.
      // 다듬기 도중 자동 문 검출 누르면 세션 ID 만 보내 즉시 검출 시작.
      if (!isBasemapPurpose) {
        sam3PrepareSessionIdRef.current = null;
        const form = new FormData();
        form.append('file', first);
        sam3PrepareInFlightRef.current = (async () => {
          try {
            const data = await api.postForm<{ session_id: string; size: number }>(
              '/uploads/sam3/prepare', form,
            );
            sam3PrepareSessionIdRef.current = data.session_id;
          } catch (e: any) {
            console.warn('[sam3-prepare] 백그라운드 업로드 실패 (자동 문 검출 비활성):', e?.message || e);
          }
        })();
      }
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

  // ── 레이어 ↔ mesh 연동 helper ──
  // 각 레이어는 자기 splat 외에도 연관된 wall/door mesh entity 들을 같이 hide/show 해야 함.
  //   module-main: wallMesh_* (basemap tag 없음)
  //   module-door: doorMesh_* (basemap tag 없음)
  //   basemap-main: wallMesh_* (basemap tag 있음), wallMesh_door_* 제외
  //   basemap-door: wallMesh_door_* (basemap tag 있음)
  type LayerKind = 'module-main' | 'module-door' | 'basemap-main' | 'basemap-door';
  const toggleAssociatedMeshes = useCallback((kind: LayerKind, visible: boolean) => {
    const app = coreRef.current?.getApp?.();
    if (!app) return;
    const group = coreRef.current?.getAlignmentGroup?.();
    const all: any[] = [
      ...(app.root.children as any[]),
      ...((group?.children as any[]) ?? []),
    ];
    for (const ent of all) {
      const name: string = ent.name ?? '';
      const isBasemap = !!ent.tags?.has?.('basemap');
      // wallMesh_door_* 는 도어 mesh (basemap 측 도어). wallMesh_* 는 일반 벽.
      const isDoorByWallPrefix = name.startsWith('wallMesh_door_');
      const isWall = name.startsWith('wallMesh_') && !isDoorByWallPrefix;
      const isDoor = name.startsWith('doorMesh_') || isDoorByWallPrefix;
      let match = false;
      if (kind === 'module-main' && isWall && !isBasemap) match = true;
      else if (kind === 'module-door' && isDoor && !isBasemap) match = true;
      else if (kind === 'basemap-main' && isWall && isBasemap) match = true;
      else if (kind === 'basemap-door' && isDoor && isBasemap) match = true;
      if (match) ent.enabled = visible;
    }
  }, []);

  // ── 메인 splat 가시성 토글 (코어 + 모듈 wall mesh 동기화) ──
  const handleToggleMainVisible = useCallback(() => {
    const next = !mainVisible;
    setMainVisible(next);
    coreRef.current?.setMainVisible(next);
    toggleAssociatedMeshes('module-main', next);
  }, [mainVisible, toggleAssociatedMeshes]);

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

  // 모듈 등록: uploadId 없는 게 정상 (commit-final 시 발급) → 경고 안 띄움. 그 외 흐름만 경고.
  const alignPanel = mode === 'align' && currentUrl && !uploadId && !isModulePurpose ? (
    <div className="bg-black/70 backdrop-blur-sm border border-white/10 text-[var(--ink-2)] text-xs rounded-lg shadow-lg p-3 select-none w-72">
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
          className="absolute top-3 left-3 z-50 flex items-center justify-center w-9 h-9 bg-black/70 backdrop-blur-sm border border-white/10 text-[var(--ink-2)] hover:text-[var(--ink)] hover:bg-[var(--bg-soft)]/80 rounded-lg shadow-lg cursor-pointer"
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
          hideAlign={isBasemapPurpose}
          onCollapse={handleCollapsePanel}
        />

        <LayerPanel
          main={mainLayerInfo}
          onMainToggleVisible={handleToggleMainVisible}
          onMainRemove={handleRemoveMain}
          additional={additional.items}
          onAdditionalToggleVisible={(id) => {
            const item = additional.items.find(it => it.id === id);
            if (!item) return;
            const next = !item.visible;
            additional.setVisible(id, next);
            // 도어 splat 의 부모가 wrapper entity (basemapDoor_* / moduleDoor) 면 wrapper.enabled 토글 → mesh 도 cascade.
            const ent = additional.getEntity(id);
            const parent = ent?.parent;
            const parentName = parent?.name ?? '';
            if (parentName.startsWith('basemapDoor_') || parentName === 'moduleDoor') {
              parent.enabled = next;
            } else {
              // wrapper 없는 케이스 (예: basemap main PLY) — 기존 name 기반 mesh 검색 로직 사용.
              const isBasemapMain = item.source === 'basemap' && item.name.startsWith('basemap ');
              if (isBasemapMain) toggleAssociatedMeshes('basemap-main', next);
            }
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
              sharedAdditional={additional}
              uploadId={uploadId ?? ''}
              currentUrl={currentUrl}
              onDone={(u) => { if (!isBasemapPurpose) { void handleToggleMode('align'); reloadWithUrl(u); } }}
              onClose={() => { if (!isBasemapPurpose) { void handleToggleMode('align'); } }}
              autoExtracting={autoExtracting}
              autoExtractedCorners={autoExtractedCorners}
              basemapMode={isBasemapPurpose}
              basemapEditMode={isBasemapEditMode}
              basemapId={isBasemapEditMode ? initialBasemapId : undefined}
              basemapUnitName={isBasemapPurpose ? initialRegistrationContext?.module_name : undefined}
              basemapFloorId={isBasemapPurpose ? initialRegistrationContext?.floor_id : undefined}
              basemapFloorNumber={isBasemapPurpose ? initialRegistrationContext?.floor_number : undefined}
              onBasemapDone={isBasemapPurpose ? (dest) => {
                if (dest === 'main') router.push('/explore');
                else if (dest === 'building' && initialRegistrationContext?.building_id) router.push(`/buildings/${initialRegistrationContext.building_id}`);
                else router.push('/dashboard');
              } : undefined}
              deferPersistenceToAlign={isModulePurpose}
              onSetupCornersFinalized={(corners) => {
                setupDoorCornersRef.current = corners;
                if (isModulePurpose) {
                  // AlignPanel 의 정합 버튼이 moduleDoorCorners 확보 시 활성화되도록 상태도 동기화.
                  setModuleDoorCorners(corners);
                }
              }}
              onSetupDoorAssetsFinalized={(payload) => {
                setupDoorAssetsRef.current = payload;
              }}
              onManualPickStart={() => { setAutoExtracting(false); setSam3DispatchSent(false); setAutoExtractedCorners(null); }}
              ensureUploadId={async () => {
                // 모듈 등록 흐름: register-local 안 함. placeholder ID 반환.
                // 정합 완료 시 commit-final 이 module/upload row 를 한 번에 생성.
                if (isModulePurpose) {
                  // metadata 도 placeholder 로 채워둠 (requestMetadata 가 이미 했지만 안전망)
                  if (initialRegistrationContext?.module_name?.trim()) {
                    const ctx = initialRegistrationContext;
                    const placeholder: MetadataResult = {
                      building_id: ctx.building_id ?? '',
                      building_name: ctx.building_name ?? '',
                      floor_id: ctx.floor_id ?? '',
                      floor_number: ctx.floor_number ?? 0,
                      module_id: 'pending',
                      module_name: ctx.module_name!.trim(),
                    };
                    metadataRef.current = placeholder;
                    setMetadata(placeholder);
                  }
                  return 'pending';
                }
                // 등록 컨텍스트 있으면 모달 없이 확정. 없으면 모달로 입력 받음.
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
              getRemainingRotationToAY={() => refine.getRemainingRotationToAY?.() ?? { rotX: 0, rotZ: 0, wallAngleRad: 0 }}
              markNextSplatLoadSkipRebake={() => refine.markNextSplatLoadSkipRebake?.()}
              onMainSplatReplaced={(scene) => refine.replaceCanonicalSceneFromCurrentSplat?.(scene)}
              onSetupSaveDone={async (activeUploadId: string, doorCorners) => {
                // 문 설정 완료 → 정합 단계 진입.
                //   - 메모리에 자산 (PLY, wall mesh, doors) 이 이미 있어 서버 fetch 안 함.
                //   - 모듈 도어 corners 는 모달이 인자로 전달 (raw 프레임) → 즉시 주입.
                //   - basemap 흐름은 별도 분기 (commitRefinedToServer + /basemaps/register).
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
                // basemap 매칭: 서버에서 활성 basemap fetch + 호수별 도어 찾기 (모듈 흐름만).
                const meta = metadataRef.current;
                if (meta && !isBasemapPurpose) {
                  void fetchBasemapAndMatchDoor(meta);
                }
                if (!isBasemapPurpose) {
                  // 모듈 도어 코너 — 모달이 직접 전달한 값 사용. 없으면 autoExtracted 로 폴백.
                  if (doorCorners && doorCorners.length === 4) {
                    setupDoorCornersRef.current = doorCorners;
                    setModuleDoorCorners(doorCorners.map(c => [c[0], c[1], c[2]] as [number, number, number]));
                  } else if (autoExtractedCorners && autoExtractedCorners.length === 4) {
                    setupDoorCornersRef.current = autoExtractedCorners;
                    setModuleDoorCorners(autoExtractedCorners);
                  } else {
                    setModuleDoorCorners(null);
                  }
                } else {
                  // basemap 등록 흐름 — 즉시 영속화 후 대시보드 이동.
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
                // 백엔드 임시 보관 PLY 로 door-ml 직행. MinIO/DB 안 건드림.
                // 백그라운드 업로드가 끝나기를 기다리고 detect-temp 호출.
                (async () => {
                  try {
                    if (sam3PrepareInFlightRef.current) {
                      await sam3PrepareInFlightRef.current;
                    }
                    const sid = sam3PrepareSessionIdRef.current;
                    if (!sid) {
                      console.warn('[Sam3] 임시 PLY 세션 미확보 — 자동 검출 불가, 수동 지정으로 진행');
                      return;
                    }
                    const bake = refine.getRemainingRotationToAY?.() ?? { rotX: 0, rotZ: 0, wallAngleRad: 0 };
                    const resp = await api.post<{ corners: { left_top: { x: number; y: number; z: number }; right_top: { x: number; y: number; z: number }; right_bottom: { x: number; y: number; z: number }; left_bottom: { x: number; y: number; z: number } } }>(
                      '/uploads/sam3/detect-temp',
                      { session_id: sid, prompt, bake_rotation: bake },
                    );
                    const c = resp.corners;
                    // SAM3 응답은 A'+Y 프레임 (bake_rotation 적용). raw 프레임 통일 컨벤션 (corners 는 메모리 내 raw 유지)
                    // 에 맞추기 위해 ayToRaw 적용해 저장. commit-final 에서 다시 A'+Y 로 변환해 서버 저장.
                    const orderAY: Array<[number, number, number]> = [
                      [c.left_top.x, c.left_top.y, c.left_top.z],
                      [c.right_top.x, c.right_top.y, c.right_top.z],
                      [c.right_bottom.x, c.right_bottom.y, c.right_bottom.z],
                      [c.left_bottom.x, c.left_bottom.y, c.left_bottom.z],
                    ];
                    const order = orderAY.map(ay => ayToRaw(ay, bake as FrameRotation));
                    setAutoExtractedCorners(order);
                    setSam3DispatchSent(true);
                    setAutoExtracting(false);
                  } catch (e: any) {
                    console.warn('[Sam3] detect-temp 실패 — 수동 지정으로 진행 가능', e?.message || e);
                    setAutoExtracting(false);
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
            {/* 진단용: 어느 조건이 막고 있는지 표시. 모듈 등록은 uploadId 미확보가 정상이라 제외. */}
            {(!currentUrl || (!uploadId && !isModulePurpose) || !metadata) && (
              <div className="bg-amber-900/80 border border-amber-600 rounded p-3 text-amber-100 text-xs space-y-1">
                <div className="font-bold">정합 패널 미표시 — 누락 조건:</div>
                {!currentUrl && <div>• currentUrl 없음 (파일 미로드)</div>}
                {!uploadId && !isModulePurpose && <div>• uploadId 없음 (모듈 정보 모달 미완료)</div>}
                {!metadata && <div>• metadata 없음 (모듈 정보 모달 미완료)</div>}
              </div>
            )}
            {currentUrl && (uploadId || isModulePurpose) && metadata && (
              <Suspense fallback={<div className="text-xs text-[var(--muted)] p-3">패널 로딩...</div>}>
                <AlignPanel
                  coreRef={coreRef}
                  uploadId={uploadId ?? 'pending'}
                  metadata={metadata}
                  basemapDoorCorners={basemapDoorCorners}
                  basemapTargetDoorId={basemapTargetDoorId}
                  basemapTargetDoorNormalInward={basemapTargetDoorNormalInward}
                  basemapMatchError={basemapMatchError}
                  moduleDoorCorners={moduleDoorCorners}
                  onCommitFinal={isModulePurpose ? async ({ matrix4x4, position, rotation, scale, rmsd, doorFrame }) => {
                    // 다듬기 결과 자산 + 정합 행렬을 commit-final 로 일괄 영속화.
                    if (!initialRegistrationContext?.building_id
                      || !initialRegistrationContext?.floor_id
                      || !initialRegistrationContext?.module_name?.trim()) {
                      throw new Error('등록 컨텍스트 미확보');
                    }
                    // 1) 다듬기 결과 자산 빌드 (메모리)
                    const assets = await refine.gatherRefinedAssets();
                    const pc = coreRef.current?.getPC?.();
                    let transformPosition = position;
                    let transformRotation = rotation;
                    let transformScale = scale;
                    if (pc) {
                      const zero = new pc.Vec3(0, 0, 0);
                      const one = new pc.Vec3(1, 1, 1);
                      const alignMat = new pc.Mat4();
                      alignMat.data.set(matrix4x4);
                      const zq = new pc.Quat();
                      zq.setFromEulerAngles(0, 0, 180);
                      const yq = new pc.Quat();
                      yq.setFromEulerAngles(0, -(assets.wallAngleRad * 180) / Math.PI, 0);
                      const z180 = new pc.Mat4().setTRS(zero, zq, one);
                      const invWall = new pc.Mat4().setTRS(zero, yq, one);
                      const correction = new pc.Mat4().mul2(z180, invWall);
                      correction.mul(z180);
                      const finalMat = new pc.Mat4().mul2(alignMat, correction);
                      const p = new pc.Vec3();
                      const q = new pc.Quat();
                      const s = new pc.Vec3();
                      finalMat.getTranslation(p);
                      finalMat.getScale(s);
                      const pureRotMat = finalMat.clone();
                      const m = pureRotMat.data;
                      const sx = s.x || 1, sy = s.y || 1, sz = s.z || 1;
                      m[0] /= sx; m[1] /= sx; m[2] /= sx;
                      m[4] /= sy; m[5] /= sy; m[6] /= sy;
                      m[8] /= sz; m[9] /= sz; m[10] /= sz;
                      q.setFromMat4(pureRotMat);
                      transformPosition = [p.x, p.y, p.z];
                      transformRotation = [q.x, q.y, q.z, q.w];
                      transformScale = [s.x, s.y, s.z];
                    }

                    // 2) doors.json — DoorAlignModal 이 문 설정 완료 시 onSetupCornersFinalized 콜백으로
                    //    넘긴 최종 4 corners (자동/수동 무관 동일 경로). 폴백으로 autoExtractedCorners.
                    const doorCornersRaw = setupDoorCornersRef.current ?? autoExtractedCorners ?? moduleDoorCorners ?? null;
                    if (!doorCornersRaw || doorCornersRaw.length !== 4) {
                      throw new Error('도어 코너 정보 없음 — 문 설정 완료 후 다시 시도');
                    }
                    // 런타임 (정합) 동안 corners 는 raw 프레임으로 다뤘으나 (모듈 entity 와 동일 프레임),
                    // 서버 저장 시점엔 baked PLY 와 일관되게 A'+Y 로 변환.
                    const bake = refine.getRemainingRotationToAY?.() ?? { rotX: 0, rotZ: 0, wallAngleRad: 0 };
                    const doorCornersAY = doorCornersRaw.map(c => rawToAY(c as [number, number, number], bake as FrameRotation));
                    const doorAssets = setupDoorAssetsRef.current;
                    const doorTextureField = 'door_tex_door_1';
                    const doorSplatField = 'door_splat_door_1';
                    const doorsJson = JSON.stringify({
                      version: 1,
                      doors: [{
                        id: 'door_1',
                        corners: doorCornersAY,
                        unitName: initialRegistrationContext.module_name.trim(),
                        ...(doorAssets ? {
                          wallSurfaceId: doorAssets.wallSurfaceId,
                          doorExtractionDepth: doorAssets.doorExtractionDepth,
                          boundarySplitEnabled: doorAssets.boundarySplitEnabled,
                          hingeEdge: doorAssets.hingeEdge,
                          swing: doorAssets.swing,
                          angleDeg: doorAssets.angleDeg,
                        } : {}),
                        ...(doorAssets?.doorMesh ? {
                          doorMesh: {
                            corners: doorAssets.doorMesh.corners,
                            uvs: doorAssets.doorMesh.uvs,
                            normalInward: doorAssets.doorMesh.normalInward,
                            textureFilename: `form:${doorTextureField}`,
                            textureWidth: doorAssets.doorMesh.textureWidth,
                            textureHeight: doorAssets.doorMesh.textureHeight,
                          },
                        } : {}),
                        ...(doorAssets?.doorSplat ? {
                          doorSplat: {
                            filename: `form:${doorSplatField}`,
                          },
                        } : {}),
                        ...(doorFrame ? { doorFrame } : {}),
                      }],
                    });

                    // 3) 덮어쓰기 사전 확인은 호수 휠 피커의 "호수 등록" 버튼에서 처리됨
                    //    (`/floors/{id}/modules` 리스트 조회 후 confirm). 여기까지 도달한 시점에는
                    //    사용자가 이미 동의한 상태. 서버 응답 `was_overwrite` 로 결과 통지.

                    // 4) 대용량 PLY 는 Cloudflare 100MB 요청 본문 한도를 넘으므로 commit-final
                    //    멀티파트에 싣지 않고, staging 키로 청크 presigned PUT 하여 MinIO 에 직접
                    //    올린다(각 청크 ≤ part_size). basemap 다듬기 확정 경로와 동일한 방식.
                    const plyView = assets.plyBytes instanceof Uint8Array
                      ? assets.plyBytes
                      : new Uint8Array(assets.plyBytes);
                    const stagingInit = await api.post<{
                      key: string; minio_upload_id: string; presigned_urls: string[]; part_size: number;
                    }>('/uploads/staging-multipart-init', {
                      filename: assets.plyFilename,
                      file_size: plyView.byteLength,
                      content_type: 'application/octet-stream',
                    });
                    const plyParts: { part_number: number; etag: string }[] = [];
                    for (let i = 0; i < stagingInit.presigned_urls.length; i++) {
                      const start = i * stagingInit.part_size;
                      const end = Math.min(start + stagingInit.part_size, plyView.byteLength);
                      const partResp = await fetch(stagingInit.presigned_urls[i], {
                        method: 'PUT', body: plyView.subarray(start, end) as unknown as BodyInit,
                      });
                      if (!partResp.ok) throw new Error(`PLY 청크 ${i + 1} 업로드 실패: ${partResp.status}`);
                      plyParts.push({
                        part_number: i + 1,
                        etag: partResp.headers.get('etag')?.replace(/"/g, '') ?? '',
                      });
                    }
                    await api.post('/uploads/staging-multipart-complete', {
                      key: stagingInit.key,
                      minio_upload_id: stagingInit.minio_upload_id,
                      parts: plyParts,
                    });

                    // 5) 나머지 작은 자산(mesh/doors/텍스처/도어) + PLY staging 키를 멀티파트 POST.
                    const form = new FormData();
                    form.append('building_id', initialRegistrationContext.building_id);
                    form.append('floor_id', initialRegistrationContext.floor_id);
                    form.append('module_name', initialRegistrationContext.module_name.trim());
                    form.append('original_filename', displayName ?? 'local.ply');
                    form.append('alignment_transform_json', JSON.stringify({
                      position: transformPosition,
                      rotation: transformRotation,
                      scale: transformScale,
                      rmsd,
                      matches: [{ module_door_id: 'door_1', basemap_id: 'auto' }],
                      bake_rotation: {
                        rotX: assets.rotX,
                        rotZ: assets.rotZ,
                        wallAngleRad: assets.wallAngleRad,
                      },
                    }));
                    form.append('final_ply_staging_key', stagingInit.key);
                    form.append('mesh_json', new Blob([assets.meshJson], { type: 'application/json' }), 'mesh.json');
                    form.append('doors_json', new Blob([doorsJson], { type: 'application/json' }), 'doors.json');
                    if (doorAssets?.doorMesh) {
                      form.append(doorTextureField, doorAssets.doorMesh.textureBlob, 'door_1.png');
                    }
                    if (doorAssets?.doorSplat) {
                      form.append(doorSplatField, doorAssets.doorSplat.plyBlob, 'door_1.ply');
                    }
                    // ceiling/floor + 폴리곤 변 수만큼의 wN. assets.textures 에 들어있는 모든 surfaceId 전송.
                    for (const sid of Array.from(assets.textures.keys())) {
                      const tex = assets.textures.get(sid);
                      if (!tex) throw new Error(`텍스처 누락: ${sid} (다듬기 단계에서 모든 면 베이크 필요)`);
                      form.append(`tex_${sid}`, tex, `tex_${sid}.png`);
                    }
                    for (const [key, tex] of Array.from(assets.textureVariants.entries())) {
                      form.append(`texview_${key}`, tex, `tex_${key}.png`);
                    }
                    if (sam3PrepareSessionIdRef.current) {
                      form.append('sam3_session_id', sam3PrepareSessionIdRef.current);
                    }

                    const resp = await api.postForm<{ module_id: string; upload_id: string; scene_output_id: string; was_overwrite: boolean }>(
                      '/uploads/commit-final', form,
                    );
                    if (resp.was_overwrite) {
                      alert('기존 등록을 덮어쓰고 새 작업물을 저장했습니다.');
                    }
                    // 새로 만들어진 module 의 building 페이지로 이동
                    setTimeout(() => {
                      router.push(`/buildings/${initialRegistrationContext.building_id}/floors/${initialRegistrationContext.floor_number}`);
                    }, 800);
                  } : undefined}
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
            <p className="text-sm text-[var(--ink-2)] mb-1">파일을 업로드하세요</p>
            <p className="text-xs text-[var(--muted)]">왼쪽 <span className="text-blue-400">업로드</span> 버튼으로 .ply / .splat / .sog 선택</p>
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
      {basemapDone && typeof document !== 'undefined' && createPortal((
        <div className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-black/85 border border-white/10 rounded-2xl px-10 py-9 w-full max-w-2xl shadow-2xl">
            <div className="flex items-center justify-center mb-5">
              <div className="w-16 h-16 rounded-full bg-green-500/15 border border-green-500/50 flex items-center justify-center">
                <svg className="w-9 h-9 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
            <h3 className="text-2xl font-bold text-white text-center">Basemap 등록이 완료되었습니다</h3>
            <p className="mt-3 text-base text-white/75 text-center">이동할 페이지를 선택해주세요</p>
            <div className="mt-8 flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  if (initialRegistrationContext?.building_id) router.push(`/buildings/${initialRegistrationContext.building_id}`);
                  else router.push('/dashboard');
                }}
                className="flex-1 px-4 py-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-[var(--ink)] text-base font-bold transition"
              >건물 페이지</button>
              <button
                type="button"
                onClick={() => router.push('/dashboard')}
                className="flex-1 px-4 py-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-[var(--ink)] text-base font-bold transition"
              >대시보드</button>
              <button
                type="button"
                onClick={() => setBasemapDone(false)}
                className="flex-1 px-4 py-4 rounded-xl bg-[var(--bg-soft)] hover:bg-[var(--rule)] text-[var(--ink)] text-base font-bold transition"
              >계속 작업</button>
            </div>
          </div>
        </div>
      ), document.body)}
    </SplatViewerCore>
  );
}
