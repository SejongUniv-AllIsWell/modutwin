'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SplatViewerCoreRef } from '../SplatViewerCore';
import type { MetadataResult } from '../MetadataPickerModal';
import { api } from '@/lib/api';

interface Props {
  coreRef: React.RefObject<SplatViewerCoreRef>;
  uploadId: string;
  metadata: MetadataResult;
  /** basemap 의 호수 매칭된 문 4 코너. null 이면 매칭 실패 (정합 비활성). */
  basemapDoorCorners: Array<[number, number, number]> | null;
  /** 정합 대상 basemap 도어 ID. doorPivotGroup 에 이 도어 wrapper 만 묶음 (다른 호수 제외). */
  basemapTargetDoorId: string | null;
  /** 정합 대상 basemap 도어의 normalInward (baked = A'+Y 프레임). gap 방향 deterministic 산출에 사용.
   *  미지정이면 rectFit 의 cross-product n 으로 fallback (정합 회전은 정확, gap 방향만 winding 영향). */
  basemapTargetDoorNormalInward: [number, number, number] | null;
  basemapMatchError: string | null;
  /** 모듈측 (현재 작업 중인) 도어의 4 코너 (A'+Y 프레임). null 이면 정합 불가. */
  moduleDoorCorners: Array<[number, number, number]> | null;
  /**
   * 모듈 등록 흐름: 정합 완료 시 호출. 다듬기 결과 자산 + 정합 행렬을 일괄 영속화.
   * 제공되면 module alignment-transform fallback 대신 이 콜백 사용.
   * UnifiedSplatEditor 가 gatherRefinedAssets + commit-final 호출.
   */
  onCommitFinal?: (args: {
    matrix4x4: number[];
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
    rmsd: number | null;
    doorFrame: {
      positions: number[];
      indices: number[];
      color: [number, number, number];
    } | null;
  }) => Promise<void>;
}

type ManualMode = 'translate' | 'rotate' | 'scale';

const ANIM_MAX_MS = 2500;
const ANIM_BASE_MS = 400;

// 모듈/베이스맵 도어 corner pairing — 양측이 각자 자기 방 안에서 도어를 보고 CW [TL,TR,BR,BL] 로 픽한다고
// 가정. 두 방 사이 도어는 양쪽에서 좌우 반전되어 보이므로 mirror [1,0,3,2]:
//   module TL ↔ basemap TR,  module TR ↔ basemap TL,  module BR ↔ basemap BL,  module BL ↔ basemap BR.
const DOOR_CORNER_MIRROR_MAP = [1, 0, 3, 2] as const;

// 정합 문 두께 — basemap facade ↔ module facade 평행 간격. 두 facade 사이를 4면 frame mesh 가 채움.
const DEFAULT_ALIGN_DOOR_THICKNESS = 0.05;  // 5cm
const ALIGN_DOOR_THICKNESS_MIN = 0.001;     // 1mm — 0 이면 z-fight, 1mm 가 최소 분리.
const ALIGN_DOOR_THICKNESS_MAX = 0.5;       // 50cm — 한국 차음벽 두께 200mm 의 두 배 까지.

const DEFAULT_FRAME_COLOR: [number, number, number] = [0.72, 0.65, 0.53];

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// 4×4 (column-major) flat array 16개 추출 — PlayCanvas Mat4.data 와 동일 형식.
function entityWorldMatrix(ent: any): number[] {
  const m = ent.getWorldTransform().data;
  return Array.from(m);
}

// ── 정합 helpers ──────────────────────────────────────────────────────────────

/**
 * 한 entity 를 다른 부모로 이동하면서 world transform 보존.
 * 새 local = newParent.world^-1 × oldParent.world × oldLocal
 */
function reparentPreserveWorld(pc: any, ent: any, newParent: any): void {
  if (!ent || !newParent) return;
  const oldParent = ent.parent;
  const oldParentWorld = oldParent ? oldParent.getWorldTransform().clone() : new pc.Mat4();
  const oldLocalT = ent.getLocalTransform().clone();
  const entWorld = new pc.Mat4().mul2(oldParentWorld, oldLocalT);
  const newParentWorld = newParent.getWorldTransform().clone();
  const newParentWorldInv = newParentWorld.clone().invert();
  const newLocal = new pc.Mat4().mul2(newParentWorldInv, entWorld);
  newParent.addChild(ent);
  const t = new pc.Vec3(), r = new pc.Quat(), s = new pc.Vec3();
  newLocal.getTranslation(t);
  r.setFromMat4(newLocal);
  newLocal.getScale(s);
  ent.setLocalPosition(t.x, t.y, t.z);
  ent.setLocalRotation(r.x, r.y, r.z, r.w);
  ent.setLocalScale(s.x, s.y, s.z);
}

function anisotropicRectToMat4(pc: any, R: number[], scale: [number, number, number], t: number[]): any {
  const m = new pc.Mat4();
  m.data[0]  = scale[0]*R[0]; m.data[1]  = scale[0]*R[3]; m.data[2]  = scale[0]*R[6]; m.data[3]  = 0;
  m.data[4]  = scale[1]*R[1]; m.data[5]  = scale[1]*R[4]; m.data[6]  = scale[1]*R[7]; m.data[7]  = 0;
  m.data[8]  = scale[2]*R[2]; m.data[9]  = scale[2]*R[5]; m.data[10] = scale[2]*R[8]; m.data[11] = 0;
  m.data[12] = t[0]; m.data[13] = t[1]; m.data[14] = t[2]; m.data[15] = 1;
  return m;
}

