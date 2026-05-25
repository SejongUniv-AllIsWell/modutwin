'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { SplatViewerCoreRef } from '../SplatViewerCore';
import { loadRefineState } from '@/lib/refine/persistence';
import { getEditorRotation, rawToA, aToRaw, rawToAY, type FrameRotation } from '@/lib/refine/coordFrames';
import { surfacePlanesFromPolygon, type SurfacePlane } from '@/lib/gs/planes';
import { useAdditionalGsplats, type AdditionalGsplatsApi } from './useAdditionalGsplats';
import { useDoorLabels } from './useDoorLabels';
import type { GaussianScene } from '@/lib/ply/types';
import type { BoundarySubUpdate } from '@/lib/gs/doorTrim';
import {
  clearDoorsOnServer,
  emptyPicked,
  fetchDoorsFromServer,
  persistDoorsToServer,
  persistEmptyDoorsToServer,
  PRIMARY_DOOR_ID,
  type PersistOpts,
  type PickedCorner,
  type Vec3,
} from './doorAlignDoors';
import { loadBasemapJson, loadBasemapUrl, saveBasemapJson, saveBasemapUrl } from './doorAlignPersistence';
import { easeInOutCubic, parseBasemapCorners, rotationMatrixToQuat } from './doorAlignMath';

interface Props {
  coreRef: React.RefObject<SplatViewerCoreRef>;
  uploadId: string;
  currentUrl: string;
  onDone: (newUrl: string) => void;
  onClose: () => void;
  /** 'setup' = 문 꼭짓점 / 추출 / 회전 / 설정 저장. 'align' = basemap PLY + 4코너 + 정합/확정저장. default 'setup'. */
  view?: 'setup' | 'align';
  /** SAM3 자동 추출 진행 중 — "문 수동 지정" 버튼 외 모두 비활성화. */
  autoExtracting?: boolean;
  /** SAM3 자동 추출 완료 시 부모가 doors.json 에서 가져온 4 코너 (refined 좌표계 raw 프레임).
   *  값이 들어오면 picked 슬롯에 채워지고 사용자는 즉시 보거나 보정 후 저장 가능. */
  autoExtractedCorners?: Array<[number, number, number]> | null;
  /** 사용자가 "문 수동 지정" 을 누르면 호출 — 부모가 autoExtracting 을 false 로 내릴 수 있게. */
  onManualPickStart?: () => void;
  /** "문 설정 완료" 가 성공한 후 호출 — 부모가 정합 단계로 진입할 수 있게.
   *  반환된 promise 가 resolve 되어야 모달이 닫힘 (취소 시 reject 로 닫힘 방지).
   *  - `uploadId`: ensureUploadId 가 확정한 값.
   *  - `doorCorners` (옵션, 모듈 흐름): 모달이 picked 또는 자동 검출로 들고 있는 4 코너 (A'+Y 프레임).
   *    부모가 이걸 받으면 서버 doors.json 재fetch 없이 즉시 `moduleDoorCorners` 에 주입 가능. */
  onSetupSaveDone?: (
    uploadId: string,
    doorCorners?: Array<[number, number, number]> | null,
  ) => Promise<void> | void;
  /** "문 설정 완료" 누른 직후 호출 — uploadId 가 없으면 부모가 모달 + register-local 처리하고 새 uploadId 반환. */
  ensureUploadId?: () => Promise<string>;
  /** 도어 설정 영속화 직전 호출 — refined PLY + mesh.json + tex_*.png 일괄 업로드.
   *  반환: PLY 에 베이크된 회전값 (raw → A'+Y). doors corners 도 같은 프레임으로 변환해야 일관 유지. */
  onCommitRefined?: (uploadId: string) => Promise<{ rotX: number; rotZ: number; wallAngleRad: number; plyKey: string }>;
  /** 다듬기 단계의 현재 keep mask (flatten/floater/brush 모두 반영). 문 추출이 cachedScene 에 적용해
   *  외부 가우시안이 부활하는 문제 방지. 없으면 무필터로 동작. */
  getCurrentKeepMask?: () => Uint8Array | null;
  /** 면별 베이크 텍스처의 CPU 캐시 RGBA 접근. 문 영역 alpha-punch 가 GPU colorTexture 뿐 아니라
   *  서버에 직렬화되는 CPU rgba 에도 반영되도록 — 재진입/다음 세션에서도 punch 유지. */
  getBakeRgba?: (surfaceId: string) => { rgba: Uint8ClampedArray; width: number; height: number } | null;
  /** 다듬기 단계의 정렬 회전값 (pendingRotation + wallAngle) 동기 조회. 메모리 직주입 흐름에서
   *  서버 업로드 await 없이 즉시 doors corners 변환에 사용. */
  getCurrentBakedRotation?: () => { rotX: number; rotZ: number; wallAngleRad: number };
  basemapMode?: boolean;
  basemapUnitName?: string;
  /** basemap 모드 — 호수 휠 피커의 prefix 층 번호 (예: 6 → 601~699). 미지정 시 1 default. */
  basemapFloorNumber?: number;
  /** basemap 등록 완료 후 모달에서 페이지 선택 시 호출 — 부모가 라우팅. (id, route 결정) */
  onBasemapDone?: (destination: 'main' | 'building' | 'dashboard') => void;
  /**
   * 신흐름(모듈 등록): true 면 문 설정 완료 시 onCommitRefined / persistDoorsToServer 호출 안 함.
   * 메모리에 보관 후 정합 완료 시 onCommitFinal 로 일괄 영속화.
   * picked corners 는 새 화면 전환 후에도 유지되어 정합 단계에서 doors 시각화에 사용.
   */
  deferPersistenceToAlign?: boolean;
  /**
   * 문 설정 완료 시점에 최종 확정된 4 코너(A'+Y 프레임)를 부모에게 전달.
   * 자동 검출이든 수동 4점이든 동일 코드 경로로 호출. 부모는 이 코너를 commit-final
   * 페이로드의 doors.json 작성에 사용.
   */
  onSetupCornersFinalized?: (corners: Array<[number, number, number]>) => void;
  /**
   * 신흐름(모듈 등록): 정합 완료 시 호출. 다듬기 결과 자산 + 문 코너 + 정합 행렬을 일괄 영속화.
   * 제공되면 기존 applyAndSave (aligned.ply 업로드 + /uploads/{id}/alignment) 대신 이 콜백 사용.
   * 인자: { fit (rigid), pickedTransformed (A'+Y 프레임 door corners 4개) }.
   * 반환 promise 가 resolve 되면 정합 완료 처리. reject 시 사용자에게 에러 표시.
   */
  onCommitFinal?: (args: {
    fit: { R: number[]; t: number[]; rmsd: number };
    pickedTransformed: Array<PickedCorner | null>;
  }) => Promise<void>;
  /**
   * 부모 컴포넌트의 `useAdditionalGsplats` 인스턴스. 제공되면 자체 인스턴스 대신 사용.
   * DoorAlignModal 언마운트 시 자체 인스턴스의 cleanup 이 도어 splat entity 까지 destroy 하던 버그를 회피.
   * 정합 단계로 transition 시 도어 splat 이 유지되도록 부모 인스턴스 공유.
   */
  sharedAdditional?: AdditionalGsplatsApi;
}

// 픽 / 영속화 / 다운스트림 기하 (Kabsch 등) 는 시계방향 (TL → TR → BR → BL) 인덱스 순서를 가정.
// 이 배열 인덱스가 곧 picked[] 의 인덱스이며 절대 바꾸지 말 것.
const CORNERS = [
  { id: 'tl', label: '왼쪽 위',     hex: '#ef4444' }, // 0
  { id: 'tr', label: '오른쪽 위',   hex: '#facc15' }, // 1
  { id: 'br', label: '오른쪽 아래', hex: '#22c55e' }, // 2
  { id: 'bl', label: '왼쪽 아래',   hex: '#3b82f6' }, // 3
] as const;

// UI 표시용 순서 — 자연스러운 2x2 배치 (왼쪽아래, 오른쪽아래 가 시각 위치 그대로 가도록).
// [TL, TR, BL, BR] = [0, 1, 3, 2]
const DISPLAY_ORDER = [0, 1, 3, 2] as const;

/**
 * 도어 4 코너를 "바닥에 평행한 위/아래 변 + 직사각형" 으로 정규화.
 * - 위 변 (0-1) 와 아래 변 (2-3) 은 Y 평행 (높이 일치).
 * - 좌측 변 (0-3) 과 우측 변 (1-2) 은 같은 horizontal axis 위치 → 수직 평행.
 * - 벽 평면 위에 있어야 하므로 (n·P = d) 조건 유지.
 *
 * anchorIdx:
 *   null      → 초기 4점 픽 직후. 각 변 평균값으로 직사각형 fit.
 *   0..3      → 드래그 중. 그 코너는 raycast 위치 그대로, 대각선 반대 코너는 고정.
 *               남은 두 코너는 직사각형 유지하며 자동 재배치.
 */
function normalizeDoorRect(
  corners: [Vec3, Vec3, Vec3, Vec3],
  plane: SurfacePlane,
  anchorIdx: number | null = null,
  rotation: FrameRotation = { rotX: 0, rotZ: 0, wallAngleRad: 0 },
): [Vec3, Vec3, Vec3, Vec3] {
  const [nx, ny, nz] = plane.normal;
  // 벽이 아니면 (천장/바닥 normal.y=±1) 정규화 skip — 도어는 벽 위.
  if (Math.abs(ny) > 0.5) return corners;
  const hxLen = Math.hypot(nz, -nx);
  if (hxLen < 1e-6) return corners;
  const hxN = nz / hxLen;
  const hzN = -nx / hxLen;
  const d = plane.d;

  // corners 는 raw 프레임, plane 은 A' 프레임 — u/v 분해 + recon 은 A' 에서 일관 처리.
  // 진입 시 raw → A' 변환, 반환 시 A' → raw 로 되돌려 caller 의 raw 컨벤션 유지.
  const cornersA = corners.map(c => rawToA([c[0], c[1], c[2]] as Vec3, rotation)) as [Vec3, Vec3, Vec3, Vec3];

  // (u, v) decomposition: u = pos · h (horizontal on wall), v = pos.y.
  const us = cornersA.map(c => c[0] * hxN + c[2] * hzN);
  const vs = cornersA.map(c => c[1]);

  let u_left: number, u_right: number, v_top: number, v_bot: number;

  if (anchorIdx === null) {
    u_left  = (us[0] + us[3]) * 0.5;
    u_right = (us[1] + us[2]) * 0.5;
    v_top   = (vs[0] + vs[1]) * 0.5;
    v_bot   = (vs[2] + vs[3]) * 0.5;
  } else {
    // anchorIdx = 드래그된 코너 (사용자가 끌어둔 위치). 대각선 반대는 그 전 상태 유지.
    const opp = (anchorIdx + 2) % 4;
    const isLeft = anchorIdx === 0 || anchorIdx === 3;
    const isTop  = anchorIdx === 0 || anchorIdx === 1;
    u_left  = isLeft ? us[anchorIdx] : us[opp];
    u_right = isLeft ? us[opp]       : us[anchorIdx];
    v_top   = isTop  ? vs[anchorIdx] : vs[opp];
    v_bot   = isTop  ? vs[opp]       : vs[anchorIdx];
  }

  // 주의: u/v swap 자동 보정 금지.
  // PLY 프레임에서 +Y 가 ceiling 인데 Z-180 회전으로 화면상 아래로 가고, h 방향도 wall normal sign 에 따라
  // 좌우가 바뀜. v_top<v_bot 또는 u_left>u_right 가 PLY 컨벤션에서 정상 상태라 swap 하면 인덱스 → 위치
  // 매핑이 깨져서 정합 시 상하/좌우 반전 발생. 사용자가 시계방향으로 픽한 ORIGINAL 인덱스 그대로 사용.

  // 평면 위 점 P = d * n_xz + u * h + v * Y. (n.y = 0, h.y = 0 가정.) — A' 프레임 산출.
  const recon = (u: number, v: number): Vec3 => [
    nx * d + hxN * u,
    v,
    nz * d + hzN * u,
  ];
  const reconA: [Vec3, Vec3, Vec3, Vec3] = [
    recon(u_left, v_top),
    recon(u_right, v_top),
    recon(u_right, v_bot),
    recon(u_left, v_bot),
  ];

  return reconA.map(p => aToRaw(p, rotation)) as [Vec3, Vec3, Vec3, Vec3];
}

/**
 * 문 설정 + (구) 정합 단일 모달.
 *
 * - 다듬기에서 저장된 벽/천장/바닥 6개 평면을 불러옴
 * - 사용자가 순서대로(시계방향: 왼위→오위→오아→왼아) 4번 클릭
 * - 각 클릭의 ray와 가장 가까운 평면의 교점을 raw 프레임에서 계산
 * - 각 코너마다 해당 색의 점 + 라벨을 화면에 표시
 *
 * `view` prop:
 *   - 'setup' (기본) — 문 설정 단계: 4꼭짓점 + 두께 + 추출 + 회전 + 문 설정 완료.
 *   - 'align' — 레거시. 현재 정합 단계는 `AlignPanel` 이 담당. 본 모달의 `applyAndSave` 는 dead code.
 *     `onCommitFinal` prop 은 신흐름 호환용으로 유지 (호출 경로 없으나 시그너처 보존).
 */
