/**
 * 방 경계면 (천장/바닥/벽) 을 가우시안의 extent (3σ) 가 넘지 않게 scale 을 축소한다.
 *
 * 목표: center 가 평면 안쪽인 splat 의 평면 수직 (n) 방향 extent 가 |sd| − ε 이하가 되도록.
 *       (= 평면 안쪽 ε 위치까지만 뻗고 멈춤. 평면 통과 금지.)
 *
 * 방법: 평면 수직 방향 분산 (σ_n² = Σ a_in² · s_i²) 의 초과분을 각 axis 에 비례 분배.
 *       L2 최적 라그랑지안 해 → Δt_i = μ · a_in², μ = (σ_n² − T) / Σ a_in⁴.
 *       - n 에 수직인 axis (a_in = 0) 는 안 건드림 (그 방향 두께 보존).
 *       - n 에 정렬된 axis 는 가장 많이 줄임.
 *       - 중간 axis 는 정렬 정도에 비례.
 *
 * 음수 보정: new t_i < 0 이면 그 axis 를 0 으로 clamp 후 활성 axis 들 사이 재분배.
 *           최대 3 회 (axis 수만큼) 반복으로 수렴.
 *
 * 다중 평면: 평면별 순차 적용. axis scale 이 줄어들면 다른 평면의 σ_n² 도 같이 줄어
 *            연쇄 만족하는 경우가 많음. 잔여 평면만 추가 축소.
 */
import type { GaussianScene } from '../ply/types';
import type { SurfacePlane } from './planes';

export interface ClipScaleUpdate {
  idx: number;
  origLogScale: [number, number, number];
  newLogScale: [number, number, number];
}

export interface ClipOptions {
  /** sigma 배수. extent = kSigma · σ. default 3. */
  kSigma?: number;
  /** 평면 안쪽으로 살짝 당겨서 끊을 여유 거리 (m). default 0.001 (1mm). */
  epsilon?: number;
}

export function computeBoundaryClipping(
  scene: GaussianScene,
  planes: SurfacePlane[],
  opts: ClipOptions = {},
): ClipScaleUpdate[] {
  const kSigma = Math.max(1, opts.kSigma ?? 3);
  const epsilon = Math.max(0, opts.epsilon ?? 0.001);
  const kSq = kSigma * kSigma;

  const px = scene.attrs.get('x');
  const py = scene.attrs.get('y');
  const pz = scene.attrs.get('z');
  const r0 = scene.attrs.get('rot_0');
  const r1 = scene.attrs.get('rot_1');
  const r2 = scene.attrs.get('rot_2');
  const r3 = scene.attrs.get('rot_3');
  const sc0 = scene.attrs.get('scale_0');
  const sc1 = scene.attrs.get('scale_1');
  const sc2 = scene.attrs.get('scale_2');
  if (!px || !py || !pz || !r0 || !r1 || !r2 || !r3 || !sc0 || !sc1 || !sc2) {
    throw new Error('computeBoundaryClipping: required attrs missing (x,y,z,rot_0..3,scale_0..2)');
  }

  const updates: ClipScaleUpdate[] = [];
  const N = scene.numSplats;

  for (let i = 0; i < N; i++) {
    const cx = px[i], cy = py[i], cz = pz[i];

    // 쿼터니언 → R 의 column (각 local axis 의 world 방향).
    const qw0 = r0[i], qx0 = r1[i], qy0 = r2[i], qz0 = r3[i];
    const qLen = Math.hypot(qw0, qx0, qy0, qz0) || 1;
    const qw = qw0/qLen, qx = qx0/qLen, qy = qy0/qLen, qz = qz0/qLen;
    const xx = qx*qx, yy = qy*qy, zz = qz*qz;
    const xy = qx*qy, xz = qx*qz, yz = qy*qz;
    const wx = qw*qx, wy = qw*qy, wz = qw*qz;
    const lx0 = 1 - 2*(yy+zz), lx1 = 2*(xy+wz),     lx2 = 2*(xz-wy);
    const ly0 = 2*(xy-wz),     ly1 = 1 - 2*(xx+zz), ly2 = 2*(yz+wx);
    const lz0 = 2*(xz+wy),     lz1 = 2*(yz-wx),     lz2 = 1 - 2*(xx+yy);

    // 작업 변수: 분산 t_i = s_i² (linear 공간). log 두 번 변환 피함.
    const t0orig = Math.exp(2 * sc0[i]);
    const t1orig = Math.exp(2 * sc1[i]);
    const t2orig = Math.exp(2 * sc2[i]);
    let t0 = t0orig, t1 = t1orig, t2 = t2orig;

    for (const p of planes) {
      const nx = p.normal[0], ny = p.normal[1], nz = p.normal[2];
      const sd = nx*cx + ny*cy + nz*cz - p.d;
      if (sd > 0) continue; // center 가 평면 외부 → flatten 처리. clip 대상 아님.

      const absSd = -sd;
      const target = Math.max(0, absSd - epsilon);
      const T = (target * target) / kSq;

      const a0 = lx0*nx + lx1*ny + lx2*nz;
      const a1 = ly0*nx + ly1*ny + ly2*nz;
      const a2 = lz0*nx + lz1*ny + lz2*nz;
      const a0sq = a0*a0, a1sq = a1*a1, a2sq = a2*a2;

      // 활성 플래그 (n 에 직교 (a_in² = 0) 인 axis 는 σ_n² 기여 0 → 처음부터 제외).
      let act0 = a0sq > 0, act1 = a1sq > 0, act2 = a2sq > 0;

      // 라그랑지안 분배 + 음수 clamp 반복 (max 3 iter).
      for (let iter = 0; iter < 3; iter++) {
        let varN = 0, a4 = 0;
        if (act0) { varN += a0sq * t0; a4 += a0sq * a0sq; }
        if (act1) { varN += a1sq * t1; a4 += a1sq * a1sq; }
        if (act2) { varN += a2sq * t2; a4 += a2sq * a2sq; }
        if (varN <= T) break;       // 이미 만족.
        if (a4 <= 0) break;         // 활성 axis 가 모두 n 에 직교 (수치적 0). 종료.
        const mu = (varN - T) / a4;
        let clamped = false;
        if (act0) {
          const v = t0 - mu * a0sq;
          if (v < 0) { t0 = 0; act0 = false; clamped = true; } else { t0 = v; }
        }
        if (act1) {
          const v = t1 - mu * a1sq;
          if (v < 0) { t1 = 0; act1 = false; clamped = true; } else { t1 = v; }
        }
        if (act2) {
          const v = t2 - mu * a2sq;
          if (v < 0) { t2 = 0; act2 = false; clamped = true; } else { t2 = v; }
        }
        if (!clamped) break;        // 모두 정상 축소 → 수렴.
      }
    }

    // 변경 없으면 emit 안 함.
    if (t0 === t0orig && t1 === t1orig && t2 === t2orig) continue;

    // log(0) 회피 — t=0 인 axis 는 사실상 사라진 것이므로 안전한 floor.
    const SAFE = 1e-24; // s² 기준 → s ≈ 1e-12 m (= 1pm). 시각적으로 0.
    const lt0 = 0.5 * Math.log(Math.max(SAFE, t0));
    const lt1 = 0.5 * Math.log(Math.max(SAFE, t1));
    const lt2 = 0.5 * Math.log(Math.max(SAFE, t2));

    updates.push({
      idx: i,
      origLogScale: [sc0[i], sc1[i], sc2[i]],
      newLogScale: [lt0, lt1, lt2],
    });
  }

  return updates;
}