function rectCentroid(p: Float64Array): [number, number, number] {
  return [
    (p[0] + p[3] + p[6] + p[9]) * 0.25,
    (p[1] + p[4] + p[7] + p[10]) * 0.25,
    (p[2] + p[5] + p[8] + p[11]) * 0.25,
  ];
}

function rectEdgeLength(p: Float64Array, a: number, b: number): number {
  const ai = a * 3;
  const bi = b * 3;
  return Math.hypot(p[bi] - p[ai], p[bi + 1] - p[ai + 1], p[bi + 2] - p[ai + 2]);
}

function transformPointByRS(
  R: number[],
  scale: [number, number, number],
  p: [number, number, number],
): [number, number, number] {
  return [
    R[0] * scale[0] * p[0] + R[1] * scale[1] * p[1] + R[2] * scale[2] * p[2],
    R[3] * scale[0] * p[0] + R[4] * scale[1] * p[1] + R[5] * scale[2] * p[2],
    R[6] * scale[0] * p[0] + R[7] * scale[1] * p[1] + R[8] * scale[2] * p[2],
  ];
}

function rmsdForRectTransform(
  src: Float64Array,
  dst: Float64Array,
  R: number[],
  scale: [number, number, number],
  t: number[],
): number {
  let sumSq = 0;
  for (let i = 0; i < 4; i++) {
    const p: [number, number, number] = [src[i*3], src[i*3+1], src[i*3+2]];
    const rp = transformPointByRS(R, scale, p);
    const dx = rp[0] + t[0] - dst[i*3];
    const dy = rp[1] + t[1] - dst[i*3+1];
    const dz = rp[2] + t[2] - dst[i*3+2];
    sumSq += dx*dx + dy*dy + dz*dz;
  }
  return Math.sqrt(sumSq / 4);
}

/**
 * 모듈 도어 ↔ 베이스맵 도어 사이 4면 frame mesh entity 생성.
 * moduleWorld[i] 가 basemapWorld[DOOR_CORNER_MIRROR_MAP[i]] 와 짝.
 * 각 변마다 quad (2 triangles), 총 8 triangles. 양면 렌더.
 */
function createDoorFrameMesh(
  pc: any,
  app: any,
  moduleWorld: Array<[number, number, number]>,
  basemapWorld: Array<[number, number, number]>,
  color: [number, number, number],
): any {
  const positions: number[] = [];
  const indices: number[] = [];
  let vi = 0;
  for (let i = 0; i < 4; i++) {
    const ni = (i + 1) % 4;
    const Mi = moduleWorld[i];
    const Mn = moduleWorld[ni];
    const Bi = basemapWorld[DOOR_CORNER_MIRROR_MAP[i]];
    const Bn = basemapWorld[DOOR_CORNER_MIRROR_MAP[ni]];
    positions.push(Mi[0], Mi[1], Mi[2]);
    positions.push(Mn[0], Mn[1], Mn[2]);
    positions.push(Bn[0], Bn[1], Bn[2]);
    positions.push(Bi[0], Bi[1], Bi[2]);
    indices.push(vi, vi+1, vi+2, vi, vi+2, vi+3);
    vi += 4;
  }
  const mesh = new pc.Mesh(app.graphicsDevice);
  mesh.setPositions(positions);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);

  // 광원 없는 씬 → emissive 채널이 곧 표시 색.
  const mat = new pc.StandardMaterial();
  mat.emissive = new pc.Color(color[0], color[1], color[2]);
  mat.useLighting = false;
  mat.cull = pc.CULLFACE_NONE;
  mat.update();

  const ent = new pc.Entity('doorFrame');
  ent.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)] });
  (ent as any).__doorFramePositions = positions;
  (ent as any).__doorFrameIndices = indices;
  (ent as any).__doorFrameColor = color;
  app.root.addChild(ent);
  return ent;
}

function extractDoorFrameWorld(pc: any, ent: any): {
  positions: number[];
  indices: number[];
  color: [number, number, number];
} | null {
  if (!ent?.__doorFramePositions || !ent?.__doorFrameIndices) return null;
  const local: number[] = ent.__doorFramePositions;
  const world: number[] = [];
  const mat = ent.getWorldTransform();
  const src = new pc.Vec3();
  const dst = new pc.Vec3();
  for (let i = 0; i < local.length; i += 3) {
    src.set(local[i], local[i + 1], local[i + 2]);
    mat.transformPoint(src, dst);
    world.push(dst.x, dst.y, dst.z);
  }
  return {
    positions: world,
    indices: Array.from(ent.__doorFrameIndices),
    color: (ent as any).__doorFrameColor ?? DEFAULT_FRAME_COLOR,
  };
}