export default function DoorAlignModal({
  coreRef, uploadId, currentUrl, onDone, onClose, view = 'setup', autoExtracting = false, autoExtractedCorners = null, onManualPickStart, onSetupSaveDone, ensureUploadId, onCommitRefined, getCurrentKeepMask, getBakeRgba, getCurrentBakedRotation, basemapMode = false, basemapUnitName, basemapFloorNumber, onBasemapDone, deferPersistenceToAlign = false, onCommitFinal, onSetupCornersFinalized, sharedAdditional,
}: Props) {
  const [picked, setPicked] = useState<Array<PickedCorner | null>>(() => emptyPicked());
  // 신흐름: 문 설정 완료 시 메모리에 보관해뒀다가 정합 완료 시 commit-final 페이로드에 포함.
  const pendingDoorPersistenceRef = useRef<{
    pickedTransformed: Array<PickedCorner | null>;
    doorOpts: PersistOpts;
  } | null>(null);

  // 신흐름 — basemap 다중 도어: applyDoorRefine 완료 시 메모리 리스트에 누적. "Basemap 등록 완료" 시 일괄 영속.
  interface InMemoryDoor {
    doorId: string;                                             // local id (commit 시 그대로 doors.json 의 id 로 사용)
    cornersRaw: Vec3[];                                         // 4 corners (raw 프레임)
    cornersAY: Vec3[];                                          // 4 corners (A'+Y 프레임 — 저장용)
    wallSurfaceId: string;
    doorMeshInput: {
      rgba: Uint8ClampedArray; width: number; height: number;
      corners: [number, number, number][]; uvs: [number, number][]; normalInward: [number, number, number];
    };                                                          // PNG 인코드 + doors.json doorMesh 메타 작성용
    doorSplatBlobUrl: string | null;                            // door-side gaussian PLY blob URL (있을 때만)
    doorMeshEntityName: string;                                 // PlayCanvas entity name — 삭제 시 destroy
    doorSplatLayerId: string | null;                            // additional splat layer id — 삭제 시 remove
    outlineHandle: import('@/lib/gs/doorOutline').DoorOutlineHandle | null;  // 노란 outline entity (시각화)
    wallTextureSnapshotRect: { x: number; y: number; w: number; h: number } | null; // 벽 텍스처 복원용 bbox (cut.rgba 가 이 위치에서 잘림)
    doorThickness: number;                                      // 두께 메타 (commit 시 그대로 사용)
    boundarySplitEnabled: boolean;
    safetyMargin: number;
    unitName: string;                                           // 빈 문자열 = 미설정
    // 업로드 시 도어 splat PLY (raw 프레임) 을 A'+Y 로 베이크할 때 사용. 베이스맵 메인 PLY 와 동일 프레임 보장.
    bakeRotation: { rotX: number; rotZ: number; wallAngleRad: number };
    // basemap 다중 도어용 — "Basemap 등록 완료" 시 모든 도어의 doorOrig 마킹을 일괄 재적용 위해 보관.
    // (개별 추출 후 다음 도어 추출 시 revertDoorRefine 가 마킹을 풀어버려서, 저장 직전에 다시 적용 필요.)
    doorOriginalIndices: number[];
  }
  const [inMemoryDoors, setInMemoryDoors] = useState<InMemoryDoor[]>([]);
  const inMemoryDoorsRef = useRef<InMemoryDoor[]>([]);
  useEffect(() => { inMemoryDoorsRef.current = inMemoryDoors; }, [inMemoryDoors]);

  // 도어 추출 즉시 호수 라벨 (말풍선) 표시. cornersRaw 사용 — useDoorLabels 가 splatEntity.worldTransform 으로
  // 직접 world 변환 → 등록 단계 (Z-180 + pendingRotation, wallAngle 미베이크) 든 재진입 단계 (Z-180 만) 든 일관.
  const doorLabelEntries = useMemo(() => (
    basemapMode ? inMemoryDoors.map(d => ({
      id: d.doorId,
      unitName: d.unitName || null,
      corners: d.cornersRaw as number[][],
    })) : []
  ), [basemapMode, inMemoryDoors]);
  useDoorLabels(coreRef, doorLabelEntries, basemapMode && view === 'setup');

  // 호수 휠 피커 모달 — 추출된 도어의 unitName 부여용.
  const [unitNamePickerOpen, setUnitNamePickerOpen] = useState<{ doorId: string; initialSuffix: number } | null>(null);

  // basemap 등록 완료 모달 (성공 후 페이지 선택).
  const [completionModalOpen, setCompletionModalOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  // basemap 다중 도어 영속화 — 가장 최근 applyDoorRefine 결과의 mesh input 보관 (PNG 직렬화 + corners/uvs 추출).
  // 문 저장 시점에 이 ref 값을 PNG 로 인코드 + MinIO 업로드, doors.json 메타에 첨부.
  const lastDoorMeshInputRef = useRef<{
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    corners: [number, number, number][];        // A'+Y 프레임 (Z-fight 오프셋 적용된 메시 코너)
    uvs: [number, number][];                    // 4×2
    normalInward: [number, number, number];     // 방 안쪽 normal
  } | null>(null);
  // basemap 다중 도어 — 도어 X 삭제 시 wall 텍스처 alpha=0 punch 복원을 위해 cut.bbox + wallSurfaceId 도 함께 보관.
  const lastDoorMeshBboxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const lastDoorMeshWallSurfaceIdRef = useRef<string | null>(null);

  // 문 경계 (4 변 노란선 + 힌지 cylinder) 표시 토글. true 면 그리고, false 면 둘 다 숨김.
  const [boundaryVisible, setBoundaryVisible] = useState(true);
  const boundaryVisibleRef = useRef(true);
  useEffect(() => { boundaryVisibleRef.current = boundaryVisible; }, [boundaryVisible]);
  const [seqArmed, setSeqArmed] = useState(false); // true: 시계방향 순차 픽 모드 ON (한 번 시작하면 4 클릭 받기까지)
  const [error, setError] = useState<string | null>(null);
  const [showMarkers, setShowMarkers] = useState(true);

  // ── basemap 4 코너 (JSON 입력) ──
  const [basemapJson, setBasemapJson] = useState<string>(() => loadBasemapJson(uploadId));
  const basemapCorners = useMemo<Vec3[] | null>(() => parseBasemapCorners(basemapJson), [basemapJson]);

  // ── basemap PLY URL (입력 → 자동 로드) ──
  const [basemapUrl, setBasemapUrl] = useState<string>(() => loadBasemapUrl(uploadId));
  // 부모가 sharedAdditional 을 넘기면 그 인스턴스 사용 (도어 splat 이 모달 언마운트 후에도 살아남음).
  // 안 넘기면 (레거시) 자체 인스턴스 — 언마운트 시 entity destroy 되는 옛 동작 유지.
  const ownAdditional = useAdditionalGsplats(coreRef);
  const additional = sharedAdditional ?? ownAdditional;
  const basemapIdRef = useRef<string | null>(null);

  // URL 변경 → 이전 basemap 제거하고 새로 add
  useEffect(() => {
    const url = basemapUrl.trim();
    // 이전 것 정리
    if (basemapIdRef.current) {
      additional.remove(basemapIdRef.current);
      basemapIdRef.current = null;
    }
    if (!url || !/^https?:\/\//.test(url)) return;
    const { id, ready } = additional.add(url);
    if (id) basemapIdRef.current = id;
    // basemap 은 await 안 함 — 백그라운드 로딩, 실패는 items[].error 로 표시.
    ready.catch(() => { /* 표시는 items 에서 */ });
  }, [basemapUrl, additional]);

  // ── 정합 상태 ──
  const [rmsd, setRmsd] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [aligned, setAligned] = useState(false); // 애니메이션 한 번이라도 성공했는지

  // ── 애니메이션 상태 ──
  const animRef = useRef<{
    start: number;
    duration: number;
    fromPos: [number, number, number];
    fromQuat: [number, number, number, number];  // x,y,z,w
    toPos: [number, number, number];
    toQuat: [number, number, number, number];
  } | null>(null);

  // 매 프레임 보간 적용
  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    return core.onUpdate(() => {
      const a = animRef.current;
      if (!a) return;
      const sd = core.getSplatData();
      const pc = core.getPC();
      if (!sd || !pc) return;
      const prog = Math.min(1, (performance.now() - a.start) / a.duration);
      const u = easeInOutCubic(prog);
      // lerp position
      const px = a.fromPos[0] + (a.toPos[0] - a.fromPos[0]) * u;
      const py = a.fromPos[1] + (a.toPos[1] - a.fromPos[1]) * u;
      const pz = a.fromPos[2] + (a.toPos[2] - a.fromPos[2]) * u;
      // slerp quaternion (PlayCanvas Quat은 xyzw)
      const qa = new pc.Quat(a.fromQuat[0], a.fromQuat[1], a.fromQuat[2], a.fromQuat[3]);
      const qb = new pc.Quat(a.toQuat[0], a.toQuat[1], a.toQuat[2], a.toQuat[3]);
      const qOut = new pc.Quat();
      qOut.slerp(qa, qb, u);
      sd.splatEntity.setLocalPosition(px, py, pz);
      sd.splatEntity.setLocalRotation(qOut.x, qOut.y, qOut.z, qOut.w);
      if (prog >= 1) animRef.current = null;
    });
  }, [coreRef]);

  // ── 다듬기에서 저장한 벽/천장/바닥 → ceiling/floor + N벽 평면 ──
  const planes = useMemo<SurfacePlane[] | null>(() => {
    const st = loadRefineState(uploadId);
    if (!st) return null;
    if (!st.cfConfirmed || !st.wallConfirmed) return null;
    if (!st.wallPolygon) return null;
    const out = surfacePlanesFromPolygon({
      polygon: st.wallPolygon,
      ceilingY: st.ceilingY,
      floorY: st.floorY,
    });
    console.log(`[planes] polygon N=${st.wallPolygon.length}`);
    for (const p of out) {
      const segStr = p.segment
        ? `seg=(${p.segment.a.x.toFixed(2)},${p.segment.a.z.toFixed(2)})→(${p.segment.b.x.toFixed(2)},${p.segment.b.z.toFixed(2)}) y[${p.segment.yMin.toFixed(2)},${p.segment.yMax.toFixed(2)}]`
        : 'seg=none';
      console.log(`  ${p.id.padEnd(8)} n=(${p.normal[0].toFixed(3)},${p.normal[1].toFixed(3)},${p.normal[2].toFixed(3)}) d=${p.d.toFixed(3)} ${segStr}`);
    }
    return out;
  }, [uploadId]);
  const showRefineGuide = !planes && !(basemapMode && view === 'setup');

  // SAM3 자동 추출 완료 시 부모가 넘겨준 4 코너로 picked 초기 채움.
  // autoExtractedCorners 는 raw 프레임 — UnifiedSplatEditor 가 SAM3 응답(A'+Y)에 ayToRaw 를 미리
  // 적용해 메모리 컨벤션(raw)으로 통일한 뒤 전달. picked.pos contract 도 raw (raycastToPlanes 가
  // splatEntity 역변환으로 산출) → 추가 변환 없이 그대로 대입.
  // surfaceId 는 closest-plane 추정: picked.pos 가 raw 이고 planes 는 A' 프레임이라
  // rawToA 로 lift 한 뒤 6면 중 |signed_distance| 최소 평면 선택. 4 코너는 모두 같은 벽 위라
  // ref 한 점이면 충분. 추정한 surfaceId 가 비면 후속 applyDoorRefine/Rotation 의 wallPlane lookup
  // 이 모두 실패 → 문 추출 mesh ops 와 문 열기 회전이 silent 로 무반응 되는 회귀를 차단.
  useEffect(() => {
    if (!autoExtractedCorners || autoExtractedCorners.length !== 4) return;
    if (!planes) return;
    setPicked(prev => {
      const allEmpty = prev.every(p => p === null);
      if (!allEmpty) return prev;
      const r = getEditorRotation(uploadId);
      const ref = autoExtractedCorners[0];
      const refA = rawToA([ref[0], ref[1], ref[2]] as Vec3, r);
      let bestSd = Infinity;
      let bestId = '';
      for (const p of planes) {
        const sd = Math.abs(p.normal[0]*refA[0] + p.normal[1]*refA[1] + p.normal[2]*refA[2] - p.d);
        if (sd < bestSd) { bestSd = sd; bestId = p.id; }
      }
      return autoExtractedCorners.map(c => ({
        pos: [c[0], c[1], c[2]] as Vec3,
        surfaceId: bestId,
      }));
    });
  }, [autoExtractedCorners, planes, uploadId]);

  // ── ray-plane 교점 (raw 프레임) ──
  // 클릭은 "평면 위의 점" 으로만 떨어진다 (가우시안 위치가 아니라 수학적 평면 교점).
  // forcePlaneId 가 주어지면 그 평면 하나에만 투영 — 4 코너가 같은 면 위에 있도록 보장.
  // (없으면 N+2 개 평면 중 ray 가 가장 먼저 만나는 평면 — 첫 코너 픽 용도.)
  //
  // 좌표 프레임 정합:
  //   `splatEntity.worldTransform` = Z-180 · Rz(rotZ) · Rx(rotX) (pendingRotation 포함).
  //   inv 적용 결과는 raw 프레임 점/방향. surfacePlanesFromPolygon 의 평면들은 A' 프레임 (= raw + pendingRotation) 에서 정의됨
  //   (CeilingFloorModal 에서 잡은 ceilingY, WallModal 에서 잡은 wallPolygon 이 모두 A' 기준).
  //   따라서 평면 테스트 전에 ray O, D 를 pendingRotation 으로 다시 회전 (raw → A') 해 t 를 정확히 산출.
  //   최종 점은 raw 프레임으로 반환 — 다른 코드 (rendering, persist 등) 가 raw 가정.
  const raycastToPlanes = useCallback((mouseX: number, mouseY: number, forcePlaneId?: string): PickedCorner | null => {
    if (!planes) return null;
    const core = coreRef.current;
    const cam = core?.getCamera()?.camera;
    const sd = core?.getSplatData();
    const pc = core?.getPC();
    if (!cam || !sd || !pc) return null;

    // world frame ray
    const nearW = new pc.Vec3();
    const farW = new pc.Vec3();
    cam.screenToWorld(mouseX, mouseY, cam.nearClip, nearW);
    cam.screenToWorld(mouseX, mouseY, cam.farClip, farW);

    // world → raw (splatEntity의 worldTransform 역변환)
    const inv = new pc.Mat4().copy(sd.splatEntity.getWorldTransform()).invert();
    const nearR = new pc.Vec3();
    const farR = new pc.Vec3();
    inv.transformPoint(nearW, nearR);
    inv.transformPoint(farW, farR);

    const ox = nearR.x, oy = nearR.y, oz = nearR.z;
    let dx = farR.x - ox, dy = farR.y - oy, dz = farR.z - oz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    // pendingRotation 으로 ray 를 A' 프레임으로 lift — 평면 식과 동일 프레임에서 t 산출.
    const r = getEditorRotation(uploadId);
    const [oxA, oyA, ozA] = rawToA([ox, oy, oz], r);
    const [dxA, dyA, dzA] = rawToA([dx, dy, dz], r);

    if (forcePlaneId) {
      // 잠금된 평면에만 투영 — t 의 부호 무관 (카메라 뒤로 가는 방향이어도 평면 위 점 보장).
      const p = planes.find(pl => pl.id === forcePlaneId);
      if (!p) return null;
      const denom = p.normal[0]*dxA + p.normal[1]*dyA + p.normal[2]*dzA;
      if (Math.abs(denom) < 1e-6) return null;
      const numer = p.d - (p.normal[0]*oxA + p.normal[1]*oyA + p.normal[2]*ozA);
      const t = numer / denom;
      const pos: Vec3 = [ox + dx*t, oy + dy*t, oz + dz*t];
      return { pos, surfaceId: p.id };
    }

    // 가장 작은 양수 t 채택 (첫 코너용).
    // ⚠ 벽 plane 은 무한 plane 이라 N-각형 (특히 비스듬한 벽 / concave) 에서 같은 ray 가 여러 벽 plane 을
    // 양수 t 로 교차할 수 있다. 사용자가 보고 있지 않은 벽이 더 작은 t 로 채택되면 도어 코너가 잘못된
    // 위치 (방 안쪽 / 다른 벽) 에 박힘. → 벽 plane 은 segment(edge 양 끝점 + ceiling/floor Y범위) 안에
    // 교점이 들어올 때만 후보로 인정. 천장/바닥은 segment 없음 — 그대로 무한 plane 으로 처리 (polygon
    // mask 가 외곽 처리). 픽 좌표는 raw 프레임이지만 segment 는 A' 프레임 기준 — 교점도 A' 로 변환.
    let bestT = Infinity;
    let bestId = '';
    let bestPoint: Vec3 | null = null;
    const diag: Array<{ id: string; t: number; s?: number; sOK?: boolean; yOK?: boolean; iy?: number; reason: string }> = [];
    for (const p of planes) {
      const denom = p.normal[0]*dxA + p.normal[1]*dyA + p.normal[2]*dzA;
      if (Math.abs(denom) < 1e-6) { diag.push({ id: p.id, t: NaN, reason: 'parallel' }); continue; }
      const numer = p.d - (p.normal[0]*oxA + p.normal[1]*oyA + p.normal[2]*ozA);
      const t = numer / denom;
      if (t <= 0) { diag.push({ id: p.id, t, reason: 'behind' }); continue; }
      // 벽 plane segment 체크: A' 프레임의 교점이 edge ab 의 길이방향 [0, 1] 안 + Y 가 ceiling/floor
      // 사이에 있어야 그 벽이라고 인정. tolerance 5cm — picking 부정확성 흡수.
      if (p.segment) {
        const ix = oxA + dxA*t, iy = oyA + dyA*t, iz = ozA + dzA*t;
        const ax = p.segment.a.x, az = p.segment.a.z;
        const ex = p.segment.b.x - ax, ez = p.segment.b.z - az;
        const eLen2 = ex*ex + ez*ez || 1;
        const s = ((ix - ax)*ex + (iz - az)*ez) / eLen2;
        // tolerance 없음 — 교점이 segment [0, 1] 안 + Y 가 [floor, ceiling] 안일 때만 그 벽 인정.
        // (인접 벽 vertex 공유 corner 에서 옆 벽 plane 의 연장이 통과되는 것을 막기 위해 엄격하게 가져감.
        //  vertex 정확히 클릭하는 케이스도 어느 한 벽으로 떨어지면 그쪽이 됨.)
        const sOK = s >= 0 && s <= 1;
        const yOK = iy >= p.segment.yMin && iy <= p.segment.yMax;
        if (!sOK || !yOK) { diag.push({ id: p.id, t, s, sOK, yOK, iy, reason: !sOK ? 'seg-out' : 'y-out' }); continue; }
        diag.push({ id: p.id, t, s, sOK, yOK, iy, reason: 'OK' });
      } else {
        diag.push({ id: p.id, t, reason: 'OK(no-seg)' });
      }
      if (t >= bestT) continue;
      bestT = t; bestId = p.id;
      bestPoint = [ox + dx*t, oy + dy*t, oz + dz*t];
    }
    console.log(`[raycastPick] → picked=${bestId} bestT=${bestT.toFixed(3)}`);
    for (const d of diag) {
      console.log(`  ${d.id.padEnd(8)} t=${isNaN(d.t)?'  NaN ':d.t.toFixed(3).padStart(7)}` +
        (d.s !== undefined ? ` s=${d.s.toFixed(3).padStart(7)} sOK=${d.sOK?'Y':'N'} yOK=${d.yOK?'Y':'N'} iy=${d.iy!.toFixed(2)}` : '') +
        ` reason=${d.reason}`);
    }
    if (!bestPoint) return null;
    return { pos: bestPoint, surfaceId: bestId };
  }, [coreRef, planes, uploadId]);

  // ── 순차 픽 클릭 + ESC 취소 (seqArmed 상태일 때만) ──
  // 픽 순서: CORNERS index 순 = TL(0) → TR(1) → BR(2) → BL(3) (시계방향).
  // 한 번 켜지면 첫 null 인덱스부터 차례로 채움. 마지막 BL 까지 채우면 자동 OFF.
  // ESC 누르면 즉시 취소.
  useEffect(() => {
    if (!seqArmed) return;
    const core = coreRef.current;
    const canvas = core?.getCanvas();
    if (!canvas) return;

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) return;
      setPicked(prev => {
        // 첫 null 슬롯 — 순차 모드에선 항상 다음 빈자리로.
        const targetIdx = prev.findIndex(p => p === null);
        if (targetIdx < 0) return prev;
        // 다른 슬롯의 surfaceId 가 있으면 같은 면 위에 잠금.
        const lockedSurfaceId = prev.find((p, i) => i !== targetIdx && p && p.surfaceId)?.surfaceId;
        const result = raycastToPlanes(mx, my, lockedSurfaceId);
        if (!result) { setError('평면과 교점을 찾지 못했습니다'); return prev; }
        let next = [...prev];
        next[targetIdx] = result;
        // 4 번째 픽이 끝나면 순차 모드 종료 + 직사각형 정규화 (위/아래 변 수평, 직사각형 유지).
        if (next.every(p => p !== null)) {
          setSeqArmed(false);
          const wallPlane = planes?.find(p => p.id === next[0]!.surfaceId);
          if (wallPlane) {
            const normalized = normalizeDoorRect(
              [next[0]!.pos, next[1]!.pos, next[2]!.pos, next[3]!.pos],
              wallPlane,
              null,
              getEditorRotation(uploadId),
            );
            next = next.map((p, i) => p ? { pos: normalized[i], surfaceId: p.surfaceId } : null);
          }
        }
        setError(null);
        return next;
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 진행 중이던 픽 전부 초기화 — 부분 입력 그대로 두지 않음.
        setSeqArmed(false);
        setPicked(emptyPicked());

        setError(null);
      }
    };
    canvas.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKey);
    return () => {
      canvas.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [seqArmed, coreRef, raycastToPlanes, uploadId]);

  // ── DOM 라벨 (코너 4개) ──
  const labelsRef = useRef<Array<HTMLDivElement | null>>([null, null, null, null]);
  useEffect(() => {
    const core = coreRef.current;
    const container = core?.getContainer();
    if (!container) return;

    const els: HTMLDivElement[] = [];
    for (let i = 0; i < 4; i++) {
      const c = CORNERS[i];
      const el = document.createElement('div');
      // 라벨 컨테이너 — 텍스트는 클릭 안 받지만 자식 dot 은 별도로 pointer-events:auto.
      el.style.cssText = 'position:absolute;pointer-events:none;display:none;transform:translate(-50%,-100%);text-align:center;z-index:30;';

      const text = document.createElement('div');
      text.textContent = c.label;
      text.style.cssText = `font-size:11px;font-weight:bold;color:${c.hex};text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;margin-bottom:3px;pointer-events:none;`;
      el.appendChild(text);

      const dot = document.createElement('div');
      dot.style.cssText = `width:11px;height:11px;background:${c.hex};border:1.5px solid #fff;border-radius:50%;margin:0 auto;box-shadow:0 0 4px rgba(0,0,0,0.8);pointer-events:auto;cursor:grab;transition:transform 120ms ease-out;`;
      // hover → 살짝 커지고, 드래그 시작 시에도 큰 상태 유지 (mouseleave 무시).
      dot.addEventListener('mouseenter', () => { dot.style.transform = 'scale(1.6)'; });
      dot.addEventListener('mouseleave', () => {
        if (dragIdxRef.current !== i) dot.style.transform = 'scale(1)';
      });
      dot.addEventListener('mousedown', (e) => {
        // 순차 픽 진행 중엔 드래그 차단 (캔버스 클릭이 새 점을 찍어야 하므로).
        if (seqArmedRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        dot.style.cursor = 'grabbing';
        setDragIdx(i);
      });
      el.appendChild(dot);

      container.appendChild(el);
      els.push(el);
    }
    labelsRef.current = els;
    return () => {
      els.forEach(e => { try { e.remove(); } catch {} });
      labelsRef.current = [null, null, null, null];
    };
  }, [coreRef]);

  // ── 매 프레임 라벨 위치 업데이트 (worldToScreen) ──
  const pickedRef = useRef(picked);
  useEffect(() => { pickedRef.current = picked; }, [picked]);
  const showMarkersRef = useRef(showMarkers);
  useEffect(() => { showMarkersRef.current = showMarkers; }, [showMarkers]);
  // 코너 점 드래그 (수동 픽 후 위치 미세 조정).
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const dragIdxRef = useRef<number | null>(null);
  useEffect(() => { dragIdxRef.current = dragIdx; }, [dragIdx]);
  // 순차 픽 모드일 땐 드래그 비활성화 — dot mousedown 핸들러에서 참조.
  const seqArmedRef = useRef(seqArmed);
  useEffect(() => { seqArmedRef.current = seqArmed; }, [seqArmed]);

  // ── 회전축 변 상태 (line/cylinder/edge-pick 효과 블록이 참조) ──
  // 힌지는 사각형의 4 변 중 하나 (edge 인덱스 0..3 ; e=0: P0→P1 ... e=3: P3→P0).
  // hingeEdge null = 미선택. hingeIndices 는 hingeEdge 로부터 useMemo 로 파생.
  const [hingeEdge, setHingeEdge] = useState<number | null>(null);
  const hingeEdgeRef = useRef<number | null>(null);
  useEffect(() => { hingeEdgeRef.current = hingeEdge; }, [hingeEdge]);
  const [edgePickArmed, setEdgePickArmed] = useState(false);
  const edgePickArmedRef = useRef(false);
  useEffect(() => { edgePickArmedRef.current = edgePickArmed; }, [edgePickArmed]);
  const hoveredEdgeRef = useRef<number | null>(null);

  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    const off = core.onUpdate(() => {
      const sd = core.getSplatData();
      const cam = core.getCamera()?.camera;
      const pc = core.getPC();
      if (!sd || !cam || !pc) return;

      const m = sd.splatEntity.getWorldTransform();
      const tmpRaw = new pc.Vec3();
      const tmpWorld = new pc.Vec3();
      const tmpScreen = new pc.Vec3();

      for (let i = 0; i < 4; i++) {
        const label = labelsRef.current[i];
        if (!label) continue;
        const p = pickedRef.current[i];
        if (!p || !showMarkersRef.current) { label.style.display = 'none'; continue; }
        // raw → world
        tmpRaw.set(p.pos[0], p.pos[1], p.pos[2]);
        m.transformPoint(tmpRaw, tmpWorld);
        cam.worldToScreen(tmpWorld, tmpScreen);
        // 카메라 뒤(z<0)면 숨김
        if (tmpScreen.z < 0) { label.style.display = 'none'; continue; }
        label.style.display = 'block';
        label.style.left = `${tmpScreen.x}px`;
        label.style.top = `${tmpScreen.y}px`;
      }
    });
    return off;
  }, [coreRef]);

  const clearAll = () => {
    const empty: Array<PickedCorner | null> = [null, null, null, null];
    setPicked(empty);
    void clearDoorsOnServer(uploadId);
    setSeqArmed(false);
  };

  // ── 회전축 변 선택 모드 (edgePickArmed) — 캔버스 mousemove 로 가까운 변 탐지, mouseup 으로 선택 확정 ──
  useEffect(() => {
    if (!edgePickArmed) return;
    const core = coreRef.current;
    const canvas = core?.getCanvas();
    if (!canvas) return;
    const HOVER_THRESHOLD = 16; // px

    // 화면 좌표 점-선분 거리.
    const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay;
      const len2 = dx*dx + dy*dy;
      if (len2 === 0) return Math.hypot(px - ax, py - ay);
      let t = ((px - ax)*dx + (py - ay)*dy) / len2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (ax + t*dx), py - (ay + t*dy));
    };

    const computeHovered = (mx: number, my: number): number | null => {
      const sd = core?.getSplatData();
      const cam = core?.getCamera()?.camera;
      const pc = core?.getPC();
      if (!sd || !cam || !pc) return null;
      const ps = pickedRef.current;
      if (!ps.every(p => p !== null)) return null;
      const m = sd.splatEntity.getWorldTransform();
      const tmpRaw = new pc.Vec3();
      const tmpWorld = new pc.Vec3();
      const tmpScreen = new pc.Vec3();
      const screen: Array<{ x: number; y: number; z: number }> = [];
      for (let i = 0; i < 4; i++) {
        const p = ps[i]!;
        tmpRaw.set(p.pos[0], p.pos[1], p.pos[2]);
        m.transformPoint(tmpRaw, tmpWorld);
        cam.worldToScreen(tmpWorld, tmpScreen);
        screen.push({ x: tmpScreen.x, y: tmpScreen.y, z: tmpScreen.z });
      }
      let bestE = -1, bestD = Infinity;
      for (let e = 0; e < 4; e++) {
        const a = screen[e], b = screen[(e + 1) % 4];
        if (a.z < 0 || b.z < 0) continue; // 카메라 뒤
        const d = distToSegment(mx, my, a.x, a.y, b.x, b.y);
        if (d < bestD) { bestD = d; bestE = e; }
      }
      return bestD <= HOVER_THRESHOLD ? bestE : null;
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      hoveredEdgeRef.current = computeHovered(mx, my);
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) return;
      const hov = computeHovered(mx, my);
      if (hov === null) return; // 변 근처가 아니면 선택 무시 (re-arm 하려면 패널 버튼 다시 누르기).
      setHingeEdge(hov);
      hoveredEdgeRef.current = null;
      setEdgePickArmed(false);
    };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onUp);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseup', onUp);
      hoveredEdgeRef.current = null;
    };
  }, [edgePickArmed, coreRef]);

  // 코너 dot 드래그 — 윈도 mousemove/mouseup 으로 따라가며 raycast 로 평면 위 새 위치 계산.
  // 같은 surfaceId 평면에 잠그므로 평면 위에서만 이동. 노란 선은 outline useEffect 가
  // pickedRef.current 를 매 프레임 읽어 자동으로 따라옴.
  useEffect(() => {
    if (dragIdx === null) return;
    const core = coreRef.current;
    const canvas = core?.getCanvas();
    if (!canvas) return;
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) return;
      setPicked(prev => {
        const cur = prev[dragIdx];
        if (!cur) return prev;
        // 자기 자신 제외하고 다른 픽의 surfaceId 가 있으면 그걸 강제 (4 코너가 같은 면 위에 있도록).
        const lockedSurfaceId =
          prev.find((p, i) => i !== dragIdx && p && p.surfaceId)?.surfaceId
          ?? cur.surfaceId;
        const result = raycastToPlanes(mx, my, lockedSurfaceId);
        if (!result) return prev;
        let next = [...prev];
        next[dragIdx] = { pos: result.pos, surfaceId: cur.surfaceId };
        // 4 코너가 모두 차 있으면 드래그 중에도 직사각형 정규화 — 대각선 반대 코너 anchor, 나머지 두 코너 자동 재계산.
        if (next.every(p => p !== null)) {
          const wallPlane = planes?.find(p => p.id === lockedSurfaceId);
          if (wallPlane) {
            const normalized = normalizeDoorRect(
              [next[0]!.pos, next[1]!.pos, next[2]!.pos, next[3]!.pos],
              wallPlane,
              dragIdx,
              getEditorRotation(uploadId),
            );
            next = next.map((p, i) => p ? { pos: normalized[i], surfaceId: p.surfaceId } : null);
          }
        }
        return next;
      });
    };
    const onUp = () => {
      // dot cursor 원복 + scale 복귀 (mouse 가 다른 곳에 있을 수 있음).
      const labels = labelsRef.current;
      const label = labels[dragIdx];
      if (label) {
        const dot = label.lastElementChild as HTMLDivElement | null;
        if (dot) {
          dot.style.cursor = 'grab';
          dot.style.transform = 'scale(1)';
        }
      }
      setDragIdx(null);
      // 자동 저장 제거 — 문 설정 완료 시점에 일괄 처리.
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragIdx, coreRef, raycastToPlanes, uploadId]);

  // 노란 사각형 (코너 4개 잇는 변) 매 프레임 렌더.
  //   기본: 4 변 모두 노란 실선.
  //   회전축 변 선택 armed (edgePickArmed): 4 변 모두 노란 점선. hover 강조는 별도 cylinder entity 가 담당.
  // pickedRef 를 매 프레임 읽어 드래그 중에도 즉시 반영 (re-render 없이 부드럽게).
  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    return core.onUpdate(() => {
      // 문 경계 표시 토글이 OFF 면 4 변 노란선 그리지 않음.
      if (!boundaryVisibleRef.current) return;
      const pcLib = core.getPC();
      const app = core.getApp();
      const sd = core.getSplatData();
      if (!pcLib || !app || !sd?.splatEntity) return;
      const ps = pickedRef.current;
      const yellow = new pcLib.Color(1, 1, 0);
      const yellowDim = new pcLib.Color(1, 1, 0, 0.6);
      // raw → world 는 splatEntity.worldTransform 사용 — Z-180 + pendingRotation 모두 반영.
      const m = sd.splatEntity.getWorldTransform();
      const toWorld = (p: Vec3): any => {
        const tmp = new pcLib.Vec3(p[0], p[1], p[2]);
        const out = new pcLib.Vec3();
        m.transformPoint(tmp, out);
        return out;
      };
      const armed = edgePickArmedRef.current;
      const drawDashed = (a: any, b: any) => {
        const dashLen = 0.08, gapLen = 0.05;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const total = Math.hypot(dx, dy, dz) || 1;
        const nx = dx / total, ny = dy / total, nz = dz / total;
        let t = 0;
        while (t < total) {
          const s = t;
          const f = Math.min(t + dashLen, total);
          const p0 = new pcLib.Vec3(a.x + nx*s, a.y + ny*s, a.z + nz*s);
          const p1 = new pcLib.Vec3(a.x + nx*f, a.y + ny*f, a.z + nz*f);
          app.drawLine(p0, p1, yellowDim, false);
          t = f + gapLen;
        }
      };
      for (let e = 0; e < 4; e++) {
        const a = ps[e], b = ps[(e + 1) % 4];
        if (!a || !b) continue;
        const aw = toWorld(a.pos), bw = toWorld(b.pos);
        if (armed) drawDashed(aw, bw);
        else app.drawLine(aw, bw, yellow, false);
      }
    });
  }, [coreRef]);

  // ── 힌지 cylinder entity ──
  // 한 번만 생성. 매 프레임 active edge 따라 위치/회전/스케일 갱신:
  //   armed: hovered edge (preview) — hover 한 변 위에 cylinder 표시.
  //   not armed: hingeEdge (selected) — 확정된 변 위에 cylinder 표시.
  // 둘 다 없으면 disabled.
  // 재질은 opaque + custom layer ('HingeOverlay') 로 splat 보다 나중에 렌더 → 반투명 안 됨.
  useEffect(() => {
    const core = coreRef.current;
    const app = core?.getApp();
    const pcLib = core?.getPC();
    if (!app || !pcLib) return;

    // splat 위에 항상 그리려고 별도 layer 추가. 이미 있으면 재사용.
    let hingeLayer = app.scene.layers.getLayerByName('HingeOverlay');
    if (!hingeLayer) {
      hingeLayer = new pcLib.Layer({
        name: 'HingeOverlay',
        opaqueSortMode: pcLib.SORTMODE_NONE,
        transparentSortMode: pcLib.SORTMODE_NONE,
      });
      app.scene.layers.push(hingeLayer);
      // 모든 카메라의 layers 에 추가 — 안 그러면 안 그려짐.
      const cams = app.root.findComponents('camera');
      for (const cam of cams) cam.layers = [...cam.layers, hingeLayer.id];
    }

    const cyl = new pcLib.Entity('hingeCylinder');
    cyl.addComponent('render', { type: 'cylinder' });
    if (cyl.render) cyl.render.layers = [hingeLayer.id];
    const mat = new pcLib.StandardMaterial();
    // Tailwind bg-yellow-500 (#eab308) — 회전축 선택 버튼 색과 동일.
    mat.diffuse = new pcLib.Color(0.918, 0.702, 0.031);
    mat.emissive = new pcLib.Color(0.918, 0.702, 0.031);
    mat.useLighting = false;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.update();
    cyl.render.material = mat;
    cyl.enabled = false;
    app.root.addChild(cyl);

    const off = core!.onUpdate(() => {
      // 문 경계 표시 토글이 OFF 면 cylinder 도 숨김.
      if (!boundaryVisibleRef.current) { cyl.enabled = false; return; }
      const ps = pickedRef.current;
      const armed = edgePickArmedRef.current;
      const e = armed ? hoveredEdgeRef.current : hingeEdgeRef.current;
      if (e === null) { cyl.enabled = false; return; }
      const a = ps[e];
      const b = ps[(e + 1) % 4];
      if (!a || !b) { cyl.enabled = false; return; }
      // raw → world: splatEntity.worldTransform 사용 — Z-180 + pendingRotation 모두 반영.
      const sd = core!.getSplatData();
      if (!sd?.splatEntity) { cyl.enabled = false; return; }
      const m = sd.splatEntity.getWorldTransform();
      const aRaw = new pcLib.Vec3(a.pos[0], a.pos[1], a.pos[2]);
      const bRaw = new pcLib.Vec3(b.pos[0], b.pos[1], b.pos[2]);
      const aW = new pcLib.Vec3(); m.transformPoint(aRaw, aW);
      const bW = new pcLib.Vec3(); m.transformPoint(bRaw, bW);
      const ax = aW.x, ay = aW.y, az = aW.z;
      const bx = bW.x, by = bW.y, bz = bW.z;
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const length = Math.hypot(dx, dy, dz);
      if (length < 1e-4) { cyl.enabled = false; return; }
      cyl.enabled = true;
      cyl.setPosition((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      const nx = dx / length, ny = dy / length, nz = dz / length;
      // 기본 cylinder 축 = +Y. q: rotation that maps (0,1,0) → (nx,ny,nz).
      const q = new pcLib.Quat();
      if (ny > 0.999999) {
        q.setFromEulerAngles(0, 0, 0);
      } else if (ny < -0.999999) {
        q.setFromAxisAngle(new pcLib.Vec3(1, 0, 0), 180);
      } else {
        // axis = upY × dir, normalized. upY=(0,1,0). axis = (nz, 0, -nx) 정규화.
        const axLen = Math.hypot(nz, nx) || 1;
        const axis = new pcLib.Vec3(nz / axLen, 0, -nx / axLen);
        const ang = Math.acos(ny) * 180 / Math.PI;
        q.setFromAxisAngle(axis, ang);
      }
      cyl.setRotation(q);
      const radius = 0.03;
      cyl.setLocalScale(radius * 2, length, radius * 2);
    });

    return () => {
      off();
      try { cyl.destroy(); } catch {}
    };
  }, [coreRef]);

  const allPicked = picked.every(p => p !== null);

  // ── 텍스처맵 저장 (디버그) ──
  // 6개 wall mesh + 1개 도어 영역 = 총 7개 PNG 다운로드. 사용자 Downloads 폴더로.
  const downloadRgbaAsPng = async (rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, filename: string): Promise<void> => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.createImageData(w, h);
    const len = Math.min(imageData.data.length, rgba.length);
    for (let i = 0; i < len; i++) imageData.data[i] = rgba[i];
    ctx.putImageData(imageData, 0, 0);
    return new Promise<void>((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) { resolve(); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        resolve();
      }, 'image/png');
    });
  };

  // GPU 텍스처에서 픽셀을 직접 읽기 — 서버 로드 텍스처는 lock() 으로 못 읽음 (CPU side 없음).
  // 임시 framebuffer 에 첨부해 gl.readPixels.
  const readTextureFromGPU = (tex: any, app: any): { rgba: Uint8ClampedArray; w: number; h: number } | null => {
    const w = tex.width, h = tex.height;
    if (!w || !h) return null;
    const device = app.graphicsDevice;
    const gl = device?.gl;
    if (!gl) return null;
    const glTex = tex.impl?._glTexture ?? tex._impl?._glTexture ?? tex._glTexture;
    if (!glTex) return null;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glTex, 0);
    let rgba: Uint8ClampedArray | null = null;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status === gl.FRAMEBUFFER_COMPLETE) {
      const tmp = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
      // readPixels 는 bottom-up. canvas 그리기는 top-down 이므로 row flip.
      const flipped = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const srcOff = (h - 1 - y) * w * 4;
        const dstOff = y * w * 4;
        for (let i = 0; i < w * 4; i++) flipped[dstOff + i] = tmp[srcOff + i];
      }
      rgba = flipped;
    } else {
      console.warn(`[SaveTex] FB incomplete: 0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return rgba ? { rgba, w, h } : null;
  };

  const saveAllTextureMaps = async () => {
    const core = coreRef.current;
    const app = core?.getApp();
    if (!core || !app || !allPicked || !planes) {
      console.warn('[SaveTex] prerequisites not met');
      return;
    }

    // 1. Wall mesh 저장 — ceiling/floor + 폴리곤 변 수만큼의 w0..w(N-1).
    const surfaces: string[] = ['ceiling', 'floor'];
    if (planes) {
      for (const p of planes) {
        if (/^w\d+$/.test(p.id)) surfaces.push(p.id);
      }
    }
    for (const sid of surfaces) {
      const ent = findEntityByName(app.root, `wallMesh_${sid}`);
      const tex = ent?.render?.meshInstances?.[0]?.material?.emissiveMap;
      if (!tex) {
        console.warn(`[SaveTex] wallMesh_${sid} not found in app.root`);
        continue;
      }
      const result = readTextureFromGPU(tex, app);
      if (!result) {
        console.warn(`[SaveTex] wallMesh_${sid} GPU read failed`);
        continue;
      }
      const { rgba, w, h } = result;
      let rmin = 255, rmax = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i] < rmin) rmin = rgba[i];
        if (rgba[i] > rmax) rmax = rgba[i];
      }
      console.log(`[SaveTex] wallMesh_${sid}: ${w}×${h}, alpha=0 pixels: ${countAlpha0(rgba)}, R range=[${rmin},${rmax}]`);
      await downloadRgbaAsPng(rgba, w, h, `wallMesh_${sid}.png`);
    }

    // 2. 도어 영역 저장 — 문 추출 활성 상태면 기존 mesh, 아니면 fresh bake
    const doorSurfaceId = picked[0]!.surfaceId;
    if (doorMeshEntityRef.current) {
      const tex = doorMeshEntityRef.current.render?.meshInstances?.[0]?.material?.emissiveMap;
      if (tex) {
        const lvl = tex.lock();
        if (lvl) {
          const w = tex.width, h = tex.height;
          const rgba = new Uint8ClampedArray(w * h * 4);
          const lim = Math.min(rgba.length, (lvl as any).length ?? 0);
          for (let i = 0; i < lim; i++) rgba[i] = (lvl as any)[i];
          tex.unlock();
          console.log(`[SaveTex] doorMesh_${doorSurfaceId}: ${w}×${h}`);
          await downloadRgbaAsPng(rgba, w, h, `doorMesh_${doorSurfaceId}.png`);
        } else {
          try { tex.unlock(); } catch {}
        }
      }
    } else {
      // Fresh bake
      try {
        const wallPlane = planes.find(p => p.id === doorSurfaceId);
        if (!wallPlane) throw new Error('wall plane not found');
        const projectFn = (p: Vec3): Vec3 => {
          const n = wallPlane.normal;
          const sdv = n[0]*p[0]+n[1]*p[1]+n[2]*p[2] - wallPlane.d;
          return [p[0]-sdv*n[0], p[1]-sdv*n[1], p[2]-sdv*n[2]];
        };
        const corners: [Vec3, Vec3, Vec3, Vec3] = [
          projectFn(picked[0]!.pos),
          projectFn(picked[1]!.pos),
          projectFn(picked[2]!.pos),
          projectFn(picked[3]!.pos),
        ];
        if (!cachedSceneRef.current) {
          const { fetchAndParsePly } = await import('@/lib/ply');
          cachedSceneRef.current = await fetchAndParsePly(currentUrl);
        }
        const { decomposeBoundaryGaussians, doorPlaneBakeInput } = await import('@/lib/gs/doorTrim');
        const decomp = decomposeBoundaryGaussians(cachedSceneRef.current, { corners }, {
          safetyMargin: DOOR_SAFETY_MARGIN,
          doorThickness,
        });
        const { filterScene } = await import('@/lib/ply');
        const keepDoor = new Uint8Array(cachedSceneRef.current.numSplats);
        for (const i of decomp.doorOriginalIndices) keepDoor[i] = 1;
        const doorScene = filterScene(cachedSceneRef.current, keepDoor);
        const { bakeTextureForPlane } = await import('@/lib/gs/textureBake');
        const bakeInput = doorPlaneBakeInput(corners, wallPlane.normal);
        const doorBake = await bakeTextureForPlane(bakeInput, doorScene, { depthGate: DOOR_BAKE_GATE });
        console.log(`[SaveTex] doorRegion_${doorSurfaceId}: ${doorBake.width}×${doorBake.height} (fresh bake)`);
        await downloadRgbaAsPng(doorBake.rgba, doorBake.width, doorBake.height, `doorRegion_${doorSurfaceId}.png`);
      } catch (e) {
        console.error('[SaveTex] door fresh bake failed:', e);
      }
    }
    console.log('[SaveTex] DONE — 7 PNG files in Downloads');
  };

  const countAlpha0 = (rgba: Uint8ClampedArray): number => {
    let n = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 0) n++;
    return n;
  };

  // ── 정합 시작 (Kabsch 계산 → 모듈 entity transform 애니메이션) ──
  const startAlignment = useCallback(async () => {
    setError(null); setRmsd(null);
    if (!allPicked) { setError('모듈 4 코너를 먼저 추출하세요'); return; }
    if (!basemapCorners) { setError('basemap 4 코너 JSON이 유효하지 않습니다'); return; }
    const core = coreRef.current;
    const pc = core?.getPC();
    const sd = core?.getSplatData();
    if (!pc || !sd) return;

    try {
      const { matchCorners } = await import('@/lib/alignment');
      const src = new Float64Array(12);
      const dst = new Float64Array(12);
      for (let i = 0; i < 4; i++) {
        const s = picked[i]!.pos;
        src[i*3] = s[0]; src[i*3+1] = s[1]; src[i*3+2] = s[2];
        const t = basemapCorners[i];
        dst[i*3] = t[0]; dst[i*3+1] = t[1]; dst[i*3+2] = t[2];
      }
      const fit = matchCorners(src, dst);
      setRmsd(fit.rmsd);
      console.log('[DoorAlign] Kabsch fit:', fit);

      // PLY entity는 Z180이 baked-in. 최종 entity transform:
      //   rotation = Z180 ∘ R_kabsch (matrix mul, 같은 의미로 quat mul z180 * R)
      //   position = Z180 * t_kabsch (Z180이 t 벡터를 회전시킴)
      const z180 = new pc.Quat();
      z180.setFromEulerAngles(0, 0, 180);

      const [qw, qx, qy, qz] = rotationMatrixToQuat(fit.R);
      const qR = new pc.Quat(qx, qy, qz, qw);
      const targetRot = new pc.Quat();
      targetRot.copy(z180).mul(qR);

      const tVec = new pc.Vec3(fit.t[0], fit.t[1], fit.t[2]);
      const tWorld = new pc.Vec3();
      z180.transformVector(tVec, tWorld);

      // 현재 entity transform을 시작값으로
      const curPos = sd.splatEntity.getLocalPosition();
      const curRot = sd.splatEntity.getLocalRotation();

      animRef.current = {
        start: performance.now(),
        duration: 1500,
        fromPos: [curPos.x, curPos.y, curPos.z],
        fromQuat: [curRot.x, curRot.y, curRot.z, curRot.w],
        toPos: [tWorld.x, tWorld.y, tWorld.z],
        toQuat: [targetRot.x, targetRot.y, targetRot.z, targetRot.w],
      };
      setAligned(true);
    } catch (e: any) {
      setError(`정합 실패: ${e?.message ?? e}`);
    }
  }, [allPicked, basemapCorners, picked, coreRef]);

  // ── 원위치 (모듈을 raw 상태로 되돌림) ──
  const resetPosition = useCallback(() => {
    const core = coreRef.current;
    const pc = core?.getPC();
    const sd = core?.getSplatData();
    if (!pc || !sd) return;
    const z180 = new pc.Quat();
    z180.setFromEulerAngles(0, 0, 180);
    const curPos = sd.splatEntity.getLocalPosition();
    const curRot = sd.splatEntity.getLocalRotation();
    animRef.current = {
      start: performance.now(),
      duration: 1500,
      fromPos: [curPos.x, curPos.y, curPos.z],
      fromQuat: [curRot.x, curRot.y, curRot.z, curRot.w],
      toPos: [0, 0, 0],
      toQuat: [z180.x, z180.y, z180.z, z180.w],
    };
    setAligned(false);
  }, [coreRef]);

  // ── 정합 미리보기 (Kabsch만 돌려 RMSD 표시) ──
  const computePreview = useCallback(async () => {
    setError(null); setRmsd(null);
    if (!allPicked) { setError('모듈 4 코너를 먼저 추출하세요'); return; }
    if (!basemapCorners) { setError('basemap 4 코너 JSON이 유효하지 않습니다'); return; }
    try {
      const { matchCorners } = await import('@/lib/alignment');
      const src = new Float64Array(12);
      const dst = new Float64Array(12);
      for (let i = 0; i < 4; i++) {
        const s = picked[i]!.pos;
        src[i*3] = s[0]; src[i*3+1] = s[1]; src[i*3+2] = s[2];
        const t = basemapCorners[i];
        dst[i*3] = t[0]; dst[i*3+1] = t[1]; dst[i*3+2] = t[2];
      }
      const fit = matchCorners(src, dst);
      setRmsd(fit.rmsd);
      console.log('[DoorAlign] Kabsch fit:', fit);
    } catch (e: any) {
      setError(`추정 실패: ${e?.message ?? e}`);
    }
  }, [allPicked, basemapCorners, picked]);

  // ────────────────────────────────────────────────────────────────────
  // 문 경계 정제 (boundary 가우시안 분할 + wall mesh 도어 영역 alpha=0 + 도어 mesh)
  //
  // 토글 ON  → applyDoorRefine: cachedScene 으로 분할 계산 → main PLY GPU in-place
  //            (boundary slot → wall-side sub) + door-side sub blob → additional splat
  //            + door mesh 베이크 + wall 텍스처 alpha=0 punch.
  // 토글 OFF → revertDoorRefine: 모든 변경 원복.
  // 슬라이더 변경 (활성 상태 시) → 600ms 디바운스 후 재적용.
  // ────────────────────────────────────────────────────────────────────
  const [doorRefineActive, setDoorRefineActive] = useState(false);
  const [doorRefining, setDoorRefining] = useState(false);
  const [doorRefineError, setDoorRefineError] = useState<string | null>(null);
  // 도어 mesh 베이크 depthGate / 분할 안전 margin — 슬라이더 UI 제거됨. 고정값 사용 (decompose / bake 기본).
  const DOOR_BAKE_GATE = 0.05;       // 5cm: 도어 mesh 베이크 시 평면 안쪽 splat 채택 한계.
  const DOOR_SAFETY_MARGIN = 0;       // 0: boundary split 비대칭 보정 없음 (anisotropic split 으로 자연스럽게 처리).
  const [doorThickness, setDoorThickness] = useState(0.3);     // 문 두께 (m). doorOriginalIndices 깊이 필터 (±thickness/2 from wall plane).
  const [boundarySplitEnabled, setBoundarySplitEnabled] = useState(true); // 가장자리 가우시안 분할 (SAGS-style). 끄면 추출만, split 안 함.
  const [doorRefineStats, setDoorRefineStats] = useState<{ N: number; nBoundary: number; nDoorOrig: number } | null>(null);

  const cachedSceneRef = useRef<GaussianScene | null>(null);
  // currentUrl 이 바뀌면 (예: 정합 후 reloadWithUrl) 캐시된 scene 도 stale → 무효화.
  useEffect(() => { cachedSceneRef.current = null; }, [currentUrl]);
  // 메인 PLY 의 boundary 슬롯 in-place 변경 전 snapshot — 원복용.
  const boundarySnapshotRef = useRef<Array<{ idx: number; x: number; y: number; z: number; s0: number; s1: number; s2: number }>>([]);
  const doorSubGsplatIdRef = useRef<string | null>(null);
  const doorSubBlobUrlRef = useRef<string | null>(null);
  const doorMeshEntityRef = useRef<any>(null);
  // Step 2: 모듈 도어 wrapper (mesh + splat 의 부모). 정합 시 reparent 대상.
  const moduleDoorWrapperRef = useRef<any>(null);
  const wallMeshNameRef = useRef<string | null>(null);
  const wallTexSnapshotRef = useRef<Uint8ClampedArray | null>(null);
  // 메인 PLY 의 doorOriginalIndices 들 — 정제 ON 시 숨김 (scale → -30) 하기 전 원본 scale snapshot.
  const doorOrigSnapshotRef = useRef<Array<{ idx: number; s0: number; s1: number; s2: number }>>([]);
  // doorOrig 들의 alpha snapshot — colorTexture (라이브 GPU) + origColorData (저장 마커) 둘 다 백업.
  // - alpha: GPU 라이브 colorTexture alpha → 0 으로 설정해 렌더 시 안 보임
  // - origAlpha: origColorData alpha → 0 으로 설정해 PLY 저장 시 keep 마스크가 자동 제외 (브러시 삭제와 동일 패턴)
  const doorOrigAlphaSnapshotRef = useRef<Array<{ idx: number; alpha: number; origAlpha: number }>>([]);
  // 디버그 노랑 틴트용 — 추가 gsplat 의 원본 colorTexture 데이터 + 도어 mesh 의 원본 emissive.
  const doorGsplatOrigColorsRef = useRef<Uint16Array | null>(null);
  const doorMeshOrigEmissiveRef = useRef<{ r: number; g: number; b: number } | null>(null);

  // 디버그: 문 내부로 분류된 가우시안 인덱스 (decomp.doorOriginalIndices) — 정제 적용 후 토글로 표시.
  const doorOriginalIndicesRef = useRef<number[]>([]);
  // 문 영역 확인 토글이 마지막에 메인 PLY 에 노란 칠한 인덱스 집합 — 복원 시 정확히 같은 set 만 되돌리기 위함.
  // (paint 시 doorOriginalIndices ∪ boundaryIndices 일 수도, doorOriginalIndices 만일 수도 있어 분리 추적.)
  const doorPaintedIndicesRef = useRef<number[]>([]);
  const [doorInternalShow, setDoorInternalShow] = useState(false);

  // ── 힌지 회전 (edge state 는 위쪽 line/cylinder/edge-pick 효과 블록에서 선언) ──
  const hingeIndices = useMemo<number[]>(
    () => hingeEdge === null ? [] : [hingeEdge, (hingeEdge + 1) % 4],
    [hingeEdge],
  );
  const [doorAngleDeg, setDoorAngleDeg] = useState(75);
  const [doorSwing, setDoorSwing] = useState<1 | -1>(1); // 1: 방 안쪽, -1: 방 바깥쪽

  // "문 설정 완료" 버튼 피드백.
  const [saveDoorBusy, setSaveDoorBusy] = useState(false);
  const [saveDoorToast, setSaveDoorToast] = useState<string | null>(null);
  // basemapUnitName 은 레거시 단일 도어 저장 흐름의 prop. 신흐름(다중 도어) 에선 도어마다 휠 피커 호수 부여라 미사용.
  // prop 자체는 호환성 위해 유지 — 호출자(UnifiedSplatEditor) 가 여전히 전달하지만 본 컴포넌트에선 무시.
  void basemapUnitName;
  // savedDoorCount 는 레거시 단일 도어 저장 카운터. basemap 신흐름은 inMemoryDoors.length 사용.
  // module 모드는 한 도어만 다루므로 카운터 자체 불필요. 제거.

  // 서버 doors.json 으로부터 door_1 로드. surfaceId 는 서버에 없어서 코너 위치 ↔ plane 으로 추정.
  // 힌지/방향/각도도 함께 복원해 사용자가 다시 들어와도 마지막 설정 유지.
  // (planes 가 준비되어야 surfaceId 추정 가능 → planes 가 deps).
  useEffect(() => {
    if (!planes) return;
    let cancelled = false;
    fetchDoorsFromServer(uploadId).then(({
      picked: corners, hingeEdge: he, swing: sw, angleDeg: ang,
      wallSurfaceId: savedSurfaceId, doorThickness: savedThick,
      boundarySplitEnabled: savedSplit, /* safetyMargin 은 현재 상수라 패스. */
    }) => {
      if (cancelled) return;
      const hasAny = corners.some(c => c !== null);
      if (!hasAny) return;
      // 서버에서 corners 가 복원됐음을 표시 — auto-extract 게이트가 사용.
      serverHydratedRef.current = true;
      const ref = corners.find(c => c !== null);
      if (ref) {
        // 저장된 wallSurfaceId 가 있으면 우선 사용. 없으면 가장 가까운 평면으로 추정.
        let surfaceId = savedSurfaceId ?? '';
        if (!surfaceId) {
          let bestSd = Infinity;
          for (const p of planes) {
            const sd = Math.abs(p.normal[0]*ref.pos[0] + p.normal[1]*ref.pos[1] + p.normal[2]*ref.pos[2] - p.d);
            if (sd < bestSd) { bestSd = sd; surfaceId = p.id; }
          }
        }
        setPicked(corners.map(c => c ? { pos: c.pos, surfaceId } : null));
      } else {
        setPicked(corners);
      }
      if (he !== null) setHingeEdge(he);
      setDoorSwing(sw);
      setDoorAngleDeg(ang);
      if (savedThick !== null && savedThick > 0) setDoorThickness(savedThick);
      if (savedSplit !== null) setBoundarySplitEnabled(savedSplit);
    });
    return () => { cancelled = true; };
  }, [uploadId, planes]);

  // 자동 저장 제거 — 모든 서버 저장은 문 설정 완료 버튼에서 일괄 처리.
  const [doorRotated, setDoorRotated] = useState(false);
  // 문 열기를 한 번이라도 적용했는지 — 회전축/각도/방향이 사용자에 의해 확정됐다는 신호.
  // 문 닫기 (resetDoorRotation) 로는 false 로 안 돌림 — 한 번 확정했으면 닫혀 있어도 완료 가능.
  const [rotationApplied, setRotationApplied] = useState(false);

  // 서버에서 코너 복원 → 자동 문 추출 (1회). 사용자가 다시 들어와도 회전 즉시 가능.
  // 수동 픽 (사용자가 4점 직접 클릭) 시에는 발동 안 함 — 명시적 "문 추출" 버튼 클릭만 받음.
  const autoExtractedRef = useRef(false);
  const serverHydratedRef = useRef(false);

  // app.root 트리에서 이름으로 entity 찾기.
  const findEntityByName = useCallback((root: any, name: string): any | null => {
    if (!root) return null;
    if (root.name === name) return root;
    const children = root.children || [];
    for (const c of children) {
      const r = findEntityByName(c, name);
      if (r) return r;
    }
    return null;
  }, []);

  // 메인 splat data 의 boundary 슬롯들에 wall-side sub 데이터 in-place 적용 (GPU sync 포함).
  const applyBoundaryUpdatesToGPU = useCallback((
    splatData: any,
    updates: BoundarySubUpdate[],
    float2Half: (v: number) => number,
  ) => {
    const gsplat = splatData.gsplatData;
    const sc0 = gsplat?.getProp('scale_0');
    const sc1 = gsplat?.getProp('scale_1');
    const sc2 = gsplat?.getProp('scale_2');
    if (!sc0 || !sc1 || !sc2) {
      console.warn('[DoorRefine] gsplatData scale props missing');
      return;
    }
    const tA = splatData.transformATexture;
    const tB = splatData.transformBTexture;
    const dataA = tA?.lock();
    const dataAF32 = dataA ? new Float32Array(dataA.buffer) : null;
    const dataB = tB?.lock();
    for (const u of updates) {
      splatData.posX[u.idx] = u.wallNewPos[0];
      splatData.posY[u.idx] = u.wallNewPos[1];
      splatData.posZ[u.idx] = u.wallNewPos[2];
      sc0[u.idx] = u.wallNewLogScale[0];
      sc1[u.idx] = u.wallNewLogScale[1];
      sc2[u.idx] = u.wallNewLogScale[2];
      if (dataAF32) {
        dataAF32[u.idx*4 + 0] = u.wallNewPos[0];
        dataAF32[u.idx*4 + 1] = u.wallNewPos[1];
        dataAF32[u.idx*4 + 2] = u.wallNewPos[2];
      }
      if (dataB) {
        dataB[u.idx*4 + 0] = float2Half(Math.exp(u.wallNewLogScale[0]));
        dataB[u.idx*4 + 1] = float2Half(Math.exp(u.wallNewLogScale[1]));
        dataB[u.idx*4 + 2] = float2Half(Math.exp(u.wallNewLogScale[2]));
      }
    }
    if (tA) tA.unlock();
    if (tB) tB.unlock();
    const inst = (splatData.splatEntity as any)?.gsplat?.instance;
    if (inst?.sorter?.centers) {
      for (const u of updates) {
        inst.sorter.centers[u.idx*3 + 0] = u.wallNewPos[0];
        inst.sorter.centers[u.idx*3 + 1] = u.wallNewPos[1];
        inst.sorter.centers[u.idx*3 + 2] = u.wallNewPos[2];
      }
      inst.sorter.setMapping(null);
      inst.lastCameraPosition.set(Infinity, Infinity, Infinity);
    }
  }, []);

  // 토글 OFF: 모든 변경 원복.
  const revertDoorRefine = useCallback(async () => {
    console.log('[DoorRefine] revert START');
    try {
      const core = coreRef.current;
      const sd = core?.getSplatData();
      const float2Half = core?.float2Half;

      // 1. boundary 슬롯 GPU 복원
      try {
        if (sd && float2Half && boundarySnapshotRef.current.length > 0) {
          const restoreUpdates: BoundarySubUpdate[] = boundarySnapshotRef.current.map(s => ({
            idx: s.idx,
            wallNewPos: [s.x, s.y, s.z],
            wallNewLogScale: [s.s0, s.s1, s.s2],
          }));
          applyBoundaryUpdatesToGPU(sd, restoreUpdates, float2Half);
        }
      } catch (e) { console.error('[DoorRefine] revert step 1 (boundary restore):', e); }
      boundarySnapshotRef.current = [];

      // 1b. doorOriginalIndices 슬롯 scale 복원 (숨김 → 원본)
      try {
        if (sd && float2Half && doorOrigSnapshotRef.current.length > 0) {
          const restoreOrigs: BoundarySubUpdate[] = doorOrigSnapshotRef.current.map(s => ({
            idx: s.idx,
            wallNewPos: [sd.posX[s.idx], sd.posY[s.idx], sd.posZ[s.idx]],
            wallNewLogScale: [s.s0, s.s1, s.s2],
          }));
          applyBoundaryUpdatesToGPU(sd, restoreOrigs, float2Half);
        }
      } catch (e) { console.error('[DoorRefine] revert step 1b (doorOrig restore):', e); }
      doorOrigSnapshotRef.current = [];

      // 1c. doorOrig alpha 복원 — colorTexture (라이브) + origColorData (저장 마커) 둘 다 원복.
      try {
        if (sd?.colorTexture && doorOrigAlphaSnapshotRef.current.length > 0) {
          const td = sd.colorTexture.lock();
          const orig = sd.origColorData;
          if (td) {
            for (const s of doorOrigAlphaSnapshotRef.current) {
              td[s.idx * 4 + 3] = s.alpha;
              if (orig) orig[s.idx * 4 + 3] = s.origAlpha;
            }
            sd.colorTexture.unlock();
          }
        }
      } catch (e) { console.error('[DoorRefine] revert step 1c (alpha restore):', e); }
      doorOrigAlphaSnapshotRef.current = [];

      // 2. additional door splat 제거
      try {
        if (doorSubGsplatIdRef.current) {
          additional.remove(doorSubGsplatIdRef.current);
          doorSubGsplatIdRef.current = null;
        }
        if (doorSubBlobUrlRef.current) {
          try { URL.revokeObjectURL(doorSubBlobUrlRef.current); } catch {}
          doorSubBlobUrlRef.current = null;
        }
      } catch (e) { console.error('[DoorRefine] revert step 2 (additional remove):', e); }

      // 3. door mesh entity 제거 + wrapper 제거 (mesh/splat 자식 포함 전체)
      try {
        if (doorMeshEntityRef.current) {
          try { doorMeshEntityRef.current.destroy(); } catch {}
          doorMeshEntityRef.current = null;
        }
        if (moduleDoorWrapperRef.current) {
          try { moduleDoorWrapperRef.current.destroy(); } catch {}
          moduleDoorWrapperRef.current = null;
        }
      } catch (e) { console.error('[DoorRefine] revert step 3 (door mesh destroy):', e); }

      // 4. wall mesh 텍스처 복원 — lvl 이 TypedArray 가 아닐 수 있어 인덱스 복사로 수행.
      try {
        if (wallTexSnapshotRef.current && wallMeshNameRef.current) {
          const app = core?.getApp();
          if (app) {
            const wallEnt = findEntityByName(app.root, wallMeshNameRef.current);
            const tex = wallEnt?.render?.meshInstances?.[0]?.material?.emissiveMap;
            if (tex) {
              const lvl: any = tex.lock();
              if (lvl) {
                const src = wallTexSnapshotRef.current;
                const len = Math.min(lvl.length ?? 0, src.length);
                if (typeof lvl.set === 'function' && lvl.length === src.length) {
                  lvl.set(src);
                } else {
                  for (let i = 0; i < len; i++) lvl[i] = src[i];
                }
              }
              tex.unlock();
            }
          }
        }
      } catch (e) { console.error('[DoorRefine] revert step 4 (wall tex restore):', e); }
      wallTexSnapshotRef.current = null;
      wallMeshNameRef.current = null;

      // 5. 회전 애니메이션 / 상태 정리
      doorAnimRef.current = null;
      doorCurrentAngleRef.current = 0;
      lastDoorHingeRef.current = null;
      // 노랑 tint snapshot 정리 (도어 entity 들이 destroy 되면 의미 없음)
      doorGsplatOrigColorsRef.current = null;
      doorMeshOrigEmissiveRef.current = null;

      setDoorRefineActive(false);
      setDoorRefineError(null);
      setDoorRefineStats(null);
      setDoorRotated(false);
      setRotationApplied(false);
      // 회전축 선택도 초기화 — 다시 문 추출 후 새로 고를 수 있도록.
      setHingeEdge(null);
      setEdgePickArmed(false);
      hoveredEdgeRef.current = null;
      console.log('[DoorRefine] revert COMPLETE');
    } catch (e) {
      console.error('[DoorRefine] revert outer error:', e);
      setDoorRefineActive(false);
      setDoorRefineError(null);
      setDoorRefineStats(null);
      setDoorRotated(false);
      setRotationApplied(false);
      setHingeEdge(null);
      setEdgePickArmed(false);
      hoveredEdgeRef.current = null;
    }
  }, [coreRef, additional, applyBoundaryUpdatesToGPU, findEntityByName]);

  // 토글 ON 또는 슬라이더 변경 시 재적용.
  const applyDoorRefine = useCallback(async () => {
    console.log('[DoorRefine] apply START');
    setDoorRefineError(null);
    setDoorRefining(true);
    try {
      // 0. 검증
      if (!allPicked) throw new Error('도어 4점을 먼저 추출하세요');
      const surfaceIds = picked.map(p => p!.surfaceId);
      if (new Set(surfaceIds).size > 1) throw new Error('도어 4점이 같은 면 위에 있어야 합니다');
      const wallSurfaceId = surfaceIds[0];

      const core = coreRef.current;
      const pc = core?.getPC();
      const app = core?.getApp();
      const sd = core?.getSplatData();
      const float2Half = core?.float2Half;
      if (!pc || !app || !sd || !float2Half) throw new Error('PlayCanvas 미준비');

      // 1. 이전 상태가 있으면 먼저 원복
      if (doorRefineActive || boundarySnapshotRef.current.length > 0
          || doorSubGsplatIdRef.current || doorMeshEntityRef.current) {
        await revertDoorRefine();
      }

      // 2. cachedScene 확보 (PLY parse 1회만). full N 유지 — 라이브 splatData 와 인덱스 정합 필요.
      if (!cachedSceneRef.current) {
        const { fetchAndParsePly } = await import('@/lib/ply');
        cachedSceneRef.current = await fetchAndParsePly(currentUrl);
      }
      const scene = cachedSceneRef.current;
      // 다듬기 단계의 keep mask (flatten/floater/brush 삭제). decomp 결과를 이걸로 거르면
      // 외부 가우시안이 도어 영역에서 부활하는 문제 방지.
      const keepMaskCurrent = getCurrentKeepMask?.() ?? null;

      // 라이브 splatData 의 scale 이 cachedScene 과 다를 수 있다 (예: 다듬기 단계의 경계 Clipping
      // 적용 후 정합으로 넘어온 경우 — 라이브에는 clip 된 scale, cachedScene 에는 PLY 원본 scale).
      // decompose 는 scene.sc 를 분할 베이스로 쓰므로 동기화하지 않으면 boundary 가우시안의 clipping 이
      // raw + split 으로 덮어써져 풀린다. 라이브 → cached 로 복사해 현재 상태를 분할 베이스로 사용.
      {
        const liveSc0 = sd.gsplatData?.getProp('scale_0') as Float32Array | undefined;
        const liveSc1 = sd.gsplatData?.getProp('scale_1') as Float32Array | undefined;
        const liveSc2 = sd.gsplatData?.getProp('scale_2') as Float32Array | undefined;
        const cs0 = scene.attrs.get('scale_0') as Float32Array | undefined;
        const cs1 = scene.attrs.get('scale_1') as Float32Array | undefined;
        const cs2 = scene.attrs.get('scale_2') as Float32Array | undefined;
        if (liveSc0 && liveSc1 && liveSc2 && cs0 && cs1 && cs2 && liveSc0.length === cs0.length) {
          cs0.set(liveSc0); cs1.set(liveSc1); cs2.set(liveSc2);
        }
      }

      // 3. 분할 계산
      // 사용자가 픽한 4 점을 wall plane 으로 projection — visualization (setDoorInternalShowAsync) 도 같은
      // projection 사용하므로 두 경로가 동일한 corners → 동일한 geom (pN, pO, edges) → 동일한 분류 결과.
      // 이걸 안 하면 raycast 의 floating-point 오차나 코너 drag 로 raw 코너가 평면에서 미세하게 어긋날 수
      // 있고 rect/slab boundary 근처 splat 이 페인트는 되는데 추출은 안 되거나 그 반대 케이스 발생.
      //
      // 좌표계 정합: planes 는 A' 프레임 (raw + pendingRotation), picked.pos 는 raw 프레임,
      // scene (cachedSceneRef) 도 raw 프레임. 따라서 picked → projection 결과를 raw 프레임으로 유지해야
      // decomposeBoundaryGaussians 가 raw scene 과 같은 좌표계로 비교됨.
      // 방법: A' 평면의 normal 을 pendingRotation^-1 로 회전해 raw 프레임 평면으로 변환 후 그 위에 raw 점 투영.
      const wallPlaneForRefine = planes?.find(p => p.id === wallSurfaceId);
      // 좌표 프레임: scene/picked 모두 raw, planes 는 A'. raw 프레임 평면을 만들어 동일 프레임에서 작업.
      const rotR = getEditorRotation(uploadId);
      const wallNormalRaw: Vec3 | null = wallPlaneForRefine
        ? aToRaw(wallPlaneForRefine.normal as Vec3, rotR)
        : null;
      const projectOnWall = (p: Vec3): Vec3 => {
        if (!wallPlaneForRefine || !wallNormalRaw) return p;
        const n = wallNormalRaw;
        const sd0 = n[0]*p[0] + n[1]*p[1] + n[2]*p[2] - wallPlaneForRefine.d;
        return [p[0] - sd0*n[0], p[1] - sd0*n[1], p[2] - sd0*n[2]];
      };
      const corners: [Vec3, Vec3, Vec3, Vec3] = [
        projectOnWall(picked[0]!.pos),
        projectOnWall(picked[1]!.pos),
        projectOnWall(picked[2]!.pos),
        projectOnWall(picked[3]!.pos),
      ];
      // wall mesh corners (A' 프레임) 와 매칭하기 위한 A' 변환본 (punch/extract 가 사용).
      const cornersA: [Vec3, Vec3, Vec3, Vec3] = [
        rawToA(corners[0], rotR),
        rawToA(corners[1], rotR),
        rawToA(corners[2], rotR),
        rawToA(corners[3], rotR),
      ];
      const { decomposeBoundaryGaussians, buildDoorSubScene, doorPlaneBakeInput, punchAlphaZeroInDoorRegion }
        = await import('@/lib/gs/doorTrim');
      // wallOutwardNormal: scene/corners 가 raw 프레임이므로 raw 프레임 wall normal 을 넘겨줘야 isInDoorSlab 의 sdOut 부호가 정합.
      // (wallPlaneForRefine.normal 은 A' 프레임. wallNormalRaw 는 위에서 pendingRotation^-1 으로 계산해뒀음.)
      const decompRaw = decomposeBoundaryGaussians(scene, { corners }, {
        safetyMargin: DOOR_SAFETY_MARGIN,
        doorThickness,
        wallOutwardNormal: wallNormalRaw ?? wallPlaneForRefine?.normal,
      });
      // 다듬기에서 삭제된 가우시안 (flatten/floater/brush) 은 도어 영역에서 부활시키지 않도록
      // decomp 결과의 인덱스 집합을 keep mask 로 거른다. boundary 갱신/wall-side 도 마찬가지.
      const decomp = keepMaskCurrent
        ? {
            boundaryIndices: decompRaw.boundaryIndices.filter(i => keepMaskCurrent[i] === 1),
            doorOriginalIndices: decompRaw.doorOriginalIndices.filter(i => keepMaskCurrent[i] === 1),
            wallOriginalIndices: decompRaw.wallOriginalIndices.filter(i => keepMaskCurrent[i] === 1),
            wallSideUpdates: decompRaw.wallSideUpdates.filter(u => keepMaskCurrent[u.idx] === 1),
            doorSubMetadata: decompRaw.doorSubMetadata.filter(m => keepMaskCurrent[m.origIdx] === 1),
          }
        : decompRaw;
      doorOriginalIndicesRef.current = decomp.doorOriginalIndices.slice();
      console.log(`[DoorRefine] N=${scene.numSplats}, boundary=${decomp.boundaryIndices.length}, doorOrig=${decomp.doorOriginalIndices.length}, wallOrig=${decomp.wallOriginalIndices.length}${keepMaskCurrent ? ' (다듬기 삭제 반영)' : ''}`);
      setDoorRefineStats({
        N: scene.numSplats,
        nBoundary: decomp.boundaryIndices.length,
        nDoorOrig: decomp.doorOriginalIndices.length,
      });

      // ── 순서 재배치 ──
      // 메인 PLY 의 visible 변형 (boundary 이동, doorOrig 숨김, wall mesh alpha-punch) 을
      // 도어 entity 가 fully ready + (영역 확인 ON 이면) 노란색 페인트 완료 직전까지 미룬다.
      // 그래야 사용자가 "main PLY 도어 숨김 ↔ 도어 entity 페인트 미완" 사이의 빈 도어 transparent 상태를
      // 보지 않고, 자연 도어 → 완성 도어 (회전/노랑) 로 한 번에 전환됨.

      // [Phase A] 도어 풀 씬 빌드 + entity 추가 + asset ready 대기 — 메인 PLY 변형 없음.
      const sc0 = sd.gsplatData?.getProp('scale_0');
      const sc1 = sd.gsplatData?.getProp('scale_1');
      const sc2 = sd.gsplatData?.getProp('scale_2');
      if (!sc0 || !sc1 || !sc2) throw new Error('gsplatData scale props missing');

      const { filterScene, concatScenes, serializePly } = await import('@/lib/ply');
      // flatten/brush 로 alpha=0 처리된 splat (origColorData[i*4+3] ≈ 0) 은 도어 entity 에도 포함하지 않음.
      // 안 그러면 cachedScene 의 원본 alpha 로 부활해 방 밖 잔여물 다시 보임.
      const h2f = core.half2Float;
      const origColor = sd.origColorData;
      const isAlphaDeleted = (i: number): boolean => {
        if (!origColor) return false;
        return h2f(origColor[i * 4 + 3]) < 1e-3;
      };
      const keepDoor = new Uint8Array(scene.numSplats);
      let doorAlphaDeleted = 0;
      for (const i of decomp.doorOriginalIndices) {
        if (isAlphaDeleted(i)) { doorAlphaDeleted++; continue; }
        keepDoor[i] = 1;
      }
      // doorSubMetadata 도 같은 기준으로 필터 (boundary 가우시안 중 flatten 삭제된 건 sub 도 부활시키지 않음).
      const filteredSubMeta = decomp.doorSubMetadata.filter(m => !isAlphaDeleted(m.origIdx));
      console.log(`[DoorRefine] flatten 삭제된 splat 도어 entity 제외: doorOrig=${doorAlphaDeleted}, sub=${decomp.doorSubMetadata.length - filteredSubMeta.length}`);
      const doorOrigScene = filterScene(scene, keepDoor);
      const doorSubsScene = (boundarySplitEnabled && filteredSubMeta.length > 0)
        ? buildDoorSubScene(scene, filteredSubMeta)
        : null;
      const doorFullScene = doorSubsScene
        ? concatScenes(doorOrigScene, doorSubsScene)
        : doorOrigScene;

      if (doorFullScene.numSplats > 0) {
        const bytes = serializePly(doorFullScene);
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        doorSubBlobUrlRef.current = blobUrl;
        const { id, ready } = additional.add(blobUrl, { name: '도어 영역 가우시안', source: 'local' });
        console.warn(`[DoorSplat:CREATE] id=${id} basemapMode=${basemapMode} stack:`, new Error().stack);
        if (id) {
          doorSubGsplatIdRef.current = id;
          // asset.ready 까지 정확히 대기 — Promise 기반, 폴링 불필요.
          await ready;
          // 메인 splatEntity 와 동일 회전 (Z-180 + pendingRotation) 부여 — raw 좌표 기준 doorScene 이라
          // 메인과 일치한 자리에 그려짐. additional.add 의 default 는 Z-180 만 부여.
          const ent = additional.getEntity(id);
          const splatEnt = sd?.splatEntity;
          if (ent && splatEnt) {
            const r = splatEnt.getLocalRotation();
            ent.setLocalRotation(r.x, r.y, r.z, r.w);
          }
        }
      }

      // [Phase B] wall 텍스쳐의 도어 영역 픽셀을 잘라서 도어 mesh 텍스쳐로 사용 — 메인 PLY 변형 없음.
      // 정합 단계에서 가우시안 알파블렌딩/베이크는 0회. 도어 mesh = wall 텍스쳐의 도어 영역 그대로.
      // (잘라낸 자리는 Phase C 의 punchAlphaZeroInDoorRegion 이 wall 텍스쳐를 alpha=0 으로 비움.)
      const wallPlane = planes?.find(p => p.id === wallSurfaceId);
      let wallEntName: string | null = null;
      let wallMeshTex: any = null;
      let wallMeshObj: any = null;
      let wallCorners: [Vec3, Vec3, Vec3, Vec3] | null = null;
      let wallUvs: [[number, number], [number, number], [number, number], [number, number]] | null = null;
      let pendingDoorMeshEnt: any = null;
      if (!wallPlane) {
        console.warn(`[DoorRefine] wallPlane not found for surfaceId=${wallSurfaceId} — skipping mesh ops`);
      } else {
        // 1) wall mesh entity 찾고 텍스쳐/형상 메타 준비.
        wallEntName = `wallMesh_${wallSurfaceId}`;
        const wallEnt = findEntityByName(app.root, wallEntName);
        if (!wallEnt) {
          console.warn(`[DoorRefine] wall mesh entity ${wallEntName} not found — skip door mesh`);
        } else {
          const meshInst = wallEnt.render?.meshInstances?.[0];
          wallMeshTex = meshInst?.material?.emissiveMap;
          wallMeshObj = meshInst?.mesh;
          if (wallMeshTex && wallMeshObj) {
            const positions: number[] = [];
            const uvs: number[] = [];
            wallMeshObj.getPositions(positions);
            wallMeshObj.getUvs(0, uvs);
            wallCorners = [
              [positions[0], positions[1], positions[2]],
              [positions[3], positions[4], positions[5]],
              [positions[6], positions[7], positions[8]],
              [positions[9], positions[10], positions[11]],
            ];
            wallUvs = [
              [uvs[0], uvs[1]], [uvs[2], uvs[3]], [uvs[4], uvs[5]], [uvs[6], uvs[7]],
            ];

            // 2) wall 텍스쳐에서 도어 영역 픽셀 잘라내기 (read-only).
            // wallCorners 는 A' 프레임 (mesh positions 그대로) 이므로 doorCorners 도 A' 프레임 (cornersA) 사용.
            const { extractDoorRegionTexture } = await import('@/lib/gs/doorTrim');
            const wallTexLvl = wallMeshTex.lock();
            const cut = extractDoorRegionTexture(
              wallTexLvl as Uint8ClampedArray,
              wallMeshTex.width, wallMeshTex.height,
              wallCorners, wallUvs, cornersA,
            );
            wallMeshTex.unlock();
            console.log(`[DoorRefine] door tex cut: ${cut.width}×${cut.height} from wall ${wallMeshTex.width}×${wallMeshTex.height}`);

            // 3) cut 결과 + 도어 corners + UV 매핑.
            //    Wall 텍스쳐 행 방향: row 0 = raw y 큰 쪽. Z-180 entity 회전 때문에 화면상으론 아래쪽
            //    (CLAUDE.md "코드 ceiling = 화면 바닥" 규칙).
            //    Door corners 는 picked 순서 = 사용자 화면 라벨 [TL, TR, BR, BL] = raw y [낮음, 낮음, 높음, 높음].
            //    UV 를 세로 반전 [(0,1),(1,1),(1,0),(0,0)] 로 매핑하면 vertex 0 이 row cutH-1 (raw y 낮은 콘텐츠) 샘플 → 정합.
            //
            //    이전엔 wall mesh 와 도어 mesh 의 깊이 충돌(z-fight) 우려로 도어 mesh 를 1mm 방 안쪽으로 미세 오프셋했으나,
            //    wall mesh 는 도어 영역에 alpha=0 펀치되어 있어 그 영역에선 아무것도 그리지 않으므로 z-fight 실제 발생 안 함.
            //    또한 오프셋이 도어 splat 을 가려서 보이지 않게 만드는 부작용 있음 (mesh 가 카메라 쪽으로 1mm 가까워 depth 우선).
            //    → 오프셋 제거, 정확히 wall plane (sd=0) 에 도어 mesh 배치.
            // inwardN 은 doorMesh.normalInward 메타로 저장되므로 계산 자체는 유지 (저장 형식).
            const wallNormalRawForOffset: Vec3 = wallNormalRaw ?? (wallPlane.normal as Vec3);
            const inwardN: Vec3 = [-wallNormalRawForOffset[0], -wallNormalRawForOffset[1], -wallNormalRawForOffset[2]];
            const doorCornersForMesh: [Vec3, Vec3, Vec3, Vec3] = [
              [corners[0][0], corners[0][1], corners[0][2]] as Vec3,
              [corners[1][0], corners[1][1], corners[1][2]] as Vec3,
              [corners[2][0], corners[2][1], corners[2][2]] as Vec3,
              [corners[3][0], corners[3][1], corners[3][2]] as Vec3,
            ];
            // 도어 mesh UV: 각 코너의 cut texture 픽셀 위치를 정규화. axis-aligned bbox crop 이라
            //   사다리꼴 도어 코너가 bbox 코너와 일치하지 않을 수 있어 고정 UV 로는 텍스쳐 어긋남.
            //   cut.doorCornerPx[i] = 도어 corner i 의 cut.rgba 픽셀 좌표.
            const cw = cut.width, ch = cut.height;
            const doorMeshUvs: [[number, number], [number, number], [number, number], [number, number]] = [
              [cut.doorCornerPx[0][0] / cw, cut.doorCornerPx[0][1] / ch],
              [cut.doorCornerPx[1][0] / cw, cut.doorCornerPx[1][1] / ch],
              [cut.doorCornerPx[2][0] / cw, cut.doorCornerPx[2][1] / ch],
              [cut.doorCornerPx[3][0] / cw, cut.doorCornerPx[3][1] / ch],
            ];
            const doorMeshInput = {
              rgba: cut.rgba,
              width: cut.width,
              height: cut.height,
              corners: doorCornersForMesh,
              uvs: doorMeshUvs,
              input: {
                origin: corners[0],
                uAxis: [1, 0, 0] as Vec3,
                vAxis: [0, 1, 0] as Vec3,
                normal: wallPlane.normal as Vec3,
                uMin: 0, uMax: 1, vMin: 0, vMax: 1,
                extendU0: 0, extendU1: 0, extendV0: 0, extendV1: 0,
                meshOffset: 0,
              },
            };
            // basemap 다중 도어 영속화용 — 메시 코너 (A'+Y 프레임으로 변환 후 보관).
            // doorMeshInput.corners 는 raw 프레임. A'+Y 로 변환 = pendingRotation + wallAngle Y 적용.
            // refined PLY 가 A'+Y 로 베이크 업로드되므로 mesh 코너도 같은 프레임으로 저장해야 일관.
            try {
              const rotForBake = getCurrentBakedRotation?.() ?? { rotX: 0, rotZ: 0, wallAngleRad: 0 };
              const meshCornersAY: [number, number, number][] = doorCornersForMesh.map(c => {
                const ay = rawToAY([c[0], c[1], c[2]] as Vec3, rotForBake as FrameRotation);
                return [ay[0], ay[1], ay[2]];
              });
              const inwardForSave: [number, number, number] = (() => {
                const ay = rawToAY(inwardN, rotForBake as FrameRotation);
                return [ay[0], ay[1], ay[2]];
              })();
              lastDoorMeshInputRef.current = {
                rgba: cut.rgba,
                width: cut.width,
                height: cut.height,
                corners: meshCornersAY,
                uvs: doorMeshUvs as [number, number][],
                normalInward: inwardForSave,
              };
              lastDoorMeshBboxRef.current = { x: cut.bbox.x, y: cut.bbox.y, w: cut.bbox.w, h: cut.bbox.h };
              lastDoorMeshWallSurfaceIdRef.current = wallSurfaceId;
            } catch (e) {
              console.warn('[DoorRefine] door mesh input capture for persistence failed:', e);
            }
            const { createWallMeshEntity } = await import('@/lib/gs/wallMesh');
            pendingDoorMeshEnt = createWallMeshEntity(
              pc, app, sd.splatEntity, doorMeshInput as any, `doorMesh_${wallSurfaceId}`,
            );
            // 도어 mesh corners 는 picked corners 기반 (raw frame). createWallMeshEntity 는 default
            // Z-180 만 부여하므로 pendingRotation 까지 합쳐서 splatEntity 와 동일 변환으로 맞춤.
            if (pendingDoorMeshEnt) {
              const r = sd.splatEntity.getLocalRotation();
              pendingDoorMeshEnt.setLocalRotation(r.x, r.y, r.z, r.w);
            }
          }
        }
      }

      // [Phase C — ATOMIC] 모든 visible 변형을 한 번에. await 없음.
      //   1) boundary snapshot + wall-side 이동.
      //   2) doorOrig scale snapshot + 숨김 (-30).
      //   3) doorOrig alpha snapshot + alpha=0.
      //   4) wall mesh alpha-punch.
      //   5) door mesh entity ref 저장.
      // 페인트 (영역 확인 ON 시) 는 setDoorRefineActive(true) 직후 auto-refresh useEffect 가 처리.
      // → main PLY 도어 숨김과 동시에 도어 entity / 도어 mesh 가 자연색으로 그 자리를 채움 → 빈 transparent 갭 없음.

      if (boundarySplitEnabled) {
        boundarySnapshotRef.current = decomp.boundaryIndices.map(i => ({
          idx: i,
          x: sd.posX[i], y: sd.posY[i], z: sd.posZ[i],
          s0: sc0[i], s1: sc1[i], s2: sc2[i],
        }));
        applyBoundaryUpdatesToGPU(sd, decomp.wallSideUpdates, float2Half);
      } else {
        boundarySnapshotRef.current = [];
      }

      const HIDE_LOGSCALE = -30;
      doorOrigSnapshotRef.current = decomp.doorOriginalIndices.map(i => ({
        idx: i,
        s0: sc0[i], s1: sc1[i], s2: sc2[i],
      }));
      const hideUpdates: BoundarySubUpdate[] = decomp.doorOriginalIndices.map(i => ({
        idx: i,
        wallNewPos: [sd.posX[i], sd.posY[i], sd.posZ[i]],
        wallNewLogScale: [HIDE_LOGSCALE, HIDE_LOGSCALE, HIDE_LOGSCALE],
      }));
      applyBoundaryUpdatesToGPU(sd, hideUpdates, float2Half);

      doorOrigAlphaSnapshotRef.current = [];
      if (sd.colorTexture) {
        const td = sd.colorTexture.lock();
        if (td) {
          const halfZero = float2Half(0);
          const orig = sd.origColorData;
          const snap: Array<{ idx: number; alpha: number; origAlpha: number }> = [];
          for (const i of decomp.doorOriginalIndices) {
            snap.push({
              idx: i,
              alpha: td[i*4 + 3],
              origAlpha: orig ? orig[i*4 + 3] : halfZero,
            });
            td[i*4 + 3] = halfZero;
            // origColorData alpha 도 0 으로 마킹 → commitRefinedToServer 의 keep 마스크가 자동 제외.
            // 브러시 삭제와 동일 패턴. revert 시 origAlpha snapshot 으로 복원.
            if (orig) orig[i*4 + 3] = halfZero;
          }
          doorOrigAlphaSnapshotRef.current = snap;
          sd.colorTexture.unlock();
        }
      }

      if (wallMeshTex && wallCorners && wallUvs && wallEntName) {
        const lvl = wallMeshTex.lock();
        if (lvl) {
          const rgba = lvl as Uint8ClampedArray;
          wallTexSnapshotRef.current = new Uint8ClampedArray(rgba);
          wallMeshNameRef.current = wallEntName;
          // wallCorners 는 A' 프레임이므로 doorCorners 도 A' (cornersA) 로 매칭.
          const touched = punchAlphaZeroInDoorRegion(rgba, wallMeshTex.width, wallMeshTex.height, wallCorners, wallUvs, cornersA);
          console.log(`[DoorRefine] wall mesh hole: ${touched} pixels`);
        }
        wallMeshTex.unlock();

        // CPU rgba 캐시 (lastBakesRef) 에도 동일 punch — 서버 PNG 로 직렬화될 때 punch 가 보존되도록.
        // wallEntName 형식: 'wallMesh_<surfaceId>'. surfaceId 추출.
        const surfaceId = wallEntName.startsWith('wallMesh_') ? wallEntName.slice('wallMesh_'.length) : wallEntName;
        const bake = getBakeRgba?.(surfaceId);
        if (bake) {
          const touchedCpu = punchAlphaZeroInDoorRegion(bake.rgba, bake.width, bake.height, wallCorners, wallUvs, cornersA);
          console.log(`[DoorRefine] wall mesh hole (CPU rgba): ${touchedCpu} pixels (surfaceId=${surfaceId})`);
        } else {
          console.warn(`[DoorRefine] CPU rgba 캐시 없음 — surfaceId=${surfaceId} (서버 PNG 에 punch 미반영 가능)`);
        }
      }

      doorMeshEntityRef.current = pendingDoorMeshEnt;

      // Step 2: 도어 wrapper — mesh + splat 을 한 entity 자식으로 묶어 정합/가시성 제어 단위로 사용.
      //   module: 'moduleDoor' (단일), basemap: 'basemapDoor_<doorId>' (다중).
      const newDoorId = basemapMode
        ? `door_${Date.now()}_${Math.floor(Math.random() * 1000)}`
        : null;
      const doorWrapperName = basemapMode ? `basemapDoor_${newDoorId}` : 'moduleDoor';
      const doorWrapper = new pc.Entity(doorWrapperName);
      app.root.addChild(doorWrapper);
      if (pendingDoorMeshEnt) {
        try { doorWrapper.addChild(pendingDoorMeshEnt); } catch (e) { console.warn('[DoorRefine] mesh reparent fail:', e); }
      }
      if (doorSubGsplatIdRef.current) {
        const splatEnt = additional.getEntity(doorSubGsplatIdRef.current);
        if (splatEnt) {
          try { doorWrapper.addChild(splatEnt); } catch (e) { console.warn('[DoorRefine] splat reparent fail:', e); }
        }
      }
      if (!basemapMode) {
        if (moduleDoorWrapperRef.current && moduleDoorWrapperRef.current !== doorWrapper) {
          try { moduleDoorWrapperRef.current.destroy(); } catch {}
        }
        moduleDoorWrapperRef.current = doorWrapper;
      }

      setDoorRefineActive(true);
      console.log('[DoorRefine] apply SUCCESS');

      // 신흐름 — basemap 다중 도어: 추출 성공 즉시 메모리 도어 리스트에 push.
      // 모듈 모드는 그대로 (기존 회전 메타 부여 후 정합 단계로 transition).
      if (basemapMode) {
        try {
          const meshInput = lastDoorMeshInputRef.current;
          const doorId = newDoorId as string;
          const splatBlobUrl = doorSubBlobUrlRef.current;
          const splatLayerId = doorSubGsplatIdRef.current;
          const doorMeshEnt = pendingDoorMeshEnt;
          // 엔티티 이름 변경 → 다음 applyDoorRefine 의 revert 가 못 찾게 (개별 도어 보존).
          if (doorMeshEnt) {
            try { doorMeshEnt.name = `doorMesh_kept_${doorId}`; } catch {}
          }
          // 노란 outline 생성 — RAW 프레임 corners + 엔티티에 Z-180+pendingRotation 부여.
          // (corners 가 A' 또는 A'+Y 라면 엔티티 rotation 과 함께 pendingRotation 이 이중 적용됨.)
          let outlineHandle: import('@/lib/gs/doorOutline').DoorOutlineHandle | null = null;
          try {
            const { createDoorOutlineEntity } = await import('@/lib/gs/doorOutline');
            const splatRot = sd.splatEntity.getLocalRotation();
            outlineHandle = createDoorOutlineEntity(pc, app, {
              corners: corners.map(c => [c[0], c[1], c[2]] as [number, number, number]),
              unitName: null,
              rotation: [splatRot.x, splatRot.y, splatRot.z, splatRot.w],
            });
          } catch (e) {
            console.warn('[DoorRefine] outline 생성 실패:', e);
          }
          // doors.json 저장용: A'+Y 프레임 — 모듈 흐름의 pickedTransformed (rotateForSave) 와 동일 컨벤션.
          //   raw → A'+Y = rotR(rotX/rotZ/wallAngleRad) 모두 적용.
          const cornersAYpush: Vec3[] = corners.map(c => {
            const ay = rawToAY([c[0], c[1], c[2]] as Vec3, rotR as FrameRotation);
            return [ay[0], ay[1], ay[2]] as Vec3;
          });
          const newDoor: InMemoryDoor = {
            doorId,
            cornersRaw: corners.map(c => [c[0], c[1], c[2]]),
            cornersAY: cornersAYpush,
            wallSurfaceId,
            doorMeshInput: {
              rgba: meshInput?.rgba ?? new Uint8ClampedArray(0),
              width: meshInput?.width ?? 0,
              height: meshInput?.height ?? 0,
              corners: meshInput?.corners ?? [],
              uvs: meshInput?.uvs ?? [],
              normalInward: meshInput?.normalInward ?? [0, 0, 0],
            },
            doorSplatBlobUrl: splatBlobUrl,
            doorMeshEntityName: doorMeshEnt?.name || `doorMesh_kept_${doorId}`,
            doorSplatLayerId: splatLayerId,
            outlineHandle,
            wallTextureSnapshotRect: lastDoorMeshBboxRef.current
              ? { ...lastDoorMeshBboxRef.current }
              : null,
            doorThickness,
            boundarySplitEnabled,
            safetyMargin: DOOR_SAFETY_MARGIN,
            unitName: '',  // 미설정 — 휠 피커로 부여.
            bakeRotation: getCurrentBakedRotation?.() ?? { rotX: 0, rotZ: 0, wallAngleRad: 0 },
            doorOriginalIndices: decomp.doorOriginalIndices.slice(),
          };
          // 다음 도어 작업을 위해 현재 도어 관련 ref 들 detach (revert 가 영향 안 주도록).
          doorSubGsplatIdRef.current = null;
          doorSubBlobUrlRef.current = null;
          doorMeshEntityRef.current = null;
          boundarySnapshotRef.current = [];
          doorOrigSnapshotRef.current = [];
          doorOrigAlphaSnapshotRef.current = [];
          setInMemoryDoors(prev => [...prev, newDoor]);
          // picked 초기화 → 다음 4점 픽 가능
          setPicked(emptyPicked());
          setHingeEdge(null);
          setEdgePickArmed(false);
          setDoorRotated(false);
          setRotationApplied(false);
          setDoorRefineActive(false);
          // 추출 직후 → 호수 휠 피커 자동 오픈 (자동/수동 무관 — 사용자가 호수 부여 또는 취소 시 placeholder 로 남음).
          setUnitNamePickerOpen({ doorId, initialSuffix: 1 });
        } catch (saveErr: any) {
          console.warn('[DoorRefine] basemap 메모리 push 실패:', saveErr);
        }
      }
    } catch (e: any) {
      console.error('[DoorRefine] failed:', e);
      setDoorRefineError(`정제 실패: ${e?.message ?? e}`);
      // 실패 시 깨끗한 상태로 원복
      try { await revertDoorRefine(); } catch {}
    } finally {
      setDoorRefining(false);
    }
  }, [allPicked, picked, currentUrl, coreRef, additional, planes, doorThickness,
      doorRefineActive, boundarySplitEnabled, applyBoundaryUpdatesToGPU, findEntityByName, revertDoorRefine]);

  // 서버에서 corners 복원 후 1회 자동 문 추출 — 다시 들어와도 회전이 바로 활성.
  // 수동 픽 (사용자가 4점 직접 클릭) 일 때는 발동 안 함 (serverHydratedRef 게이트).
  useEffect(() => {
    if (autoExtractedRef.current) return;
    if (!serverHydratedRef.current) return;
    if (!planes || !allPicked) return;
    if (doorRefineActive || doorRefining) return;
    autoExtractedRef.current = true;
    applyDoorRefine();
  }, [planes, allPicked, doorRefineActive, doorRefining, applyDoorRefine]);

  // 문 내부 가우시안 색칠 (정제 전/후 모두 사용 가능).
  // ON 시: 4 코너 + 두께 기준 doorOriginalIndices 를 lazy 계산 → 빨강 틴트.
  // OFF 시: origColorData 의 RGB 로 복원.
  // 두께/코너 변경 시 자동 재계산 (아래 useEffect 참조).
  const setDoorInternalShowAsync = useCallback(async (next: boolean) => {
    const core = coreRef.current;
    const sd = core?.getSplatData();
    if (!core || !sd?.colorTexture || !sd?.origColorData) {
      console.warn('[DoorPreview] aborted: ',
        !core ? 'core null' :
        !sd?.colorTexture ? 'colorTexture missing' :
        'origColorData missing — 다듬기 단계에서 가우시안 편집 1회 이상 필요할 수 있음.');
      return;
    }
    const f2h = core.float2Half;

    // 1. 기존 tint 가 있다면 (토글 ON 상태였다면) 일단 RGB 복원 — 마지막에 칠한 set 정확히 되돌리기.
    const oldPainted = doorPaintedIndicesRef.current;
    if (oldPainted.length > 0 && doorInternalShow) {
      const td = sd.colorTexture.lock();
      if (td) {
        for (const i of oldPainted) {
          td[i * 4 + 0] = sd.origColorData[i * 4 + 0];
          td[i * 4 + 1] = sd.origColorData[i * 4 + 1];
          td[i * 4 + 2] = sd.origColorData[i * 4 + 2];
        }
        sd.colorTexture.unlock();
      }
      doorPaintedIndicesRef.current = [];
    }

    // 1b. 추가 gsplat 색 복원.
    // PlayCanvas 2.x: addComponent('gsplat') 후 asset.resource 가 비워지고 gsplat.instance.resource 로 이전됨.
    // 따라서 아래 fallback 체인으로 접근. (paint 경로 step 3b 와 동일 로직.)
    if (doorInternalShow && doorGsplatOrigColorsRef.current && doorSubGsplatIdRef.current) {
      const doorEnt = additional.getEntity(doorSubGsplatIdRef.current);
      const gsplatComp = (doorEnt as any)?.gsplat;
      const doorAsset = gsplatComp?.asset;
      const doorRes = doorAsset?.resource
        ?? gsplatComp?.instance?.resource
        ?? gsplatComp?.instance?.splatData;
      const doorColorTex = doorRes?.streams?.textures?.get('splatColor')
        ?? gsplatComp?.material?.colorMap
        ?? gsplatComp?.instance?.material?.colorMap;
      if (doorColorTex) {
        const dt = doorColorTex.lock();
        if (dt) {
          dt.set(doorGsplatOrigColorsRef.current);
          doorColorTex.unlock();
        }
      } else {
        console.warn('[DoorPreview] restore: doorColorTex 접근 실패 — paint 와 같은 경로 사용 중인지 확인.');
      }
      doorGsplatOrigColorsRef.current = null;
    }

    // 1c. 도어 mesh emissive 복원
    if (doorInternalShow && doorMeshOrigEmissiveRef.current && doorMeshEntityRef.current) {
      const meshMat = doorMeshEntityRef.current.render?.meshInstances?.[0]?.material;
      const pcLibR = core.getPC();
      if (meshMat && pcLibR) {
        const o = doorMeshOrigEmissiveRef.current;
        if (meshMat.emissive?.set) meshMat.emissive.set(o.r, o.g, o.b);
        else meshMat.emissive = new pcLibR.Color(o.r, o.g, o.b);
        meshMat.update?.();
      }
      doorMeshOrigEmissiveRef.current = null;
    }

    if (!next) { setDoorInternalShow(false); return; }
    if (!allPicked) { setDoorInternalShow(false); return; }

    // 2. 새 indices 계산 (scene 캐시 + decompose)
    // applyDoorRefine 와 동일하게 wall plane 으로 투영한 corners 사용 — 안 그러면 결과가 달라져
    // hide 와 tint 가 어긋남 (alpha=0 인 splats 와 yellow 칠하는 splats 가 다른 집합).
    try {
      if (!cachedSceneRef.current) {
        const { fetchAndParsePly } = await import('@/lib/ply');
        cachedSceneRef.current = await fetchAndParsePly(currentUrl);
      }
      const wallPlanePrev = planes?.find(p => p.id === picked[0]!.surfaceId);
      // 좌표 프레임 정합: planes A' → raw (splat/picked 가 raw).
      const rotRprev = getEditorRotation(uploadId);
      const wallNormalRawPrev: Vec3 | null = wallPlanePrev
        ? aToRaw(wallPlanePrev.normal as Vec3, rotRprev)
        : null;
      const projectPrev = (p: Vec3): Vec3 => {
        if (!wallPlanePrev || !wallNormalRawPrev) return p;
        const n = wallNormalRawPrev;
        const sd0 = n[0]*p[0] + n[1]*p[1] + n[2]*p[2] - wallPlanePrev.d;
        return [p[0] - sd0*n[0], p[1] - sd0*n[1], p[2] - sd0*n[2]];
      };
      const corners: [Vec3, Vec3, Vec3, Vec3] = [
        projectPrev(picked[0]!.pos),
        projectPrev(picked[1]!.pos),
        projectPrev(picked[2]!.pos),
        projectPrev(picked[3]!.pos),
      ];
      // ── 시각화 페인트 set 직접 계산 — 라이브 splat 위치 기준 ──
      // decompose 와 동일한 분류 기준 사용 (isInDoorSlab + 4 edge inside).
      //   1) 슬랩: 벽 평면 → 방 안쪽 doorThickness 깊이까지 (비대칭).
      //   2) 사각형 안 (4 edge 모두 sd >= 0).
      // 두 경로가 같은 helper 를 쓰므로 hide 와 tint 집합이 정확히 일치.
      const { rectGeom, isInDoorSlab } = await import('@/lib/gs/doorTrim');
      const geom = rectGeom(corners);
      // wallOutward 도 raw 프레임 — splat 좌표 (raw) 와 비교용.
      const wallOutward: Vec3 = wallNormalRawPrev ?? geom.planeNormal;
      const N = sd.numSplats;
      const px = sd.posX, py = sd.posY, pz = sd.posZ;
      const paintSet: number[] = [];
      const pO = geom.planeOrigin;
      const en = geom.edgeNormals, eo = geom.edgeOrigins;
      for (let i = 0; i < N; i++) {
        const cx = px[i], cy = py[i], cz = pz[i];
        if (!isInDoorSlab(cx, cy, cz, pO, wallOutward, doorThickness)) continue;
        let inside = true;
        for (let e = 0; e < 4; e++) {
          const n = en[e], o = eo[e];
          const sdE = (cx - o[0]) * n[0] + (cy - o[1]) * n[1] + (cz - o[2]) * n[2];
          if (sdE < 0) { inside = false; break; }
        }
        if (inside) paintSet.push(i);
      }
      doorPaintedIndicesRef.current = paintSet;
    } catch (e: any) {
      console.error('[DoorRefine] preview compute failed:', e);
      setDoorInternalShow(false);
      return;
    }

    const indices = doorPaintedIndicesRef.current;
    if (indices.length === 0) { setDoorInternalShow(false); return; }

    // 3. 노랑 틴트 적용 (R,G high, B low — SH DC 공간)
    const td = sd.colorTexture.lock();
    if (!td) { setDoorInternalShow(false); return; }
    const r = f2h(2.0), g = f2h(2.0), b = f2h(-2.0);
    for (const i of indices) {
      td[i * 4 + 0] = r;
      td[i * 4 + 1] = g;
      td[i * 4 + 2] = b;
    }
    sd.colorTexture.unlock();

    // 3b. 추가 splat group (도어 entity) 의 splatColor 전체 노랑 칠.
    //   doorFullScene = doorOrigScene + doorSubsScene 모두 이 entity 에 있음 → 한 번 칠하면 sub 까지 모두 노랑.
    if (doorSubGsplatIdRef.current) {
      const id = doorSubGsplatIdRef.current;
      const doorEnt = additional.getEntity(id);
      const gsplatComp = (doorEnt as any)?.gsplat;
      const doorAsset = gsplatComp?.asset;
      // PlayCanvas 2.x: 여러 경로 시도. 일부 빌드에서 asset.resource 가 비어있고
      // gsplat.instance.resource 또는 gsplat.instance.splatData 에 있음.
      const doorRes = doorAsset?.resource
        ?? gsplatComp?.instance?.resource
        ?? gsplatComp?.instance?.splatData;
      const doorColorTex = doorRes?.streams?.textures?.get('splatColor')
        ?? gsplatComp?.material?.colorMap
        ?? gsplatComp?.instance?.material?.colorMap;
      const expectedN = doorRes?.gsplatData?.numSplats ?? doorRes?.numSplats;
      if (!doorColorTex) {
        console.warn('[DoorPreview] doorColorTex not found. 사용 가능한 키:', {
          hasEnt: !!doorEnt,
          hasAsset: !!doorAsset,
          hasRes: !!doorRes,
          gsplatCompKeys: gsplatComp ? Object.keys(gsplatComp) : [],
          assetKeys: doorAsset ? Object.keys(doorAsset) : [],
          assetResource: doorAsset?.resource,
          instanceKeys: gsplatComp?.instance ? Object.keys(gsplatComp.instance) : [],
        });
      } else {
        const dt = doorColorTex.lock();
        if (!dt) {
          console.warn('[DoorPreview] doorColorTex.lock() returned null');
        } else {
          if (!doorGsplatOrigColorsRef.current) {
            doorGsplatOrigColorsRef.current = new Uint16Array(dt);
          }
          let painted = 0;
          for (let i = 0; i < dt.length; i += 4) {
            dt[i + 0] = r;
            dt[i + 1] = g;
            dt[i + 2] = b;
            painted++;
          }
          doorColorTex.unlock();
          console.log(`[DoorPreview] splatColor texture painted: ${painted} pixels (expected ${expectedN} splats, texture ${doorColorTex.width}×${doorColorTex.height}).`);
        }
      }
    } else {
      console.log('[DoorPreview] doorSubGsplatIdRef null — 문 추출 안 한 상태이거나 sub-gsplat 미생성.');
    }

    // 3c. 도어 mesh material 노랑 emissive 칠 (snapshot 으로 복원 가능).
    if (doorMeshEntityRef.current) {
      const meshMat = doorMeshEntityRef.current.render?.meshInstances?.[0]?.material;
      const pcLib = core.getPC();
      if (meshMat && pcLib) {
        if (!doorMeshOrigEmissiveRef.current) {
          const e = meshMat.emissive;
          doorMeshOrigEmissiveRef.current = e ? { r: e.r, g: e.g, b: e.b } : { r: 0, g: 0, b: 0 };
        }
        if (meshMat.emissive?.set) meshMat.emissive.set(1, 1, 0);
        else meshMat.emissive = new pcLib.Color(1, 1, 0);
        meshMat.update?.();
      }
    }
    setDoorInternalShow(true);
  }, [coreRef, doorInternalShow, allPicked, picked, currentUrl, doorThickness, doorRefineActive, additional, planes]);

  const toggleDoorInternalShow = useCallback(() => {
    void setDoorInternalShowAsync(!doorInternalShow);
  }, [setDoorInternalShowAsync, doorInternalShow]);

  // 코너/두께/margin 변경 시 ON 상태면 즉시 refresh (디바운스 없음 — 시각화 set 계산이 가벼워 슬라이더 실시간 OK).
  // (toggle ON 의 직접 호출과 효과를 분리하기 위해 doorInternalShow 는 deps 에서 제외.)
  const setDoorInternalShowAsyncRef = useRef(setDoorInternalShowAsync);
  useEffect(() => { setDoorInternalShowAsyncRef.current = setDoorInternalShowAsync; }, [setDoorInternalShowAsync]);
  useEffect(() => {
    if (!doorInternalShow) return;
    void setDoorInternalShowAsyncRef.current(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, doorThickness, doorRefineActive]);

  // (제거) 문 추출 활성 중엔 문 두께 슬라이더가 disabled 라서 자동 재적용 useEffect 가 더 이상 필요 없음.
  // 사용자가 두께를 바꾸려면 문 추출 취소 → 슬라이더 조정 → 문 추출 순서로만 가능.

  // 모달 언마운트 시 blob URL 만 해제 — 도어 splat/mesh 는 정합 단계까지 유지되어야 하므로 destroy 금지.
  // (이전 시도: 언마운트 시 splat destroy → '문 설정 완료' 직후 mode 전환으로 unmount 발동 → 갓 만든 splat 까지 destroy 되는 버그)
  useEffect(() => {
    return () => {
      if (doorSubBlobUrlRef.current) {
        try { URL.revokeObjectURL(doorSubBlobUrlRef.current); } catch {}
      }
    };
  }, []);

  // 마운트 시 누수 정리: 이전 세션 (DoorAlignModal 재진입 케이스) 의 stale 모듈 도어 splat 제거.
  // 도어 splat 은 '도어 영역 가우시안' name 으로 추가됨. 같은 name + source='local' 인 기존 항목은 stale.
  // basemap 모드는 inMemoryDoors 가 각자의 splat 을 들고 있어 별도 관리 — 이 정리 대상 아님.
  useEffect(() => {
    if (basemapMode) return;
    const stale = additional.items.filter(it => it.name === '도어 영역 가우시안' && it.source === 'local');
    for (const it of stale) {
      console.log(`[DoorSplat:STALE-CLEANUP] removing stale module door splat id=${it.id}`);
      try { additional.remove(it.id); } catch {}
    }
    // mount-once 효과 — eslint dep array intentionally minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 힌지 축 기준 문 회전 (애니메이션) ──
  // 각 프레임에서 angle 만 보간하고 transform 은 그 angle 로 다시 계산 → 힌지 축의 점은 항상 고정.
  // localRot = baseRot ∘ R(angle), localPos = baseRot * (cA − R(angle)·cA)
  //   baseRot = splatEntity.localRotation = Z-180 ∘ pendingRotation. 메인과 동일 변환으로 맞춰 일치 유지.
  const doorAnimRef = useRef<{
    start: number;
    duration: number;
    fromAngleRad: number;
    toAngleRad: number;
    axis: [number, number, number]; // 힌지 단위 벡터 (raw frame)
    cA: [number, number, number];   // 힌지 시작점 (raw frame, 고정점)
  } | null>(null);
  // 현재 누적 회전각 (rad). 다음 회전의 시작각.
  const doorCurrentAngleRef = useRef<number>(0);
  // 마지막에 사용한 힌지 (resetDoorRotation 이 hingeIndices 변경 후에도 같은 축으로 닫기 위해).
  const lastDoorHingeRef = useRef<{ axis: [number, number, number]; cA: [number, number, number] } | null>(null);

  // 매 프레임 angle(t) → transform 적용. 힌지(cA, axis)는 보간에 영향 안 줌 → 회전축 절대 안 움직임.
  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    return core.onUpdate(() => {
      const a = doorAnimRef.current;
      if (!a) return;
      const pc = core.getPC();
      if (!pc) return;
      const tNorm = Math.min(1, (performance.now() - a.start) / a.duration);
      const u = easeInOutCubic(tNorm);
      const angle = a.fromAngleRad + (a.toAngleRad - a.fromAngleRad) * u;
      const half = angle / 2;
      const sH = Math.sin(half), cH = Math.cos(half);
      const qR = new pc.Quat(a.axis[0]*sH, a.axis[1]*sH, a.axis[2]*sH, cH);
      // baseRot = splatEntity 의 현재 회전 (Z-180 ∘ pendingRotation). 메인과 동일.
      const sd = core.getSplatData();
      const sr = sd?.splatEntity?.getLocalRotation();
      const baseRot = sr
        ? new pc.Quat(sr.x, sr.y, sr.z, sr.w)
        : (() => { const q = new pc.Quat(); q.setFromEulerAngles(0, 0, 180); return q; })();
      const localRot = new pc.Quat();
      localRot.copy(baseRot).mul(qR);
      const cAvec = new pc.Vec3(a.cA[0], a.cA[1], a.cA[2]);
      const rotatedCA = new pc.Vec3();
      qR.transformVector(cAvec, rotatedCA);
      const offsetRaw = new pc.Vec3(a.cA[0] - rotatedCA.x, a.cA[1] - rotatedCA.y, a.cA[2] - rotatedCA.z);
      const offsetWorld = new pc.Vec3();
      baseRot.transformVector(offsetRaw, offsetWorld);

      const doorEnt = doorSubGsplatIdRef.current ? additional.getEntity(doorSubGsplatIdRef.current) : null;
      if (doorEnt) {
        doorEnt.setLocalRotation(localRot.x, localRot.y, localRot.z, localRot.w);
        doorEnt.setLocalPosition(offsetWorld.x, offsetWorld.y, offsetWorld.z);
      }
      if (doorMeshEntityRef.current) {
        doorMeshEntityRef.current.setLocalRotation(localRot.x, localRot.y, localRot.z, localRot.w);
        doorMeshEntityRef.current.setLocalPosition(offsetWorld.x, offsetWorld.y, offsetWorld.z);
      }
      if (tNorm >= 1) {
        doorCurrentAngleRef.current = a.toAngleRad;
        doorAnimRef.current = null;
      }
    });
  }, [coreRef, additional]);

  const applyDoorRotation = useCallback(() => {
    if (hingeIndices.length !== 2) {
      setDoorRefineError('힌지로 사용할 두 코너를 선택하세요');
      return;
    }
    if (!allPicked || !planes) return;

    const cA = picked[hingeIndices[0]]!.pos;
    const cB = picked[hingeIndices[1]]!.pos;
    const hxv = cB[0] - cA[0], hyv = cB[1] - cA[1], hzv = cB[2] - cA[2];
    const hLen = Math.hypot(hxv, hyv, hzv) || 1;
    const ax = hxv/hLen, ay = hyv/hLen, az = hzv/hLen;

    // swing 방향 부호 — 힌지 아닌 코너의 cross(axis, d) 가 wall normal 과 동방향이면 +angle = 안쪽.
    const otherIdx = [0,1,2,3].find(i => !hingeIndices.includes(i));
    if (otherIdx === undefined) return;
    const P = picked[otherIdx]!.pos;
    const dxv = P[0] - cA[0], dyv = P[1] - cA[1], dzv = P[2] - cA[2];
    const crossX = ay*dzv - az*dyv;
    const crossY = az*dxv - ax*dzv;
    const crossZ = ax*dyv - ay*dxv;
    const wallSurfaceId = picked[0]!.surfaceId;
    const wallPlane = planes.find(p => p.id === wallSurfaceId);
    if (!wallPlane) return;
    // wallPlane.normal 은 A' 프레임. picked.pos (raw) 와 같은 프레임에서 비교하려면 raw 프레임으로 회전.
    const wn = aToRaw(wallPlane.normal as Vec3, getEditorRotation(uploadId));
    const dotCN = crossX*wn[0] + crossY*wn[1] + crossZ*wn[2];
    // planes.ts 의 normal 은 방 바깥 방향. (axis × d) 가 +wn 방향이면 +θ 회전이 P 를 방 바깥으로 보냄.
    // doorSwing=1 (안쪽) → -wn 방향 → -θ 가 필요 → insideSign=-1.
    // (이전 부호 뒤집기는 이번에 picked.pos / wn 의 raw 프레임 정합 후 원복.)
    const insideSign = dotCN > 0 ? -1 : 1;
    const angleSign = doorSwing * insideSign;
    const angleRad = angleSign * doorAngleDeg * Math.PI / 180;

    const axis: [number, number, number] = [ax, ay, az];
    const cAvec3: [number, number, number] = [cA[0], cA[1], cA[2]];
    lastDoorHingeRef.current = { axis, cA: cAvec3 };

    doorAnimRef.current = {
      start: performance.now(),
      duration: 800,
      fromAngleRad: doorCurrentAngleRef.current,
      toAngleRad: angleRad,
      axis,
      cA: cAvec3,
    };
    setDoorRotated(true);
    setRotationApplied(true);
    setDoorRefineError(null);
    console.log(`[DoorRotate] hinge ${hingeIndices[0]}→${hingeIndices[1]}, ${doorAngleDeg}° ${doorSwing === 1 ? '안쪽' : '바깥쪽'} (insideSign=${insideSign}, from=${(doorCurrentAngleRef.current * 180 / Math.PI).toFixed(1)}° → ${(angleRad * 180 / Math.PI).toFixed(1)}°)`);
  }, [hingeIndices, doorAngleDeg, doorSwing, picked, planes, allPicked]);

  const resetDoorRotation = useCallback(() => {
    // 마지막 사용한 힌지로 angle=0 까지 보간. 없으면 직접 identity 적용.
    const last = lastDoorHingeRef.current;
    if (last) {
      doorAnimRef.current = {
        start: performance.now(),
        duration: 800,
        fromAngleRad: doorCurrentAngleRef.current,
        toAngleRad: 0,
        axis: last.axis,
        cA: last.cA,
      };
    } else {
      const core = coreRef.current;
      const pc = core?.getPC();
      if (pc) {
        const z180 = new pc.Quat();
        z180.setFromEulerAngles(0, 0, 180);
        const doorEnt = doorSubGsplatIdRef.current ? additional.getEntity(doorSubGsplatIdRef.current) : null;
        if (doorEnt) {
          doorEnt.setLocalRotation(z180.x, z180.y, z180.z, z180.w);
          doorEnt.setLocalPosition(0, 0, 0);
        }
        if (doorMeshEntityRef.current) {
          doorMeshEntityRef.current.setLocalRotation(z180.x, z180.y, z180.z, z180.w);
          doorMeshEntityRef.current.setLocalPosition(0, 0, 0);
        }
      }
      doorCurrentAngleRef.current = 0;
    }
    setDoorRotated(false);
  }, [coreRef, additional]);

  // ── 정합 적용 + 저장 (PLY에 변환 적용해 MinIO에 업로드 → 뷰어 리로드) ──
  const applyAndSave = useCallback(async () => {
    setError(null);
    if (!allPicked) { setError('모듈 4 코너를 먼저 추출하세요'); return; }
    if (!basemapCorners) { setError('basemap 4 코너 JSON이 유효하지 않습니다'); return; }
    setRunning(true);
    try {
      const [{ matchCorners }] = await Promise.all([
        import('@/lib/alignment'),
      ]);

      const src = new Float64Array(12);
      const dst = new Float64Array(12);
      for (let i = 0; i < 4; i++) {
        const s = picked[i]!.pos;
        src[i*3] = s[0]; src[i*3+1] = s[1]; src[i*3+2] = s[2];
        const t = basemapCorners[i];
        dst[i*3] = t[0]; dst[i*3+1] = t[1]; dst[i*3+2] = t[2];
      }
      const fit = matchCorners(src, dst);
      setRmsd(fit.rmsd);
      console.log('[DoorAlign] applying transform:', fit);

      // 신흐름: onCommitFinal 가 제공된 경우 일괄 영속화 (다듬기 결과 자산 + 문 + 정합).
      // aligned.ply 는 저장 안 함 (final.ply + alignment_transform 으로 재계산 가능).
      if (onCommitFinal) {
        const pickedTransformed = pendingDoorPersistenceRef.current?.pickedTransformed
          ?? picked;  // 문 설정 단계가 deferPersistenceToAlign 으로 보관한 corners. 없으면 raw picked.
        try {
          await onCommitFinal({
            fit: { R: Array.from(fit.R as any), t: Array.from(fit.t as any), rmsd: fit.rmsd },
            pickedTransformed,
          });
        } catch (e: any) {
          setError(`정합 영속화 실패: ${e?.message ?? e}`);
          setRunning(false);
          return;
        }
        // 호출자 콜백이 라우팅 / 화면 갱신 처리. onDone 은 노출 안 함.
        setRunning(false);
        return;
      }

      // 기존 흐름: aligned.ply 업로드 + /uploads/{id}/alignment 저장.
      const [{ fetchAndParsePly, serializePly }, { applyRigidToScene }] = await Promise.all([
        import('@/lib/ply'),
        import('@/lib/alignment'),
      ]);
      const { api } = await import('@/lib/api');

      const scene = await fetchAndParsePly(currentUrl);
      applyRigidToScene(scene, fit);
      const bytes = serializePly(scene);

      const urlReq = await api.post<{ put_url: string; get_url: string }>(
        '/refine/refined-upload-url',
        { upload_id: uploadId, filename: 'aligned.ply' },
      );
      const put = await fetch(urlReq.put_url, {
        method: 'PUT',
        body: bytes,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!put.ok) throw new Error(`MinIO PUT failed: ${put.status}`);

      // SPEC: 변환행렬 + basemap/door 매칭을 upload-scoped 로 저장.
      // fit.R 은 row-major 3x3, fit.t 는 [x,y,z]. 엔드포인트는 position/rotation(quat)/scale 형태.
      try {
        const [qw, qx, qy, qz] = rotationMatrixToQuat(fit.R);
        await api.post(`/uploads/${uploadId}/alignment`, {
          transform: {
            position: [fit.t[0], fit.t[1], fit.t[2]],
            rotation: [qx, qy, qz, qw],
            scale: [1, 1, 1],
          },
          rmsd: fit.rmsd,
          matches: [{ module_door_id: PRIMARY_DOOR_ID, basemap_id: 'manual' }],
        });
      } catch (e: any) {
        console.warn('[DoorAlign] alignment 저장 실패 (PLY 는 이미 업로드됨)', e);
      }

      // 모듈 코너는 이제 basemap 좌표계로 옮겨졌으니 다음 작업에서 다시 추출
      const empty: Array<PickedCorner | null> = [null, null, null, null];
      setPicked(empty);
      void clearDoorsOnServer(uploadId);

      onDone(urlReq.get_url);
    } catch (e: any) {
      setError(`정합 실패: ${e?.message ?? e}`);
    } finally {
      setRunning(false);
    }
  }, [allPicked, basemapCorners, picked, currentUrl, uploadId, onDone, onCommitFinal]);

  return (
    // 좌측 패널 컬럼 안에 들어가는 일반 블록 — 부모가 layout 결정. 너비 256 (w-64) 로 다듬기 panel 들과 통일.
    <div className="bg-[var(--paper)]/95 border border-[var(--rule)] rounded-lg shadow-2xl text-[var(--ink)] text-xs select-none flex flex-col w-72 max-h-[calc(100vh-200px)] overflow-hidden">
      {autoExtracting && (
        <div className="px-3 py-2 bg-indigo-900/40 border-b border-indigo-700 text-indigo-200 text-[11px] flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-indigo-300 border-t-transparent rounded-full animate-spin" />
          <span>자동 문 추출 진행 중...</span>
        </div>
      )}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--rule)] shrink-0">
        <div className="font-bold">{view === 'align' ? '문 정합' : '문 설정'}</div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 cursor-pointer text-[11px] text-[var(--ink-2)]" title="추출된 코너의 화면 마커 표시">
            <input
              type="checkbox"
              checked={showMarkers}
              onChange={e => setShowMarkers(e.target.checked)}
              className="cursor-pointer accent-blue-500"
            />
            마커 표시
          </label>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer">✕</button>
        </div>
      </div>
      <div className="p-3 space-y-2 overflow-y-auto">
        {showRefineGuide ? (
          <div className="text-red-400 text-[11px] p-2 bg-red-900/30 border border-red-800 rounded leading-tight">
            {view === 'setup'
              ? '다듬기 단계에서 천장/바닥과 벽면을 먼저 확정하세요.'
              : '다듬기 단계에서 천장/바닥과 벽면을 먼저 확정한 뒤 정합 단계로 진입하세요.'}
          </div>
        ) : null}

        {/* 문 설정 (꼭짓점 / 두께 / 문 추출 / 회전 / 문 설정 완료) — setup view 에서만 표시 */}
        {view === 'setup' && <>

        {/* 단일 순차 픽 토글 + 진행 상태 */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (seqArmed) {
                // 진행 중에 다시 누르면 취소 — ESC 와 동일하게 픽 전부 초기화.
                setSeqArmed(false);
                setPicked(emptyPicked());
        
                setError(null);
                return;
              }
              // 새로 시작: 문 추출 활성이면 끄고, 그 뒤에 적용했던 모든 결과 (hinge/회전/도어 entity/mesh/...) 정리.
              if (doorRefineActive
                  || boundarySnapshotRef.current.length > 0
                  || doorSubGsplatIdRef.current
                  || doorMeshEntityRef.current) {
                void revertDoorRefine();
              } else {
                // revert 가 자동으로 처리하지 않는 케이스 — 문 추출 비활성 상태에서도 잔여 hinge 선택만 남아있을 수 있음.
                setHingeEdge(null);
                setEdgePickArmed(false);
                hoveredEdgeRef.current = null;
                setDoorRotated(false);
                setRotationApplied(false);
              }
              setPicked(emptyPicked());

              setError(null);
              setSeqArmed(true);
              onManualPickStart?.();   // 자동 추출 중이면 부모가 autoExtracting=false 로 내림.
            }}
            disabled={!planes}
            className={`flex-1 w-1/2 px-3 py-1.5 rounded text-[11px] font-bold cursor-pointer disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted-2)] disabled:cursor-not-allowed ${
              seqArmed ? 'bg-yellow-500 hover:bg-yellow-400 text-black' : 'bg-blue-600 hover:bg-blue-500 text-[var(--ink)]'
            }`}
          >
            {seqArmed ? '문 수동 지정 중' : '문 수동 지정'}
          </button>
          {/* 문 경계 표시 토글 — 4 변 노란선 + 힌지 cylinder 둘 다 켜고/끔. */}
          <button
            onClick={() => setBoundaryVisible(v => !v)}
            className={`flex-1 w-1/2 px-3 py-1.5 rounded text-[11px] font-bold cursor-pointer ${
              boundaryVisible
                ? 'bg-yellow-500 hover:bg-yellow-400 text-black'
                : 'bg-[var(--bg-soft)] hover:bg-[var(--rule)] text-[var(--ink)]'
            }`}
            title="4 코너 노란선 + 힌지 원기둥 표시 토글"
          >
            {boundaryVisible ? '문 경계 표시 OFF' : '문 경계 표시'}
          </button>
        </div>

        {/* 코너 상태 표시 — DISPLAY_ORDER (TL, TR, BL, BR) 로 자연스러운 2x2 배치
            seqArmed 진행 중일 때 다음 선택할 코너만 옅은 하늘색 highlight. */}
        <div className="grid grid-cols-2 gap-1">
          {DISPLAY_ORDER.map(i => {
            const c = CORNERS[i];
            const p = picked[i];
            const nextIdx = picked.findIndex(pp => pp === null);
            const isNext = seqArmed && i === nextIdx;
            return (
              <div key={c.id} className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] ${
                isNext ? 'bg-sky-500/25 ring-1 ring-sky-400/60' : 'bg-[var(--bg-soft)]/50'
              }`}>
                <div className="w-3 h-3 rounded-full shrink-0 border border-white/30" style={{ backgroundColor: c.hex }} />
                <span className="text-[var(--ink-2)] flex-1 truncate">{c.label}</span>
                <span className={p ? 'text-green-400' : 'text-[var(--muted-2)]'}>{p ? '✓' : '—'}</span>
              </div>
            );
          })}
        </div>

        {error && <div className="text-red-400 text-[11px]">{error}</div>}

        {!allPicked && picked.some(Boolean) && (
          <button
            type="button"
            onClick={() => {
              // 진행 중인 픽 초기화 — 사용자가 잘못 찍었거나 다시 시작하고 싶을 때.
              setPicked(emptyPicked());
            }}
            className="w-full px-3 py-1.5 rounded text-xs text-center font-bold bg-[var(--bg-soft)] text-[var(--ink-2)] hover:bg-[var(--bg-soft)] transition cursor-pointer"
          >
            취소
          </button>
        )}


        {/* ── 문 추출하기 (메인 PLY 에서 도어 영역 분리 → mesh + 추가 splat group) — 4 점 픽 + 자동 추출 미진행 시에만 활성. */}
        <div className={`border-t border-[var(--rule)] pt-2 space-y-1.5 ${(!allPicked || autoExtracting) ? 'opacity-40 pointer-events-none' : ''}`}>
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-bold text-[var(--ink)]">문 추출하기</div>
            <span className="text-[10px]">
              {doorRefineActive
                ? <span className="text-green-400">추출됨</span>
                : <span className="text-[var(--muted-2)]">미추출</span>}
            </span>
          </div>

          {/* 문 두께 — 벽 평면에서 방 안쪽으로 들어가는 단방향 깊이. 문 추출 비활성일 때만 조정 가능. */}
          <div
            className="flex items-center gap-1.5 text-[10px]"
            title={doorRefineActive ? '문 추출을 비활성화하세요.' : '벽 평면에서 방 안쪽으로 [N]cm 깊이 안의 가우시안을 도어 영역으로 분류. 손잡이/잠금처럼 돌출된 부분이 빠지면 값을 키우세요.'}
          >
            <span className="text-[var(--muted)] w-16">문 두께 (안쪽)</span>
            <input type="range" min={0.02} max={0.5} step={0.005}
              value={doorThickness}
              disabled={doorRefineActive}
              onChange={e => setDoorThickness(parseFloat(e.target.value))}
              className="flex-1 accent-purple-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40" />
            <span className="text-[var(--ink)] font-mono w-12 text-right">
              {(doorThickness * 100).toFixed(1)}cm
            </span>
          </div>

          {doorRefineError && (
            <div className="text-red-400 text-[11px]">{doorRefineError}</div>
          )}

          {/* 문 가장자리 정제 — 문 추출 전에 먼저 켜둘 수 있음. ON 시 boundary 가우시안 split (SAGS-style). */}
          <label className="flex items-center gap-1.5 text-[10px] cursor-pointer text-[var(--ink-2)]">
            <input
              type="checkbox"
              checked={boundarySplitEnabled}
              onChange={e => setBoundarySplitEnabled(e.target.checked)}
              className="cursor-pointer accent-cyan-500"
            />
            <span>문 가장자리 정제</span>
          </label>

          {/* 문 영역 확인 (좌) + 문 추출/문 추출 취소 (우) — 50/50 한 행 */}
          <div className="flex gap-1.5">
            <button
              onClick={toggleDoorInternalShow}
              disabled={!allPicked}
              className={`flex-1 px-3 py-1.5 rounded cursor-pointer text-xs font-bold disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] ${
                doorInternalShow
                  ? 'bg-yellow-500 hover:bg-yellow-400 text-black'
                  : 'bg-[var(--bg-soft)] hover:bg-[var(--rule)] text-[var(--ink)]'
              }`}
              title="현재 문 두께 설정 기준 도어 영역 가우시안 + 메시를 노랑으로 표시"
            >
              {doorInternalShow ? '문 영역 확인 OFF' : '문 영역 확인'}
            </button>
            <button
              onClick={() => { if (doorRefineActive) revertDoorRefine(); else applyDoorRefine(); }}
              disabled={!allPicked || doorRefining}
              className={`flex-1 px-3 py-1.5 rounded cursor-pointer text-xs font-bold disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] ${
                doorRefineActive
                  ? 'bg-amber-600 hover:bg-amber-500 text-[var(--ink)]'
                  : 'bg-blue-600 hover:bg-blue-500 text-[var(--ink)]'
              }`}
            >
              {doorRefining ? '처리 중...' : (doorRefineActive ? '문 추출 취소' : '문 추출')}
            </button>
          </div>

        </div>

        {/* ── 문 회전 (힌지 + 각도 + 방향) — 모듈 등록에서만. ──
            basemap 등록은 문 위치만 마킹하면 충분 (회전 메타는 모듈측 데이터 — 정합 후 모듈의 회전 파라미터 사용). */}
        {!basemapMode && <div
          className={`border-t border-[var(--rule)] pt-2 space-y-1.5 ${(doorRefineActive && !autoExtracting) ? '' : 'opacity-40 pointer-events-none'}`}
          title={doorRefineActive ? '' : '먼저 문 추출 을 누르세요.'}
        >
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-bold text-[var(--ink)]">문 회전</div>
            <span className="text-[10px]">
              {doorRotated
                ? <span className="text-green-400">회전 적용</span>
                : <span className="text-[var(--muted-2)]">회전 미적용</span>}
            </span>
          </div>

          {/* 회전축 변 선택 — 단일 버튼. */}
          <button
            onClick={() => {
              if (edgePickArmed) {
                setEdgePickArmed(false);
                hoveredEdgeRef.current = null;
              } else {
                setHingeEdge(null);
                setEdgePickArmed(true);
              }
            }}
            disabled={!allPicked || !doorRefineActive}
            className={`w-full px-2 py-1.5 rounded text-[11px] font-bold cursor-pointer disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted-2)] disabled:cursor-not-allowed ${
              edgePickArmed || hingeEdge !== null
                ? 'bg-yellow-500 hover:bg-yellow-400 text-black'
                : 'bg-blue-600 hover:bg-blue-500 text-[var(--ink)]'
            }`}
          >
            {hingeEdge !== null && !edgePickArmed ? '회전축 재선택' : '회전축 선택'}
          </button>

          {/* 회전각 슬라이더 */}
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-[var(--muted)] w-16">회전각</span>
            <input type="range" min={0} max={120} step={1}
              value={doorAngleDeg}
              disabled={!doorRefineActive}
              onChange={e => setDoorAngleDeg(parseFloat(e.target.value))}
              className="flex-1 accent-cyan-500 cursor-pointer disabled:opacity-40" />
            <span className="text-[var(--ink)] font-mono w-12 text-right">{doorAngleDeg}°</span>
          </div>

          {/* 방향 토글 */}
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="text-[var(--muted)] w-16">회전 방향</span>
            <button
              onClick={() => setDoorSwing(1)}
              disabled={!doorRefineActive}
              className={`flex-1 px-2 py-1 rounded text-[10px] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${doorSwing === 1 ? 'bg-blue-600 text-[var(--ink)]' : 'bg-[var(--bg-soft)] text-[var(--ink-2)] hover:bg-[var(--rule)]'}`}
            >방 안쪽</button>
            <button
              onClick={() => setDoorSwing(-1)}
              disabled={!doorRefineActive}
              className={`flex-1 px-2 py-1 rounded text-[10px] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${doorSwing === -1 ? 'bg-blue-600 text-[var(--ink)]' : 'bg-[var(--bg-soft)] text-[var(--ink-2)] hover:bg-[var(--rule)]'}`}
            >방 바깥쪽</button>
          </div>

          <button
            onClick={() => { if (doorRotated) resetDoorRotation(); else applyDoorRotation(); }}
            disabled={hingeIndices.length !== 2 || !doorRefineActive}
            title={!doorRefineActive ? '먼저 문 추출 을 누르세요.' : (hingeIndices.length !== 2 ? '회전축 변을 먼저 선택' : '')}
            className={`w-full px-3 py-1.5 rounded cursor-pointer text-xs font-bold disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] ${
              doorRotated ? 'bg-amber-600 hover:bg-amber-500 text-[var(--ink)]' : 'bg-blue-600 hover:bg-blue-500 text-[var(--ink)]'
            }`}
          >
            {doorRotated ? '문 닫기' : '문 열기'}
          </button>
        </div>}

        {/* basemap 다중 도어 목록 — 추출한 도어가 순서대로 누적. 각 항목: 호수 + X. */}
        {basemapMode && (
          <div className="border-t border-[var(--rule)] pt-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-bold text-[var(--ink)]">등록된 문 ({inMemoryDoors.length}개)</div>
            </div>
            {inMemoryDoors.length === 0 ? (
              <p className="text-[10px] text-[var(--muted)] italic px-1">4점 픽 → 자동 추출 → 자동으로 이 목록에 추가</p>
            ) : (
              <div className="max-h-32 overflow-y-auto space-y-1 pr-1">
                {inMemoryDoors.map((d) => {
                  const unset = !d.unitName;
                  return (
                    <div
                      key={d.doorId}
                      className={`flex items-stretch rounded transition cursor-pointer ${
                        unset
                          ? 'bg-yellow-900/40 border border-yellow-600/60 hover:bg-yellow-900/60'
                          : 'bg-[var(--bg-soft)]/60 border border-[var(--rule)] hover:bg-[var(--bg-soft)]'
                      }`}
                      onClick={() => setUnitNamePickerOpen({ doorId: d.doorId, initialSuffix: 1 })}
                      title={unset ? '클릭해서 호수를 설정' : '클릭해서 호수 변경'}
                    >
                      <div className="flex-1 min-w-0 px-2 py-1.5 flex items-center gap-1.5">
                        <span className="text-yellow-400 text-[10px]">{unset ? '⚠️' : '🚪'}</span>
                        <div className="flex-1 min-w-0">
                          <div className={`text-[11px] font-medium truncate ${unset ? 'text-yellow-200' : 'text-[var(--ink)]'}`}>
                            {d.unitName || '호수 미설정'}
                          </div>
                          {unset && (
                            <div className="text-[9px] text-yellow-400/80 mt-0.5">클릭해서 호수 설정</div>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          // 도어 entity / outline / splat layer 정리.
                          try { d.outlineHandle?.destroy(); } catch {}
                          try {
                            // wrapper (basemapDoor_<doorId>) 가 mesh + splat 의 부모 — wrapper destroy 시 자식 cascade.
                            const wrapper = findEntityByName(coreRef.current?.getApp()?.root, `basemapDoor_${d.doorId}`);
                            if (wrapper) {
                              wrapper.destroy();
                            } else {
                              // fallback (wrapper 가 없으면 mesh 만 정리)
                              const ent = findEntityByName(coreRef.current?.getApp()?.root, d.doorMeshEntityName);
                              if (ent) ent.destroy();
                            }
                          } catch {}
                          if (d.doorSplatLayerId) {
                            try { additional.remove(d.doorSplatLayerId); } catch {}
                          }
                          // 벽 텍스처 alpha=0 punch 복원 — cut.rgba 를 원위치 bbox 에 다시 paste.
                          try {
                            const bbox = d.wallTextureSnapshotRect;
                            const meshInput = d.doorMeshInput;
                            if (bbox && meshInput.rgba.length > 0) {
                              const wallEntName = `wallMesh_${d.wallSurfaceId}`;
                              const wallEnt = findEntityByName(coreRef.current?.getApp()?.root, wallEntName);
                              const tex = wallEnt?.render?.meshInstances?.[0]?.material?.emissiveMap;
                              if (tex) {
                                const td = tex.lock() as Uint8ClampedArray | null;
                                if (td) {
                                  const W = tex.width;
                                  for (let y = 0; y < bbox.h; y++) {
                                    const srcRow = y * bbox.w * 4;
                                    const dstRow = ((bbox.y + y) * W + bbox.x) * 4;
                                    for (let x = 0; x < bbox.w * 4; x++) {
                                      td[dstRow + x] = meshInput.rgba[srcRow + x];
                                    }
                                  }
                                  tex.unlock();
                                }
                              }
                            }
                          } catch (err) {
                            console.warn('[basemap door X delete] wall 텍스처 복원 실패:', err);
                          }
                          setInMemoryDoors(prev => prev.filter(it => it.doorId !== d.doorId));
                        }}
                        className="px-2 flex items-center text-[var(--muted)] hover:text-red-400 hover:bg-red-500/10 transition rounded-r"
                        aria-label="도어 삭제"
                        title="도어 목록에서 삭제"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {commitError && (
              <p className="text-[10px] text-red-400">{commitError}</p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          {/* "문 설정 완료" 버튼 — 모듈 모드 전용. basemap 다중 도어 신흐름은 자동 push + 별도 "Basemap 등록 완료". */}
          {!basemapMode && <button
            onClick={async () => {
              if (!allPicked) return;
              setSaveDoorBusy(true);
              try {
                // 1) 모듈 정보 모달 + uploadId 확정 — 모든 케이스에서 강제. 모달 dismiss 시 작업 유지.
                let activeUploadId: string | null = null;
                if (ensureUploadId) {
                  try { activeUploadId = await ensureUploadId(); }
                  catch { setSaveDoorBusy(false); return; }
                } else {
                  activeUploadId = uploadId || null;
                }
                if (!activeUploadId) { setSaveDoorBusy(false); return; }

                // 2) 베이크 회전값을 동기 조회 (서버 업로드 await 없이 즉시).
                //    SPEC: refined PLY 가 A'+Y 프레임 (pendingRotation rotX/rotZ + wallAngle Y) 으로 베이크되므로
                //    picked 코너 (raw) 도 같은 변환 적용해 doors.json 에 저장.
                const r = getCurrentBakedRotation?.() ?? { rotX: 0, rotZ: 0, wallAngleRad: 0 };
                const cx = Math.cos(r.rotX), sx = Math.sin(r.rotX);
                const cz = Math.cos(r.rotZ), sz = Math.sin(r.rotZ);
                const cy2 = Math.cos(r.wallAngleRad), sy2 = Math.sin(r.wallAngleRad);
                const rotXZ = (v: [number, number, number]): [number, number, number] => [
                  cz * v[0] - sz * cx * v[1] + sz * sx * v[2],
                  sz * v[0] + cz * cx * v[1] - cz * sx * v[2],
                  sx * v[1] + cx * v[2],
                ];
                const rotYy = (v: [number, number, number]): [number, number, number] => [
                  cy2 * v[0] + sy2 * v[2],
                  v[1],
                  -sy2 * v[0] + cy2 * v[2],
                ];
                const rotateForSave = (p: PickedCorner): PickedCorner => ({
                  pos: rotYy(rotXZ([p.pos[0], p.pos[1], p.pos[2]])),
                  surfaceId: p.surfaceId,
                });
                // 베이스맵 레거시 흐름 (persistDoorsToServer) 은 A'+Y 프레임 corners 가 필요. 별도 변환본 보관.
                const pickedTransformed = picked.map(p => p ? rotateForSave(p) : null);
                // 자동/수동 무관 — 4점 raw 프레임 그대로 부모에 전달.
                //   런타임 정합용: 모듈 entities (splat/walls/doorMesh) 가 raw 데이터 + Z-180 로 동작 → AlignPanel 도 raw → Z-180 한 번 적용해서 일관.
                //   서버 영속용 (commit-final): 부모가 그 시점에 rawToAY 로 A'+Y 변환해 doors.json 에 저장 (baked PLY 와 동일 프레임).
                if (onSetupCornersFinalized) {
                  const cornersOnly = picked
                    .filter((p): p is PickedCorner => p !== null)
                    .map((p): [number, number, number] => [p.pos[0], p.pos[1], p.pos[2]]);
                  if (cornersOnly.length === 4) {
                    onSetupCornersFinalized(cornersOnly);
                  }
                }
                // 모듈 모드 doorOpts — 회전 메타 (hingeEdge/swing/angleDeg) 포함.
                //   (basemap 도어 옵션은 신흐름 "Basemap 등록 완료" 핸들러 안에서 직접 구성.)
                const doorOpts: PersistOpts = {
                  doorId: PRIMARY_DOOR_ID,
                  hingeEdge,
                  swing: doorSwing,
                  angleDeg: doorAngleDeg,
                  wallSurfaceId: picked[0]!.surfaceId,
                  doorThickness,
                  boundarySplitEnabled,
                  safetyMargin: DOOR_SAFETY_MARGIN,
                };

                // 3) 화면 즉시 정합 단계로 전환 — 메모리 자산 그대로 사용.
                //    모듈 흐름은 pickedTransformed (A'+Y 프레임) 의 4 코너를 부모에 전달 →
                //    서버 doors.json 재fetch 없이 즉시 moduleDoorCorners 에 주입 가능.
                const cornersForParent = !basemapMode && pickedTransformed.every(c => c !== null)
                  ? (pickedTransformed as PickedCorner[]).map(c => [c.pos[0], c.pos[1], c.pos[2]] as [number, number, number])
                  : null;
                if (onSetupSaveDone) {
                  try { await onSetupSaveDone(activeUploadId, cornersForParent); }
                  catch { setSaveDoorBusy(false); return; }
                }
                setSaveDoorToast('정합 단계로 이동 ✓');

                // 4) 백그라운드 저장 — 신흐름(모듈 등록)에선 스킵. 정합 완료 시 일괄 영속화.
                if (!deferPersistenceToAlign) {
                  const idForBg = activeUploadId;
                  void (async () => {
                    try {
                      if (onCommitRefined) {
                        await onCommitRefined(idForBg);
                      }
                      await persistDoorsToServer(idForBg, pickedTransformed, doorOpts);
                    } catch (e: any) {
                      console.warn('[Setup] 백그라운드 저장 실패:', e);
                    }
                  })();
                } else {
                  // 신흐름: pickedTransformed 와 doorOpts 를 ref 에 보관 → 정합 완료 시 onCommitFinal 페이로드 구성.
                  pendingDoorPersistenceRef.current = { pickedTransformed, doorOpts };
                }
              } catch (e: any) {
                setSaveDoorToast(`실패: ${e?.message ?? e}`);
              } finally {
                setSaveDoorBusy(false);
                setTimeout(() => setSaveDoorToast(null), 2000);
              }
            }}
            // 본 버튼은 모듈 모드 전용 (basemap 은 신흐름 "Basemap 등록 완료" 버튼 별도).
            disabled={!allPicked || saveDoorBusy || autoExtracting || hingeEdge === null || !rotationApplied}
            title={
              autoExtracting ? '자동 문 추출 진행 중...' :
              !allPicked ? '4 꼭짓점을 모두 찍은 후 저장' :
              hingeEdge === null ? '회전축을 먼저 선택하세요' :
              !rotationApplied ? '문 열기를 한 번 눌러 회전각/회전 방향을 확정하세요' :
              '도어 설정 (corners, hinge, 회전각, 회전방향, doorThickness 등) 즉시 영속화'
            }
            className="w-full px-3 py-1.5 rounded cursor-pointer text-xs font-bold bg-green-700 hover:bg-green-600 text-[var(--ink)] disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] disabled:cursor-not-allowed"
          >
            {saveDoorBusy ? '저장 중...' : (saveDoorToast ?? '문 설정 완료')}
          </button>}
          {basemapMode && (() => {
            const unsetCount = inMemoryDoors.filter(d => !d.unitName).length;
            const noDoor = inMemoryDoors.length === 0;
            const disabled = committing || noDoor || unsetCount > 0;
            return (
              <button
                type="button"
                onClick={async () => {
                  setCommitError(null);
                  setCommitting(true);
                  try {
                    // 1) uploadId 확보 (register-local-basemap)
                    let activeUploadId: string | null = uploadId || null;
                    if (!activeUploadId && ensureUploadId) {
                      activeUploadId = await ensureUploadId();
                    }
                    if (!activeUploadId) throw new Error('uploadId 확보 실패');

                    // 2) basemap PLY 저장 전 — 모든 inMemoryDoors 의 doorOriginalIndices 를 origColorData alpha=0 으로 일괄 마킹.
                    //    각 도어 추출 후 다음 도어 추출 시 revertDoorRefine 가 마킹을 풀어버리므로 저장 직전 재적용 필요.
                    //    이게 적용돼야 commitRefinedToServer 의 keep 마스크가 도어 영역 가우시안을 자동으로 PLY 에서 제외.
                    try {
                      const sd = coreRef.current?.getSplatData?.();
                      const core = coreRef.current;
                      const float2HalfFn = core?.float2Half;
                      if (sd?.origColorData && float2HalfFn) {
                        const halfZero = float2HalfFn(0);
                        let markedCount = 0;
                        for (const d of inMemoryDoorsRef.current) {
                          for (const idx of d.doorOriginalIndices) {
                            sd.origColorData[idx * 4 + 3] = halfZero;
                            markedCount++;
                          }
                        }
                        console.log(`[BasemapCommit] origColorData alpha=0 marked: ${markedCount} doorOrig 가우시안 (${inMemoryDoorsRef.current.length} 개 도어)`);
                      }
                    } catch (e) {
                      console.warn('[BasemapCommit] origColorData 마킹 실패:', e);
                    }

                    // 3) basemap PLY + mesh.json + tex_*.png 업로드 (onCommitRefined 가 처리)
                    if (onCommitRefined) {
                      await onCommitRefined(activeUploadId);
                    }

                    // 3) 각 도어의 자산 (PNG + PLY) 업로드 + DoorMeta 작성
                    const doorMetas: PickedCorner[][] = [];  // placeholder — 실제론 doors.json 페이로드 만듦
                    const allDoors = inMemoryDoorsRef.current;
                    const doorEntries: Array<{
                      id: string;
                      corners: number[][];
                      unitName: string;
                      wallSurfaceId: string;
                      doorThickness: number;
                      boundarySplitEnabled: boolean;
                      safetyMargin: number;
                      doorMesh?: { corners: number[][]; uvs: number[][]; normalInward: number[]; textureFilename: string; textureWidth: number; textureHeight: number };
                      doorSplat?: { filename: string };
                    }> = [];
                    for (const d of allDoors) {
                      const entry: typeof doorEntries[0] = {
                        id: d.doorId,
                        corners: d.cornersAY.map(c => [c[0], c[1], c[2]]),
                        unitName: d.unitName,
                        wallSurfaceId: d.wallSurfaceId,
                        doorThickness: d.doorThickness,
                        boundarySplitEnabled: d.boundarySplitEnabled,
                        safetyMargin: d.safetyMargin,
                      };
                      // 도어 mesh 텍스처 PNG 업로드
                      if (d.doorMeshInput.rgba.length > 0) {
                        const rgbaToPng = async (rgba: Uint8ClampedArray, w: number, h: number): Promise<Blob> => {
                          const canvas = document.createElement('canvas');
                          canvas.width = w; canvas.height = h;
                          const ctx = canvas.getContext('2d');
                          if (!ctx) throw new Error('canvas 2d ctx failed');
                          ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
                          return await new Promise<Blob>((res, rej) => {
                            canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/png');
                          });
                        };
                        const pngBlob = await rgbaToPng(d.doorMeshInput.rgba, d.doorMeshInput.width, d.doorMeshInput.height);
                        const texUrl = await api.post<{ put_url: string; key: string }>(
                          '/refine/refined-upload-url',
                          { upload_id: activeUploadId, filename: `tex_${d.doorId}.png` },
                        );
                        const texResp = await fetch(texUrl.put_url, {
                          method: 'PUT', body: pngBlob, headers: { 'Content-Type': 'image/png' },
                        });
                        if (!texResp.ok) throw new Error(`도어 ${d.doorId} 텍스처 업로드 실패: ${texResp.status}`);
                        entry.doorMesh = {
                          corners: d.doorMeshInput.corners.map(c => [c[0], c[1], c[2]]),
                          uvs: d.doorMeshInput.uvs.map(u => [u[0], u[1]]),
                          normalInward: [d.doorMeshInput.normalInward[0], d.doorMeshInput.normalInward[1], d.doorMeshInput.normalInward[2]],
                          textureFilename: texUrl.key,
                          textureWidth: d.doorMeshInput.width,
                          textureHeight: d.doorMeshInput.height,
                        };
                      }
                      // 도어 splat PLY 업로드 — raw 프레임 데이터를 A'+Y 로 베이크 후 업로드.
                      // (basemap 메인 PLY 가 A'+Y 베이크되므로 도어 splat 도 같은 프레임 유지 → 재로드 시 정렬됨)
                      if (d.doorSplatBlobUrl) {
                        const blobResp = await fetch(d.doorSplatBlobUrl);
                        const arrayBuf = await blobResp.arrayBuffer();
                        const { parsePly, serializePly } = await import('@/lib/ply');
                        const { rotateScene, rotateSceneY } = await import('@/lib/gs');
                        const doorScene = parsePly(arrayBuf);
                        const br = d.bakeRotation;
                        if (br.rotX !== 0 || br.rotZ !== 0) rotateScene(doorScene, br.rotX, br.rotZ);
                        if (br.wallAngleRad !== 0) rotateSceneY(doorScene, br.wallAngleRad);
                        const bakedBytes = serializePly(doorScene);
                        const plyUrl = await api.post<{ put_url: string; key: string }>(
                          '/refine/refined-upload-url',
                          { upload_id: activeUploadId, filename: `${d.doorId}.ply` },
                        );
                        const plyResp = await fetch(plyUrl.put_url, {
                          method: 'PUT', body: bakedBytes as unknown as BlobPart, headers: { 'Content-Type': 'application/octet-stream' },
                        });
                        if (!plyResp.ok) throw new Error(`도어 ${d.doorId} splat 업로드 실패: ${plyResp.status}`);
                        entry.doorSplat = { filename: plyUrl.key };
                      }
                      doorEntries.push(entry);
                    }

                    // 4) doors.json PUT
                    await api.put(`/uploads/${activeUploadId}/doors`, { doors: doorEntries });

                    // 5) /basemaps/register 직접 호출.
                    //    (기존 onSetupSaveDone 의 basemap 분기는 자동 /dashboard redirect 가 있어 신흐름 완료 모달과 충돌. 우회.)
                    await api.post('/basemaps/register', { upload_id: activeUploadId });

                    // 6) 완료 모달 표시 — 사용자가 라우팅 선택 (onBasemapDone 콜백).
                    setCompletionModalOpen(true);
                    void doorMetas;  // unused — 위 placeholder
                  } catch (e: any) {
                    setCommitError(`등록 실패: ${e?.message ?? e}`);
                  } finally {
                    setCommitting(false);
                  }
                }}
                disabled={disabled}
                title={
                  noDoor ? '먼저 문을 1개 이상 추출하세요' :
                  unsetCount > 0 ? `${unsetCount}개 도어의 호수가 미설정입니다` :
                  committing ? '저장 중...' :
                  '모든 도어를 일괄 영속화하고 basemap 활성화'
                }
                className="w-full px-3 py-2 rounded cursor-pointer text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-[var(--ink)] disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] disabled:cursor-not-allowed"
              >
                {committing ? '저장 중...' : 'Basemap 등록 완료'}
              </button>
            );
          })()}
        </div>

        </>}

        {/* 정합 단계 UI 는 새 AlignPanel (UnifiedSplatEditor 측) 으로 이전됨.
            DoorAlignModal 은 'setup' view 만 사용. (구 view='align' UI 는 제거됨.) */}
      </div>

      {/* basemap 다중 도어 — 호수 휠 피커 모달 */}
      {basemapMode && unitNamePickerOpen && (
        <DoorUnitNamePickerModal
          floorNumber={basemapFloorNumber ?? 1}
          initialSuffix={unitNamePickerOpen.initialSuffix}
          onConfirm={(unitName) => {
            const did = unitNamePickerOpen.doorId;
            setInMemoryDoors(prev => prev.map(d => d.doorId === did ? { ...d, unitName } : d));
            setUnitNamePickerOpen(null);
          }}
          onCancel={() => setUnitNamePickerOpen(null)}
        />
      )}

      {/* basemap 등록 완료 — 페이지 이동 선택 모달 (화면 정중앙, 큰 사이즈) */}
      {basemapMode && completionModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div className="bg-[var(--paper)] border border-[var(--rule)] rounded-2xl px-10 py-9 w-full max-w-2xl shadow-2xl">
            <div className="flex items-center justify-center mb-5">
              <div className="w-16 h-16 rounded-full bg-green-500/15 border border-green-500/50 flex items-center justify-center">
                <svg className="w-9 h-9 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
            <h3 className="text-2xl font-bold text-[var(--ink)] text-center">Basemap 등록이 완료되었습니다</h3>
            <p className="mt-3 text-base text-[var(--ink-2)] text-center">이동할 페이지를 선택해주세요</p>
            <div className="mt-8 flex items-center gap-3">
              <button
                type="button"
                onClick={() => onBasemapDone?.('main')}
                className="flex-1 px-4 py-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-[var(--ink)] text-base font-bold transition"
              >메인 페이지</button>
              <button
                type="button"
                onClick={() => onBasemapDone?.('building')}
                className="flex-1 px-4 py-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-[var(--ink)] text-base font-bold transition"
              >건물 페이지</button>
              <button
                type="button"
                onClick={() => onBasemapDone?.('dashboard')}
                className="flex-1 px-4 py-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-[var(--ink)] text-base font-bold transition"
              >대시보드</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── basemap 다중 도어 호수 휠 피커 (iOS 알람 스타일) ──
const ROOM_PICKER_ITEM_HEIGHT = 44;
const ROOM_PICKER_VISIBLE_PADDING = ROOM_PICKER_ITEM_HEIGHT * 2;

function DoorUnitNamePickerModal({
  floorNumber, initialSuffix, onConfirm, onCancel,
}: {
  floorNumber: number;
  initialSuffix: number;
  onConfirm: (unitName: string) => void;
  onCancel: () => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const settleTimerRef = useRef<number | null>(null);
  const [suffix, setSuffix] = useState(initialSuffix);
  const items = Array.from({ length: 99 }, (_, i) => i + 1);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = (initialSuffix - 1) * ROOM_PICKER_ITEM_HEIGHT;
    }
  }, [initialSuffix]);

  const handleScroll = () => {
    if (!listRef.current) return;
    if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      if (!listRef.current) return;
      const idx = Math.round(listRef.current.scrollTop / ROOM_PICKER_ITEM_HEIGHT);
      setSuffix(Math.max(1, Math.min(99, idx + 1)));
    }, 60);
  };

  const unitName = `${floorNumber}${String(suffix).padStart(2, '0')}호`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-[320px] rounded-xl bg-[var(--paper)] border border-[var(--rule)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-[var(--ink)] text-center">호수를 선택하세요</h3>
        <p className="text-xs text-[var(--muted)] text-center mt-1">Floor {floorNumber}</p>
        <div className="mt-4 relative h-[220px] w-40 mx-auto select-none">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-[44px] rounded-md border-y border-blue-500/60 bg-blue-500/10" />
          <ul
            ref={listRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto"
            style={{ scrollSnapType: 'y mandatory', scrollbarWidth: 'none', paddingTop: ROOM_PICKER_VISIBLE_PADDING, paddingBottom: ROOM_PICKER_VISIBLE_PADDING }}
          >
            {items.map((s) => {
              const display = `${floorNumber}${String(s).padStart(2, '0')}호`;
              const active = suffix === s;
              return (
                <li
                  key={s}
                  style={{ height: ROOM_PICKER_ITEM_HEIGHT, scrollSnapAlign: 'center' }}
                  className={`flex items-center justify-center text-lg transition ${active ? 'text-[var(--ink)] font-bold' : 'text-[var(--muted)]'}`}
                  onClick={() => {
                    listRef.current?.scrollTo({ top: (s - 1) * ROOM_PICKER_ITEM_HEIGHT, behavior: 'smooth' });
                  }}
                >
                  {display}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onCancel} className="flex-1 rounded-md border border-[var(--rule)] hover:bg-[var(--bg-soft)] py-2 text-sm text-[var(--ink-2)]">취소</button>
          <button type="button" onClick={() => onConfirm(unitName)} className="flex-1 rounded-md bg-blue-600 hover:bg-blue-500 py-2 text-sm font-semibold text-[var(--ink)]">{unitName} 설정</button>
        </div>
      </div>
    </div>
  );
}
