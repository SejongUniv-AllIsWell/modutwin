// 다듬기/문 설정 단계의 좌표 프레임 변환 유틸 — 한 곳에서 관리.
//
// 프레임 정의 (CLAUDE.md 의 Coordinate Conventions 참조):
//   raw   = PLY 파일 좌표 (splatData.posX/Y/Z 가 항상 보유). 메모리 안에서 다듬기 도중 안 변함.
//   A'    = raw + pendingRotation (rotX, rotZ). 다듬기 단계의 평면 정의·mesh corners 가 이 프레임.
//   A'+Y  = A' + wallAngle (Y 축 회전). 문 설정 완료 시점에 PLY/mesh/doors 가 이 프레임으로 베이크되어 저장.
//   world = splatEntity 의 worldTransform 적용 결과. = Z-180 · (다듬기 중) pendingRotation · raw
//                                                  = Z-180 · (재진입) raw_already_rotated
//
// 회전 합성 규약 (rotateScene / applyEntityRotation 와 동일):
//   pendingRotation: R_p = Rz(rotZ) · Rx(rotX). raw → A'.
//   wallAngle:       R_y = Ry(wallAngleRad).    A' → A'+Y.

import { loadRefineState } from './persistence';

export type Vec3 = [number, number, number];
export interface FrameRotation {
  rotX: number;        // pendingRotation rotX (radians)
  rotZ: number;        // pendingRotation rotZ (radians)
  wallAngleRad: number; // wallAngle Y (radians)
}

/** localStorage 에서 현재 다듬기 단계의 회전값을 불러옴. uploadId 미지정/없음이면 모두 0. */
export function getEditorRotation(uploadId: string | undefined): FrameRotation {
  const st = loadRefineState(uploadId ?? '');
  return {
    rotX: st?.rotX ?? 0,
    rotZ: st?.rotZ ?? 0,
    wallAngleRad: ((st?.wallAngle ?? 0) * Math.PI) / 180,
  };
}

// ── 점 변환 ──

/** raw → A' (pendingRotation 적용). vector·normal 둘 다 동일 식. */
export function rawToA(p: Vec3, r: FrameRotation): Vec3 {
  if (r.rotX === 0 && r.rotZ === 0) return [p[0], p[1], p[2]];
  const cx = Math.cos(r.rotX), sx = Math.sin(r.rotX);
  const cz = Math.cos(r.rotZ), sz = Math.sin(r.rotZ);
  // R = Rz · Rx (rotateScene 동일).
  return [
    cz * p[0] - sz * cx * p[1] + sz * sx * p[2],
    sz * p[0] + cz * cx * p[1] - cz * sx * p[2],
    sx * p[1] + cx * p[2],
  ];
}

/** A' → raw (pendingRotation^-1 = Rx(-rotX) · Rz(-rotZ)). */
export function aToRaw(p: Vec3, r: FrameRotation): Vec3 {
  if (r.rotX === 0 && r.rotZ === 0) return [p[0], p[1], p[2]];
  const cx = Math.cos(-r.rotX), sx = Math.sin(-r.rotX);
  const cz = Math.cos(-r.rotZ), sz = Math.sin(-r.rotZ);
  // 먼저 Rz^-1, 그 다음 Rx^-1.
  const x1 = cz * p[0] - sz * p[1];
  const y1 = sz * p[0] + cz * p[1];
  const z1 = p[2];
  return [
    x1,
    cx * y1 - sx * z1,
    sx * y1 + cx * z1,
  ];
}

/** A' → A'+Y (wallAngle Y 적용). */
export function aToAY(p: Vec3, r: FrameRotation): Vec3 {
  if (r.wallAngleRad === 0) return [p[0], p[1], p[2]];
  const cy = Math.cos(r.wallAngleRad), sy = Math.sin(r.wallAngleRad);
  return [
    cy * p[0] + sy * p[2],
    p[1],
    -sy * p[0] + cy * p[2],
  ];
}

/** A'+Y → A' (wallAngle^-1 = Ry(-wallAngle)). */
export function ayToA(p: Vec3, r: FrameRotation): Vec3 {
  if (r.wallAngleRad === 0) return [p[0], p[1], p[2]];
  const cy = Math.cos(-r.wallAngleRad), sy = Math.sin(-r.wallAngleRad);
  return [
    cy * p[0] + sy * p[2],
    p[1],
    -sy * p[0] + cy * p[2],
  ];
}

/** raw → A'+Y (= aToAY ∘ rawToA). */
export function rawToAY(p: Vec3, r: FrameRotation): Vec3 {
  return aToAY(rawToA(p, r), r);
}

/** A'+Y → raw (= aToRaw ∘ ayToA). */
export function ayToRaw(p: Vec3, r: FrameRotation): Vec3 {
  return aToRaw(ayToA(p, r), r);
}
