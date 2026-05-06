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
  basemapMatchError: string | null;
  /** 모듈측 (현재 작업 중인) 도어의 4 코너 (A'+Y 프레임). null 이면 정합 불가. */
  moduleDoorCorners: Array<[number, number, number]> | null;
}

type ManualMode = 'translate' | 'rotate' | 'scale';

const ANIM_MAX_MS = 2500;
const ANIM_BASE_MS = 400;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// 4×4 (column-major) flat array 16개 추출 — PlayCanvas Mat4.data 와 동일 형식.
function entityWorldMatrix(ent: any): number[] {
  const m = ent.getWorldTransform().data;
  return Array.from(m);
}

export default function AlignPanel({
  coreRef, uploadId, metadata, basemapDoorCorners, basemapMatchError, moduleDoorCorners,
}: Props) {
  const [aligned, setAligned] = useState(false);   // 자동 정합 한 번이라도 성공
  const [running, setRunning] = useState(false);
  const [savingResult, setSavingResult] = useState(false);
  const [manualMode, setManualMode] = useState<ManualMode>('translate');
  const [error, setError] = useState<string | null>(null);
  const [rmsd, setRmsd] = useState<number | null>(null);

  // 슝 애니메이션 상태 (rAF). DoorAlignModal 의 onUpdate 패턴 그대로 차용.
  const animRef = useRef<{
    start: number;
    duration: number;
    fromPos: [number, number, number];
    fromQuat: [number, number, number, number];
    toPos: [number, number, number];
    toQuat: [number, number, number, number];
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
      if (prog >= 1) animRef.current = null;
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
      const { matchCorners } = await import('@/lib/alignment');
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
        const t = basemapDoorCorners[i];
        dst[i*3] = t[0]; dst[i*3+1] = t[1]; dst[i*3+2] = t[2];
      }
      const fit = matchCorners(src, dst);
      setRmsd(fit.rmsd);

      // fit 은 src world → dst world 의 rigid transform.
      // alignmentGroup 의 새 world transform 을 구하려면 fit 을 group 의 현재 world 에 left-multiply 한다.
      // 즉 newGroupWorld = fit · oldGroupWorld.
      // 하지만 group 의 부모는 app.root (identity) 이므로 newGroupLocal = newGroupWorld.
      // PlayCanvas 의 setLocalPosition/Rotation 사용 위해 분해.

      // fit.R 은 row-major 3x3, fit.t 는 [x,y,z]. fit world matrix:
      const R = fit.R;
      const tVec = fit.t;
      const fitMat = new pc.Mat4();
      // fitMat[col][row] (PlayCanvas Mat4 는 column-major).
      fitMat.data[0] = R[0]; fitMat.data[1] = R[3]; fitMat.data[2]  = R[6]; fitMat.data[3]  = 0;
      fitMat.data[4] = R[1]; fitMat.data[5] = R[4]; fitMat.data[6]  = R[7]; fitMat.data[7]  = 0;
      fitMat.data[8] = R[2]; fitMat.data[9] = R[5]; fitMat.data[10] = R[8]; fitMat.data[11] = 0;
      fitMat.data[12] = tVec[0]; fitMat.data[13] = tVec[1]; fitMat.data[14] = tVec[2]; fitMat.data[15] = 1;
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

      animRef.current = {
        start: performance.now(),
        duration,
        fromPos,
        fromQuat,
        toPos: [newPos.x, newPos.y, newPos.z],
        toQuat: [newRot.x, newRot.y, newRot.z, newRot.w],
      };
      // group scale 도 적용 (애니메이션 안 함 — scale 은 보통 1).
      group.setLocalScale(newScale.x, newScale.y, newScale.z);
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
      // Upload-scoped (현재 정합 행렬 + matches/rmsd).
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
      // Module-scoped (다른 화면에서 같은 모듈을 띄울 때 적용). 사용자 명시 사양.
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
  }, [coreRef, uploadId, metadata.module_id, rmsd]);

  const matchReady = !!basemapDoorCorners && !!moduleDoorCorners;
  const runDisabled = !matchReady || running;

  return (
    <div className="bg-gray-900/95 border border-gray-700 rounded-lg shadow-2xl text-white text-xs select-none flex flex-col w-72 p-3 gap-2">
      <div className="text-sm font-bold text-gray-100">정합</div>

      {basemapMatchError && (
        <div className="text-[11px] text-red-400 bg-red-950/40 border border-red-800 rounded px-2 py-1.5 leading-relaxed">
          {basemapMatchError}
        </div>
      )}

      {!basemapMatchError && !matchReady && (
        <div className="text-[11px] text-gray-400">basemap 정보 가져오는 중...</div>
      )}

      <button
        onClick={runAutoAlign}
        disabled={runDisabled}
        className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded cursor-pointer text-xs font-bold disabled:cursor-not-allowed"
      >
        {running ? '정합 중...' : (aligned ? '정합 (다시)' : '정합')}
      </button>

      {rmsd !== null && (
        <div className="text-[10px] text-gray-500">RMSD: {rmsd.toFixed(4)} m</div>
      )}

      {/* 자동 정합 1 회 후에만 수동 핸들 + 확정 저장 표시 */}
      {aligned && (
        <>
          <div className="border-t border-gray-700 pt-2 space-y-2">
            <div className="text-[11px] font-bold text-gray-300">수동 조정</div>
            <div className="flex gap-1">
              {(['translate', 'rotate', 'scale'] as ManualMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setManualMode(m)}
                  className={`flex-1 px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${
                    manualMode === m ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {m === 'translate' ? '이동' : m === 'rotate' ? '회전' : '스케일'}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-1">
              {(['X', 'Y', 'Z'] as const).map((axisLabel, ax) => (
                <div key={axisLabel} className="flex flex-col gap-1">
                  <div className="text-center text-[10px] text-gray-400">{axisLabel}</div>
                  <button onClick={() => nudge(manualMode, ax as 0 | 1 | 2, 1)}
                    className="px-1 py-0.5 bg-gray-700 hover:bg-gray-600 rounded text-[10px] cursor-pointer">+</button>
                  <button onClick={() => nudge(manualMode, ax as 0 | 1 | 2, -1)}
                    className="px-1 py-0.5 bg-gray-700 hover:bg-gray-600 rounded text-[10px] cursor-pointer">−</button>
                </div>
              ))}
            </div>
            <div className="text-[10px] text-gray-500 leading-relaxed">
              이동 5cm / 회전 5° / 스케일 5% 단위. "정합 (다시)" 누르면 수동 변경 무시하고 처음부터 자동.
            </div>
          </div>

          <button
            onClick={saveResult}
            disabled={savingResult}
            className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 text-white rounded cursor-pointer text-xs font-bold disabled:cursor-not-allowed"
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
