// 도어 4 코너 직사각형 정규화 — 수동 픽 / 자동(SAM3) 추출 / N-door outline 모두 공유.
// DoorAlignModal 에 있던 normalizeDoorRect 를 추출해, 검출 응답 직후(부모)·모달(picked/bake)이
// 동일 로직으로 직사각형 보간하도록 한다.

import { rawToA, aToRaw, type FrameRotation } from '@/lib/refine/coordFrames';
import type { SurfacePlane, Vec3 } from '@/lib/gs/planes';

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
 *
 * corners 는 raw 프레임, plane 은 A' 프레임 — u/v 분해 + recon 은 A' 에서 일관 처리.
 */
export function normalizeDoorRect(
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
 * raw 코너 4개 + 평면 목록 → closest 벽 평면 기준 직사각형 정규화한 raw 코너.
 * (DoorAlignModal 의 closest-plane 추정과 동일: 첫 코너를 A' 로 올려 |n·P − d| 최소 평면 선택.)
 * 평면을 못 찾으면 원본 그대로 반환.
 */
export function normalizeDoorCornersRaw(
  cornersRaw: Array<[number, number, number]>,
  planes: SurfacePlane[],
  rotation: FrameRotation,
): Array<[number, number, number]> {
  if (cornersRaw.length !== 4 || !planes.length) return cornersRaw;
  const refA = rawToA([cornersRaw[0][0], cornersRaw[0][1], cornersRaw[0][2]] as Vec3, rotation);
  let bestId = '';
  let bestSd = Infinity;
  for (const p of planes) {
    const sd = Math.abs(p.normal[0] * refA[0] + p.normal[1] * refA[1] + p.normal[2] * refA[2] - p.d);
    if (sd < bestSd) { bestSd = sd; bestId = p.id; }
  }
  const wall = planes.find(p => p.id === bestId);
  if (!wall) return cornersRaw;
  const normalized = normalizeDoorRect(
    [cornersRaw[0], cornersRaw[1], cornersRaw[2], cornersRaw[3]] as [Vec3, Vec3, Vec3, Vec3],
    wall, null, rotation,
  );
  return normalized.map(p => [p[0], p[1], p[2]] as [number, number, number]);
}
