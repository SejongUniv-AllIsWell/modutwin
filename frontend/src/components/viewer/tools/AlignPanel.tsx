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
   * 신흐름(모듈 등록): 정합 완료 시 호출. 다듬기 결과 자산 + 정합 행렬을 일괄 영속화.
   * 제공되면 기존 saveResult (POST /uploads/{id}/alignment + PUT /modules/{id}/alignment-transform)
   * 대신 이 콜백 사용. UnifiedSplatEditor 가 gatherRefinedAssets + commit-final 호출.
   */
  onCommitFinal?: (args: {
    matrix4x4: number[];
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
    rmsd: number | null;
  }) => Promise<void>;
}

type ManualMode = 'translate' | 'rotate' | 'scale';

const ANIM_MAX_MS = 2500;
const ANIM_BASE_MS = 400;

// 모듈/베이스맵 도어 corner mirror 매핑 — 모듈 [TL,TR,BR,BL] CW (모듈 안에서 본 시점) ↔
// 베이스맵 같은 도어 [TR,TL,BL,BR] (베이스맵 안에서 본 시점). 두 방 사이 도어는 양쪽에서 좌우 반전.
const DOOR_CORNER_MIRROR_MAP = [1, 0, 3, 2] as const;

// 벽 두께 gap — basemap mesh ↔ module mesh 가 정확히 겹치지 않게 띄움. door_height 비율 기반.
// 표준문 (2.1m) 기준 ≈ 5cm. 한국 차음벽 200mm 보다 작지만 시각적 분리에 충분 + 자연스러움.
const DOOR_GAP_RATIO = 0.023;
const DOOR_GAP_MIN = 0.017;

// 도어 frame mesh (모듈↔베이스맵 도어 사이 4면 측벽) 색상.
// 광원 없는 가우시안 스플래팅 씬에선 emissive 채널만 보이므로, 그냥 "표시 색" 으로 사용.
// 디버깅용 초록색 — 정합 후 frame 위치/크기 확인 명확히. 추후 도어 텍스처 median 색으로 교체 예정.
const FRAME_COLOR: [number, number, number] = [0.0, 1.0, 0.0];

// AlignPanel 진단 로그 토글. 디버깅 시에만 true.
const DEBUG_ALIGN = false;

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