function findAverageDoorMeshColor(root: any): [number, number, number] | null {
  const stack = [...(root?.children ?? [])];
  while (stack.length > 0) {
    const ent = stack.pop();
    if (!ent) continue;
    const name = String(ent.name ?? '');
    const color = ent.__averageColor;
    if (name.startsWith('doorMesh') && Array.isArray(color) && color.length === 3) {
      return [
        Math.max(0, Math.min(1, Number(color[0]))),
        Math.max(0, Math.min(1, Number(color[1]))),
        Math.max(0, Math.min(1, Number(color[2]))),
      ];
    }
    stack.push(...(ent.children ?? []));
  }
  return null;
}

export default function AlignPanel({
  coreRef, uploadId, metadata, basemapDoorCorners, basemapTargetDoorId, basemapTargetDoorNormalInward,
  basemapMatchError, moduleDoorCorners, onCommitFinal,
}: Props) {
  const [aligned, setAligned] = useState(false);   // 자동 정합 한 번이라도 성공
  const [running, setRunning] = useState(false);
  const [savingResult, setSavingResult] = useState(false);
  const [manualMode, setManualMode] = useState<ManualMode>('translate');
  const [error, setError] = useState<string | null>(null);
  const [rmsd, setRmsd] = useState<number | null>(null);
  // 정합 문 두께 — basemap facade ↔ module facade 사이 간격 (= frame mesh 두께).
  // 사용자가 슬라이더로 직접 조절. ref 도 같이 두어 정합 동안 안정 참조.
  const [alignDoorThickness, setAlignDoorThickness] = useState(DEFAULT_ALIGN_DOOR_THICKNESS);
  const alignDoorThicknessRef = useRef(DEFAULT_ALIGN_DOOR_THICKNESS);
  useEffect(() => { alignDoorThicknessRef.current = alignDoorThickness; }, [alignDoorThickness]);

  // 도어 frame mesh — 정합 후 모듈 도어 ↔ 베이스맵 도어 사이 공간을 4면 quad 로 둘러쌈.
  // 정합 다시 돌리면 destroy 후 재생성. 초기화 시 destroy.
  const frameEntityRef = useRef<any>(null);

  // 도어 통합 그룹 (Phase 3) — 정합 후 양측 도어 (모듈 + basemap) + frame mesh 를 한 부모로 묶어
  // 슬라이더로 hinge 축 기준 회전. 정합 초기화 시 destroy + 원래 부모로 복원.
  const doorPivotGroupRef = useRef<any>(null);
  // doorPivot 준비 상태 — UI 슬라이더 노출 조건. ref 만으론 re-render 트리거 안 되므로 별도 state.
  const [doorPivotReady, setDoorPivotReady] = useState(false);
  // doorPivotGroup 에 reparent 된 entity 들의 원래 부모 정보 (revert 용).
  const doorPivotMembersRef = useRef<Array<{ ent: any; oldParent: any }>>([]);
  // hinge 회전 상태 (Phase 4).
  const [doorAngleDeg, setDoorAngleDeg] = useState(0);
  // hinge 축 (world frame) — basemap door corner [0]→[3] 변 기준 (왼쪽 변, 수직축).
  const doorHingeRef = useRef<{ origin: [number, number, number]; axis: [number, number, number] } | null>(null);

  // 슝 애니메이션 상태 (rAF). DoorAlignModal 의 onUpdate 패턴 그대로 차용.
  const animRef = useRef<{
    start: number;
    duration: number;
    fromPos: [number, number, number];
    fromQuat: [number, number, number, number];
    toPos: [number, number, number];
    toQuat: [number, number, number, number];
    onComplete?: () => void;
  } | null>(null);

  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    return core.onUpdate(() => {
      const a = animRef.current;
      const group = core.getAlignmentGroup?.();
      const pc = core.getPC();
      if (!a || !group || !pc) return;
      const prog = Math.min(1, (performance.now() - a.start) / a.duration);
      const u = easeInOutCubic(prog);
      const px = a.fromPos[0] + (a.toPos[0] - a.fromPos[0]) * u;
      const py = a.fromPos[1] + (a.toPos[1] - a.fromPos[1]) * u;
      const pz = a.fromPos[2] + (a.toPos[2] - a.fromPos[2]) * u;
      const qa = new pc.Quat(a.fromQuat[0], a.fromQuat[1], a.fromQuat[2], a.fromQuat[3]);
      const qb = new pc.Quat(a.toQuat[0], a.toQuat[1], a.toQuat[2], a.toQuat[3]);
      const qOut = new pc.Quat();
      qOut.slerp(qa, qb, u);
      group.setLocalPosition(px, py, pz);
      group.setLocalRotation(qOut.x, qOut.y, qOut.z, qOut.w);
      if (prog >= 1) {
        const cb = a.onComplete;
        animRef.current = null;
        if (cb) { try { cb(); } catch (e) { console.warn('[Align] onComplete 오류:', e); } }
      }
    });
  }, [coreRef]);

  // Kabsch 자동 정합 + 애니메이션 트리거.
  const runAutoAlign = useCallback(async () => {
    if (!moduleDoorCorners || moduleDoorCorners.length !== 4) {
      setError('모듈 측 문 코너 정보 없음.');
      return;
    }
    if (!basemapDoorCorners || basemapDoorCorners.length !== 4) {
      setError(basemapMatchError ?? 'basemap 매칭 실패');
      return;
    }
    const core = coreRef.current;
    const pc = core?.getPC();
    const group = core?.getAlignmentGroup?.();
    if (!core || !pc || !group) {
      setError('alignmentGroup 미준비');
      return;
    }
    setError(null);
    setRunning(true);
    try {
      // 정합 직전 — alignmentGroup 에 누락된 child 가 있는지 다시 한 번 reparent.
      // (예: 도어 sub-splat 의 asset.ready 가 enterAlignmentMode 이후 fire 된 case)
      core.enterAlignmentMode?.();
      // rectFit — 두 직사각형의 직교 basis 비교로 similarity transform (R, s, t) 산출.
      const { rectFit } = await import('@/lib/alignment');
      // moduleDoorCorners 는 **raw 프레임** (DoorAlignModal `onSetupCornersFinalized` 가 picked.pos 그대로 전달).
      //   raw → world 는 splatEntity.getWorldTransform() 이 Z-180 + pendingRotation + alignmentGroup 모두 합쳐 적용.
      //   wallAngle Y 는 entity 에 안 들어가므로 raw 그대로 넘기는 것이 시각 위치와 일치.
      const sdData = core.getSplatData();
      if (!sdData?.splatEntity) {
        setError('splatEntity 미준비');
        setRunning(false);
        return;
      }
      const splatWorld = sdData.splatEntity.getWorldTransform();
      const srcWorld: Array<[number, number, number]> = moduleDoorCorners.map(c => {
        const v = new pc.Vec3(c[0], c[1], c[2]);
        const out = new pc.Vec3();
        splatWorld.transformPoint(v, out);
        return [out.x, out.y, out.z] as [number, number, number];
      });

      const src = new Float64Array(12);
      const dst = new Float64Array(12);
      for (let i = 0; i < 4; i++) {
        src[i*3] = srcWorld[i][0]; src[i*3+1] = srcWorld[i][1]; src[i*3+2] = srcWorld[i][2];
        // basemap A'+Y → world: Z-180 (=diag(-1,-1,1)). DOOR_CORNER_MIRROR_MAP 로 mirror pairing.
        const t = basemapDoorCorners[DOOR_CORNER_MIRROR_MAP[i]];
        dst[i*3] = -t[0]; dst[i*3+1] = -t[1]; dst[i*3+2] = t[2];
      }

      // dst basis 의 n 을 강제 — MIRROR_MAP 적용된 dst 의 자연 cross-product 방향과 일치시켜야 R 이 올바름.
      //   두 사용자가 반대 방향에서 픽 (basemap user 는 corridor 안에서, module user 는 room 안에서) → 두 cross-product 가 world 에서
      //   같은 방향 (각자의 outward = 상대방 interior 향함). mirror 적용 후 dst 의 cross 는 그 반대 = basemap_inward.
      //   normalInward (baked = A'+Y) → world Z-180 적용: (-x, -y, z).
      let dstForcedN: [number, number, number] | undefined;
      if (basemapTargetDoorNormalInward) {
        const ni = basemapTargetDoorNormalInward;
        dstForcedN = [-ni[0], -ni[1], ni[2]];  // basemap_inward in world
      }
      // gap 적용 전 fit 으로 R, dst plane normal 산출.
      const preFit = rectFit(src, dst, { ...(dstForcedN ? { dstForcedN } : {}), withScale: true });

      // 정합 문 두께 = 사용자 설정 슬라이더 값. basemap ↔ module facade 평행 간격.
      const gap = alignDoorThicknessRef.current;

      // gap push 방향 = basemap_outward = -dstN (dstN 은 basemap_inward 로 강제됨).
      //   module 이 basemap 방 바깥쪽 (= module room 안쪽) 으로 gap 만큼 떨어진 위치에 도달.
      const pushN: [number, number, number] = [-preFit.dstN[0], -preFit.dstN[1], -preFit.dstN[2]];
      for (let i = 0; i < 4; i++) {
        dst[i*3]   += pushN[0] * gap;
        dst[i*3+1] += pushN[1] * gap;
        dst[i*3+2] += pushN[2] * gap;
      }
      const fit = rectFit(src, dst, { ...(dstForcedN ? { dstForcedN } : {}), withScale: false });
      const srcWidth = rectEdgeLength(src, 0, 1);
      const srcHeight = rectEdgeLength(src, 1, 2);
      const dstWidth = rectEdgeLength(dst, 0, 1);
      const dstHeight = rectEdgeLength(dst, 1, 2);
      const widthScale = srcWidth > 1e-9 ? dstWidth / srcWidth : 1;
      const heightScale = srcHeight > 1e-9 ? dstHeight / srcHeight : 1;
      // 도어는 정규화 단계에서 세로가 local Y, 가로가 수평 XZ 평면에 놓인다.
      // 그래서 수평 축(X/Z)은 가로 비율, Y 축은 세로 비율을 적용해 문 bbox 가 정확히 일치하게 한다.
      const rectScale: [number, number, number] = [widthScale, heightScale, widthScale];
      const srcCenter = rectCentroid(src);
      const dstCenter = rectCentroid(dst);
      const rotatedScaledCenter = transformPointByRS(fit.R as unknown as number[], rectScale, srcCenter);
      const rectT = [
        dstCenter[0] - rotatedScaledCenter[0],
        dstCenter[1] - rotatedScaledCenter[1],
        dstCenter[2] - rotatedScaledCenter[2],
      ];
      const rectRmsd = rmsdForRectTransform(src, dst, fit.R as unknown as number[], rectScale, rectT);
      setRmsd(rectRmsd);
      // fit 은 src world → dst world 의 affine transform (R + axis별 scale + t).
      // alignmentGroup 의 새 world = fit · 현재 group world. group 부모가 app.root (identity) 이라 local = world.
      const fitMat = anisotropicRectToMat4(pc, fit.R as unknown as number[], rectScale, rectT);
      const newGroupWorld = new pc.Mat4().mul2(fitMat, group.getWorldTransform());

      // 분해: position + quaternion + scale.
      // Quat.setFromMat4 는 orthonormal 회전 가정 — scale 이 1 이 아니면 columns 길이가 scale 만큼 늘어나 trace 계산이
      // 비례적으로 틀어진다. scale 먼저 추출, 행렬 upper 3x3 의 각 column 을 scale 로 나눠 orthonormal 만든 후 quat 추출.
      const newPos = new pc.Vec3();
      const newRot = new pc.Quat();
      const newScale = new pc.Vec3();
      newGroupWorld.getTranslation(newPos);
      newGroupWorld.getScale(newScale);
      const pureRotMat = new pc.Mat4();
      const m = newGroupWorld.data;
      const pr = pureRotMat.data;
      const sx = newScale.x || 1, sy = newScale.y || 1, sz = newScale.z || 1;
      pr[0]  = m[0]/sx; pr[1]  = m[1]/sx; pr[2]  = m[2]/sx;  pr[3]  = 0;
      pr[4]  = m[4]/sy; pr[5]  = m[5]/sy; pr[6]  = m[6]/sy;  pr[7]  = 0;
      pr[8]  = m[8]/sz; pr[9]  = m[9]/sz; pr[10] = m[10]/sz; pr[11] = 0;
      pr[12] = 0;       pr[13] = 0;       pr[14] = 0;        pr[15] = 1;
      newRot.setFromMat4(pureRotMat);

      // 거리 비례 애니메이션 시간 (max 2.5s).
      const fromPos: [number, number, number] = (() => {
        const p = group.getLocalPosition();
        return [p.x, p.y, p.z];
      })();
      const fromQuat: [number, number, number, number] = (() => {
        const q = group.getLocalRotation();
        return [q.x, q.y, q.z, q.w];
      })();
      const dx = newPos.x - fromPos[0], dy = newPos.y - fromPos[1], dz = newPos.z - fromPos[2];
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      // 1m 당 약 200ms 추가, max 2.5s 캡.
      const duration = Math.min(ANIM_MAX_MS, ANIM_BASE_MS + dist * 200);

      // Phase 3 reparent 는 애니메이션 완료 후 실행 (group 의 최종 transform 이 정확해야 world 보존 reparent 가 옳음).
      //   onComplete 콜백으로 등록 — 애니메이션 onUpdate 가 종료 시점에 호출.
      const doDoorPivotSetup = () => {
        try {
          // 기존 그룹 정리.
          if (doorPivotGroupRef.current) {
            for (const m of doorPivotMembersRef.current) {
              if (m.ent && m.oldParent) {
                try { reparentPreserveWorld(pc, m.ent, m.oldParent); } catch {}
              }
            }
            doorPivotMembersRef.current = [];
            try { doorPivotGroupRef.current.destroy(); } catch {}
            doorPivotGroupRef.current = null;
          }
          const app = core.getApp();
          const doorPivot = new pc.Entity('doorPivotGroup');
          app.root.addChild(doorPivot);
          doorPivotGroupRef.current = doorPivot;

          const candidates: any[] = [
            ...(app.root.children as any[]),
            ...((group.children as any[]) ?? []),
          ];
          for (const c of candidates) {
            if (c === doorPivot) continue;
            const name: string = c.name ?? '';
            const isModuleDoorWrapper = name === 'moduleDoor';
            // 정합 대상 basemap 도어 wrapper 만 매치 — 다른 호수의 basemapDoor_* 는 회전 대상 제외.
            const isBasemapDoorWrapper = basemapTargetDoorId
              ? name === `basemapDoor_${basemapTargetDoorId}`
              : false;
            const isFrame = name === 'doorFrame';
            if (isModuleDoorWrapper || isBasemapDoorWrapper || isFrame) {
              const oldParent = c.parent;
              doorPivotMembersRef.current.push({ ent: c, oldParent });
              reparentPreserveWorld(pc, c, doorPivot);
            }
          }

          // hinge 축 — basemap 도어 corner [0]→[3] (왼쪽 변, 수직).
          const bc0 = basemapDoorCorners[0], bc3 = basemapDoorCorners[3];
          const h0: [number, number, number] = [-bc0[0], -bc0[1], bc0[2]];
          const h3: [number, number, number] = [-bc3[0], -bc3[1], bc3[2]];
          const ax = h3[0] - h0[0], ay = h3[1] - h0[1], az = h3[2] - h0[2];
          const aLen = Math.hypot(ax, ay, az) || 1;
          doorHingeRef.current = {
            origin: [h0[0], h0[1], h0[2]],
            axis: [ax / aLen, ay / aLen, az / aLen],
          };
          setDoorAngleDeg(0);
          setDoorPivotReady(true);
        } catch (e) {
          console.warn('[DoorPivot] 생성 실패', e);
        }
      };

      animRef.current = {
        start: performance.now(),
        duration,
        fromPos,
        fromQuat,
        toPos: [newPos.x, newPos.y, newPos.z],
        toQuat: [newRot.x, newRot.y, newRot.z, newRot.w],
        onComplete: doDoorPivotSetup,
      };
      // group scale 도 적용 (애니메이션 안 함 — scale 은 보통 1).
      group.setLocalScale(newScale.x, newScale.y, newScale.z);

      // 도어 frame mesh — 모듈 ↔ 베이스맵 도어 사이 4면 측벽 (시각화).
      try {
        if (frameEntityRef.current) {
          try { frameEntityRef.current.destroy(); } catch {}
          frameEntityRef.current = null;
        }
        const basemapWorld: Array<[number, number, number]> = basemapDoorCorners.map(c => [-c[0], -c[1], c[2]]);
        const moduleWorld: Array<[number, number, number]> = [];
        for (let i = 0; i < 4; i++) {
          moduleWorld.push([dst[i*3], dst[i*3+1], dst[i*3+2]]);
        }
        const frameColor = findAverageDoorMeshColor(core.getApp().root) ?? DEFAULT_FRAME_COLOR;
        frameEntityRef.current = createDoorFrameMesh(pc, core.getApp(), moduleWorld, basemapWorld, frameColor);
      } catch (e) {
        console.warn('[Align] door frame 생성 실패', e);
      }

      setAligned(true);
    } catch (e: any) {
      setError(`정합 실패: ${e?.message ?? e}`);
    } finally {
      setRunning(false);
    }
  }, [coreRef, moduleDoorCorners, basemapDoorCorners, basemapMatchError]);

  // 수동 핸들 — 정합 그룹의 transform 을 +/- 단위로 조정. SuperSplat 처럼 gizmo 는
  // 추후 작업으로 미루고, 일단 명확한 numeric 컨트롤을 제공.
  const nudge = useCallback((mode: ManualMode, axis: 0 | 1 | 2, sign: 1 | -1) => {
    const core = coreRef.current;
    const pc = core?.getPC();
    const group = core?.getAlignmentGroup?.();
    if (!core || !pc || !group) return;
    const STEP_T = 0.05;       // 5cm
    const STEP_R = (Math.PI / 180) * 5;  // 5 deg
    const STEP_S = 1.05;       // 5%
    if (mode === 'translate') {
      const p = group.getLocalPosition();
      const np = [p.x, p.y, p.z];
      np[axis] += sign * STEP_T;
      group.setLocalPosition(np[0], np[1], np[2]);
    } else if (mode === 'rotate') {
      const q = group.getLocalRotation();
      const dq = new pc.Quat();
      const ang = sign * STEP_R * (180 / Math.PI);
      if (axis === 0) dq.setFromEulerAngles(ang, 0, 0);
      else if (axis === 1) dq.setFromEulerAngles(0, ang, 0);
      else dq.setFromEulerAngles(0, 0, ang);
      const newQ = new pc.Quat().mul2(q, dq);
      group.setLocalRotation(newQ.x, newQ.y, newQ.z, newQ.w);
    } else if (mode === 'scale') {
      const s = group.getLocalScale();
      const ns = [s.x, s.y, s.z];
      ns[axis] *= sign === 1 ? STEP_S : (1 / STEP_S);
      group.setLocalScale(ns[0], ns[1], ns[2]);
    }
  }, [coreRef]);

  // 정합 초기화 — alignmentGroup 의 transform 을 identity 로 되돌리고 자동 정합 결과/RMSD 도 제거.
  // (수동 nudge 누적분 + frame mesh 도 함께 제거)
  const resetAlignment = useCallback(() => {
    const core = coreRef.current;
    const group = core?.getAlignmentGroup?.();
    if (!group) return;
    animRef.current = null;
    group.setLocalPosition(0, 0, 0);
    group.setLocalEulerAngles(0, 0, 0);
    group.setLocalScale(1, 1, 1);
    if (frameEntityRef.current) {
      try { frameEntityRef.current.destroy(); } catch {}
      frameEntityRef.current = null;
    }
    // doorPivotGroup 정리 — 멤버들을 원래 부모로 복원하고 그룹 destroy.
    if (doorPivotGroupRef.current) {
      const pc = coreRef.current?.getPC();
      if (pc) {
        for (const m of doorPivotMembersRef.current) {
          if (m.ent && m.oldParent) {
            try { reparentPreserveWorld(pc, m.ent, m.oldParent); } catch {}
          }
        }
      }
      doorPivotMembersRef.current = [];
      try { doorPivotGroupRef.current.destroy(); } catch {}
      doorPivotGroupRef.current = null;
      doorHingeRef.current = null;
      setDoorAngleDeg(0);
      setDoorPivotReady(false);
    }
    setAligned(false);
    setRmsd(null);
    setError(null);
  }, [coreRef]);

  // 모달/패널 언마운트 시 frame + doorPivot 정리.
  useEffect(() => {
    return () => {
      if (frameEntityRef.current) {
        try { frameEntityRef.current.destroy(); } catch {}
        frameEntityRef.current = null;
      }
      if (doorPivotGroupRef.current) {
        try { doorPivotGroupRef.current.destroy(); } catch {}
        doorPivotGroupRef.current = null;
      }
    };
  }, []);

  // Phase 4: doorAngleDeg 변경 시 doorPivotGroup 을 hinge 축 기준으로 회전.
  //   회전 origin = hinge.origin (왼쪽 변 시작점). hinge 축 = hinge.axis.
  //   localRotation = R_axis(angle), localPosition = origin - R_axis(angle) · origin (hinge 점 고정 유지).
  useEffect(() => {
    const pivot = doorPivotGroupRef.current;
    const hinge = doorHingeRef.current;
    const core = coreRef.current;
    const pc = core?.getPC();
    if (!pivot || !hinge || !pc) return;
    const angle = (doorAngleDeg * Math.PI) / 180;
    const half = angle / 2;
    const sH = Math.sin(half), cH = Math.cos(half);
    const q = new pc.Quat(hinge.axis[0] * sH, hinge.axis[1] * sH, hinge.axis[2] * sH, cH);
    // hinge 점이 고정되도록 position 보정: P_new = origin + R(P - origin). entity 의 local 기준,
    //   doorPivot 의 local = identity 부모 (app.root) 라 world = local.
    //   회전 후 origin 이 R·origin 으로 이동했으므로 (origin - R·origin) 만큼 평행이동.
    const o = new pc.Vec3(hinge.origin[0], hinge.origin[1], hinge.origin[2]);
    const rotated = new pc.Vec3();
    q.transformVector(o, rotated);
    pivot.setLocalRotation(q.x, q.y, q.z, q.w);
    pivot.setLocalPosition(o.x - rotated.x, o.y - rotated.y, o.z - rotated.z);
  }, [doorAngleDeg, coreRef]);

  // 정합 결과 확정 — 4×4 행렬 저장. Upload + Module 양쪽.
  const saveResult = useCallback(async () => {
    const core = coreRef.current;
    const group = core?.getAlignmentGroup?.();
    if (!group) return;
    setSavingResult(true);
    try {
      const matrix4x4 = entityWorldMatrix(group);  // 16 numbers, column-major
      const p = group.getLocalPosition();
      const q = group.getLocalRotation();
      const s = group.getLocalScale();
      const pc = core?.getPC?.();
      const doorFrame = pc && frameEntityRef.current
        ? extractDoorFrameWorld(pc, frameEntityRef.current)
        : null;

      // onCommitFinal 제공 시 → 다듬기 결과 자산 + 정합 행렬 일괄 영속화.
      if (onCommitFinal) {
        try {
          await onCommitFinal({
            matrix4x4,
            position: [p.x, p.y, p.z],
            rotation: [q.x, q.y, q.z, q.w],
            scale: [s.x, s.y, s.z],
            rmsd,
            doorFrame,
          });
          setError('정합 완료 ✓');
        } catch (e: any) {
          setError(`정합 영속화 실패: ${e?.message ?? e}`);
        } finally {
          setSavingResult(false);
        }
        return;
      }

      // Legacy fallback: older entry points can still persist the module transform
      // directly, but upload-scoped alignment state is no longer stored.
      try {
        await api.put(`/modules/${metadata.module_id}/alignment-transform`, {
          transform: {
            matrix: matrix4x4,
            position: [p.x, p.y, p.z],
            rotation: [q.x, q.y, q.z, q.w],
            scale: [s.x, s.y, s.z],
          },
        });
      } catch (e) {
        console.warn('[AlignPanel] module alignment 저장 실패', e);
      }
      setError('정합 완료 ✓');
    } finally {
      setSavingResult(false);
    }
  }, [coreRef, uploadId, metadata.module_id, rmsd, onCommitFinal]);

  const matchReady = !!basemapDoorCorners && !!moduleDoorCorners;
  const runDisabled = !matchReady || running;

  return (
    <div className="bg-[var(--paper)]/95 border border-[var(--rule)] rounded-lg shadow-2xl text-[var(--ink)] text-xs select-none flex flex-col w-72 p-3 gap-2">
      <div className="text-sm font-bold text-[var(--ink)]">정합</div>

      {basemapMatchError && (
        <div className="text-[11px] text-red-400 bg-red-950/40 border border-red-800 rounded px-2 py-1.5 leading-relaxed">
          {basemapMatchError}
        </div>
      )}

      {!basemapMatchError && !matchReady && (
        <div className="text-[11px] text-[var(--muted)]">basemap 정보 가져오는 중...</div>
      )}

      {!aligned ? (
        <button
          onClick={runAutoAlign}
          disabled={runDisabled}
          className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-[var(--bg-soft)] disabled:text-[var(--muted)] text-[var(--ink)] rounded cursor-pointer text-xs font-bold disabled:cursor-not-allowed"
        >
          {running ? '정합 중...' : '정합'}
        </button>
      ) : (
        <button
          onClick={resetAlignment}
          className="w-full px-3 py-2 bg-orange-600 hover:bg-orange-500 text-[var(--ink)] rounded cursor-pointer text-xs font-bold"
        >
          정합 초기화
        </button>
      )}

      {rmsd !== null && (
        <div className="text-[10px] text-[var(--muted)]">RMSD: {rmsd.toFixed(4)} m</div>
      )}

      {/* 정합 문 두께 슬라이더 — basemap ↔ module facade 사이 간격 + frame mesh 두께.
          정합 실행 후에 슬라이더 조정 시 다음 "정합" 클릭부터 반영. (실시간 재정합 X — 변경 시 사용자가 다시 누름) */}
      <div className="border-t border-[var(--rule)] pt-2 space-y-1"
        title="basemap 도어와 module 도어 사이 평행 간격. 그 사이는 4면 frame mesh 가 채움. 슬라이더 변경 후 '정합' 다시 누름.">
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-[var(--muted)] w-20">정합 문 두께</span>
          <input
            type="range"
            min={ALIGN_DOOR_THICKNESS_MIN}
            max={ALIGN_DOOR_THICKNESS_MAX}
            step={0.001}
            value={alignDoorThickness}
            onChange={e => setAlignDoorThickness(parseFloat(e.target.value))}
            className="flex-1 accent-cyan-500 cursor-pointer"
          />
          <span className="text-[var(--ink)] font-mono w-12 text-right">
            {(alignDoorThickness * 100).toFixed(1)}cm
          </span>
        </div>
      </div>

      {/* 자동 정합 1 회 후에만 수동 핸들 + 확정 저장 표시 */}
      {aligned && (
        <>
          <div className="border-t border-[var(--rule)] pt-2 space-y-2">
            <div className="text-[11px] font-bold text-[var(--ink-2)]">수동 조정</div>
            <div className="flex gap-1">
              {(['translate', 'rotate', 'scale'] as ManualMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setManualMode(m)}
                  className={`flex-1 px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${
                    manualMode === m ? 'bg-blue-600 text-[var(--ink)]' : 'bg-[var(--bg-soft)] text-[var(--ink-2)] hover:bg-[var(--rule)]'
                  }`}
                >
                  {m === 'translate' ? '이동' : m === 'rotate' ? '회전' : '스케일'}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-1">
              {(['X', 'Y', 'Z'] as const).map((axisLabel, ax) => (
                <div key={axisLabel} className="flex flex-col gap-1">
                  <div className="text-center text-[10px] text-[var(--muted)]">{axisLabel}</div>
                  <button onClick={() => nudge(manualMode, ax as 0 | 1 | 2, 1)}
                    className="px-1 py-0.5 bg-[var(--bg-soft)] hover:bg-[var(--rule)] rounded text-[10px] cursor-pointer">+</button>
                  <button onClick={() => nudge(manualMode, ax as 0 | 1 | 2, -1)}
                    className="px-1 py-0.5 bg-[var(--bg-soft)] hover:bg-[var(--rule)] rounded text-[10px] cursor-pointer">−</button>
                </div>
              ))}
            </div>
            <div className="text-[10px] text-[var(--muted)] leading-relaxed">
              이동 5cm / 회전 5° / 스케일 5% 단위. "정합 초기화" 누르면 변환 전부 리셋.
            </div>
          </div>

          {/* 도어 열기/닫기 슬라이더 — 정합 검증용. 모듈/베이스맵 도어 + frame 측벽 통합 회전. */}
          {doorPivotReady && (
            <div className="border-t border-[var(--rule)] pt-2 space-y-1">
              <div className="flex items-center gap-2">
                <div className="text-[11px] font-bold text-[var(--ink-2)] flex-1">도어 열기 (확인용)</div>
                <span className="text-[10px] text-[var(--muted)] font-mono">{doorAngleDeg.toFixed(0)}°</span>
              </div>
              <input
                type="range"
                min="0" max="90" step="1"
                value={doorAngleDeg}
                onChange={(e) => setDoorAngleDeg(parseInt(e.target.value))}
                className="w-full h-1 accent-amber-500 cursor-pointer"
              />
              <div className="text-[10px] text-[var(--muted)] leading-relaxed">
                hinge 축은 도어 왼쪽 변. 영구 저장 안 됨 (정합 확인용).
              </div>
            </div>
          )}

          <button
            onClick={saveResult}
            disabled={savingResult}
            className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-[var(--bg-soft)] text-[var(--ink)] rounded cursor-pointer text-xs font-bold disabled:cursor-not-allowed"
          >
            {savingResult ? '저장 중...' : '정합 완료'}
          </button>
        </>
      )}

      {error && (
        <div className="text-[10px] text-amber-400 leading-relaxed">{error}</div>
      )}
    </div>
  );
}