/** Kabsch row-major R(3×3) + t(3) → PlayCanvas Mat4 (column-major). */
function rigidToMat4(pc: any, R: number[], t: number[]): any {
  const m = new pc.Mat4();
  m.data[0]  = R[0]; m.data[1]  = R[3]; m.data[2]  = R[6]; m.data[3]  = 0;
  m.data[4]  = R[1]; m.data[5]  = R[4]; m.data[6]  = R[7]; m.data[7]  = 0;
  m.data[8]  = R[2]; m.data[9]  = R[5]; m.data[10] = R[8]; m.data[11] = 0;
  m.data[12] = t[0]; m.data[13] = t[1]; m.data[14] = t[2]; m.data[15] = 1;
  return m;
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
  mat.emissive = new pc.Color(FRAME_COLOR[0], FRAME_COLOR[1], FRAME_COLOR[2]);
  mat.useLighting = false;
  mat.cull = pc.CULLFACE_NONE;
  mat.update();

  const ent = new pc.Entity('doorFrame');
  ent.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)] });
  app.root.addChild(ent);
  return ent;
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

  // 도어 frame mesh — 정합 후 모듈 도어 ↔ 베이스맵 도어 사이 공간을 4면 quad 로 둘러쌈.
  // 정합 다시 돌리면 destroy 후 재생성. 초기화 시 destroy.
  const frameEntityRef = useRef<any>(null);

  // 도어 통합 그룹 (Phase 3) — 정합 후 양측 도어 (모듈 + basemap) + frame mesh 를 한 부모로 묶어
  // 슬라이더로 hinge 축 기준 회전. 정합 초기화 시 destroy + 원래 부모로 복원.
  const doorPivotGroupRef = useRef<any>(null);
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
      // 진단: app.root 와 alignmentGroup 의 모든 children 출력 — 어느 entity 가 어디 있는지 확인.
      try {
        const app = core.getApp();
        const formatChild = (c: any) => {
          const pos = c.getLocalPosition?.() ?? { x: 0, y: 0, z: 0 };
          const tags = c.tags ? Array.from(c.tags._list || []) : [];
          return {
            name: c.name,
            tags: tags.join(','),
            pos: `(${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)})`,
          };
        };
        const rootKids = Array.from(app.root.children ?? []).map(formatChild);
        const groupKids = Array.from(group.children ?? []).map(formatChild);
        console.log('[Align] app.root children:', rootKids);
        console.log('[Align] alignmentGroup children:', groupKids);
        // 도어 splat (add_splat_*) 개수 + 위치 별도 출력 — 복제 추적용.
        const allDoorSplats = [...rootKids, ...groupKids].filter(k => k.name.startsWith('add_splat_'));
        console.warn(`[DoorSplat:SUMMARY] total add_splat_*: ${allDoorSplats.length}`, allDoorSplats);
      } catch {}

      // rectFit — 사용자 픽은 normalizeDoorRect 로 정확한 직사각형이 보장됨.
      // SVD-기반 Kabsch 대신 두 사각형의 직교 basis 비교로 R, t 를 한 번에 산출. 180° 매칭 모호성 없음.
      const { rectFit } = await import('@/lib/alignment');
      // 모듈 측 코너는 A'+Y (저장 좌표) 프레임이지만, 화면에 보이는 alignmentGroup 의 자식
      // (splatEntity, wall mesh, door mesh) 는 Z-180 viewer 컨벤션이 entity transform 으로 부여됨.
      // → world 좌표로 변환 (Z-180 적용 후) 해 Kabsch 의 source 로 사용.
      // alignmentGroup 의 현재 transform 도 같이 반영해야 정확.
      const groupWorld = group.getWorldTransform();
      const srcWorld: Array<[number, number, number]> = moduleDoorCorners.map(c => {
        const v = new pc.Vec3(c[0], c[1], c[2]);
        // door corners 는 A'+Y 프레임 (raw 데이터). splatEntity 가 Z-180 회전을 부여하므로 (-x, -y, z) 로 변환.
        const inEntityFrame = new pc.Vec3(-v.x, -v.y, v.z);
        const out = new pc.Vec3();
        groupWorld.transformPoint(inEntityFrame, out);
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
      const preFit = rectFit(src, dst, dstForcedN ? { dstForcedN } : {});

      // doorHeight 계산 — dst 의 e2 길이 = corner[2] - corner[1] 의 magnitude.
      const dh_x = dst[6] - dst[3], dh_y = dst[7] - dst[4], dh_z = dst[8] - dst[5];
      const doorHeight = Math.hypot(dh_x, dh_y, dh_z);
      const gap = Math.max(DOOR_GAP_MIN, doorHeight * DOOR_GAP_RATIO);

      // gap push 방향 = basemap_outward = -dstN (dstN 은 basemap_inward 로 강제됨).
      //   module 이 basemap 방 바깥쪽 (= module room 안쪽) 으로 gap 만큼 떨어진 위치에 도달.
      const pushN: [number, number, number] = [-preFit.dstN[0], -preFit.dstN[1], -preFit.dstN[2]];
      for (let i = 0; i < 4; i++) {
        dst[i*3]   += pushN[0] * gap;
        dst[i*3+1] += pushN[1] * gap;
        dst[i*3+2] += pushN[2] * gap;
      }
      const fit = rectFit(src, dst, dstForcedN ? { dstForcedN } : {});
      setRmsd(fit.rmsd);
      console.log(`[Align] RMSD=${fit.rmsd.toFixed(4)}m, gap=${gap.toFixed(3)}m, doorH=${doorHeight.toFixed(2)}m, ` +
        `nSource=${dstForcedN ? 'normalInward' : 'cross-product'}`);
      if (DEBUG_ALIGN) {
        console.log('  alignmentGroup children:', Array.from(group.children ?? []).map((c: any) => c.name));
        for (let i = 0; i < 4; i++) {
          console.log(`  i=${i} src=(${src[i*3].toFixed(3)}, ${src[i*3+1].toFixed(3)}, ${src[i*3+2].toFixed(3)}) ` +
            `dst=(${dst[i*3].toFixed(3)}, ${dst[i*3+1].toFixed(3)}, ${dst[i*3+2].toFixed(3)})`);
        }
      }

      // fit 은 src world → dst world 의 rigid transform.
      // alignmentGroup 의 새 world transform 을 구하려면 fit 을 group 의 현재 world 에 left-multiply 한다.
      // 즉 newGroupWorld = fit · oldGroupWorld.
      // 하지만 group 의 부모는 app.root (identity) 이므로 newGroupLocal = newGroupWorld.
      // PlayCanvas 의 setLocalPosition/Rotation 사용 위해 분해.

      const fitMat = rigidToMat4(pc, fit.R as unknown as number[], fit.t as unknown as number[]);
      const newGroupWorld = new pc.Mat4().mul2(fitMat, groupWorld);

      // 분해: position + quaternion + scale.
      const newPos = new pc.Vec3();
      const newRot = new pc.Quat();
      const newScale = new pc.Vec3();
      newGroupWorld.getTranslation(newPos);
      newRot.setFromMat4(newGroupWorld);
      newGroupWorld.getScale(newScale);

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
          console.log(`[DoorPivot] grouped ${doorPivotMembersRef.current.length} entities under doorPivotGroup (post-animation)`);
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
        frameEntityRef.current = createDoorFrameMesh(pc, core.getApp(), moduleWorld, basemapWorld);
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

      // 신흐름: onCommitFinal 제공 시 → 일괄 영속화 (다듬기 결과 자산 포함).
      if (onCommitFinal) {
        try {
          await onCommitFinal({
            matrix4x4,
            position: [p.x, p.y, p.z],
            rotation: [q.x, q.y, q.z, q.w],
            scale: [s.x, s.y, s.z],
            rmsd,
          });
          setError('정합 완료 ✓');
        } catch (e: any) {
          setError(`정합 영속화 실패: ${e?.message ?? e}`);
        } finally {
          setSavingResult(false);
        }
        return;
      }

      // 기존 흐름: Upload + Module 별개 엔드포인트 저장.
      try {
        await api.post(`/uploads/${uploadId}/alignment`, {
          transform: {
            matrix: matrix4x4,
            position: [p.x, p.y, p.z],
            rotation: [q.x, q.y, q.z, q.w],
            scale: [s.x, s.y, s.z],
          },
          rmsd,
          matches: [{ module_door_id: 'door_1', basemap_id: 'auto' }],
        });
      } catch (e) {
        console.warn('[AlignPanel] upload alignment 저장 실패', e);
      }
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
          {doorPivotGroupRef.current && (
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
