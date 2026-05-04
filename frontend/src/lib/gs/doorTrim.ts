/**
 * 도어 4꼭짓점 직사각형의 4 edge plane 에 걸친 가우시안을 두 개로 분할.
 *
 * 각 boundary 가우시안 → wall-side sub + door-side sub.
 * 분할 위치: 가장 많이 가로지르는 edge plane 의 boundary 위치 (중심에서 sd 떨어진 자리).
 * 비대칭 — sd 위치 그대로, 1/2 강제 X.
 *
 * 분할된 sub 의 새 center / scale (수식, n_e = inward edge normal):
 *   ext   = 3σ along n_e (원본).
 *   door:  center += (ext − sd)/2 · n_e,   scale_ratio = (sd + ext)/(2·ext)
 *   wall:  center −= (ext + sd)/2 · n_e,   scale_ratio = (ext − sd)/(2·ext)
 * 이 비율은 원본 가우시안의 모든 axis scale 에 곱해짐 (uniform shrink).
 *
 * 가우시안 총 수: N → N + N_boundary.
 * - 메인 PLY 의 boundary slot 들은 wall-side sub 데이터로 in-place 덮어쓰기 (caller 가 GPU sync).
 * - door-side sub 들은 별도 GaussianScene 으로 반환 (additional splat group 용).
 */

import type { GaussianScene } from '../ply/types';

export type Vec3 = [number, number, number];

export interface DoorRectangle {
  /** 4꼭짓점 (CW: TL → TR → BR → BL). 거의 한 평면 위에 있어야 함. */
  corners: [Vec3, Vec3, Vec3, Vec3];
}

interface RectGeom {
  edgeNormals: [Vec3, Vec3, Vec3, Vec3];
  edgeOrigins: [Vec3, Vec3, Vec3, Vec3];
  /** rect 가 놓인 평면(=벽 평면)의 normal. 부호는 임의 (signed distance 만 |.| 로 사용). */
  planeNormal: Vec3;
  /** 평면 위 한 점 (corners[0]). signed distance 기준점. */
  planeOrigin: Vec3;
}

function vsub(a: Vec3, b: Vec3): Vec3 { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vcross(a: Vec3, b: Vec3): Vec3 {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function vdot(a: Vec3, b: Vec3): number { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function vnorm(a: Vec3): Vec3 {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0]/n, a[1]/n, a[2]/n];
}

/** 4꼭짓점 → 4 edge plane (각 변 위의 한 점 + inward normal). */
export function rectGeom(corners: [Vec3, Vec3, Vec3, Vec3]): RectGeom {
  const [P0, P1, P2, P3] = corners;
  const e01 = vsub(P1, P0);
  const e03 = vsub(P3, P0);
  const planeN = vnorm(vcross(e01, e03));
  const center: Vec3 = [
    (P0[0]+P1[0]+P2[0]+P3[0])/4,
    (P0[1]+P1[1]+P2[1]+P3[1])/4,
    (P0[2]+P1[2]+P2[2]+P3[2])/4,
  ];
  const edges: [Vec3, Vec3, Vec3, Vec3] = [P0, P1, P2, P3];
  const edgeDirs: [Vec3, Vec3, Vec3, Vec3] = [
    vsub(P1, P0), vsub(P2, P1), vsub(P3, P2), vsub(P0, P3),
  ];
  const edgeNormals: [Vec3, Vec3, Vec3, Vec3] = [[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 4; i++) {
    let n = vnorm(vcross(planeN, edgeDirs[i]));
    const toCenter = vsub(center, edges[i]);
    if (vdot(n, toCenter) < 0) n = [-n[0], -n[1], -n[2]];
    edgeNormals[i] = n;
  }
  return { edgeNormals, edgeOrigins: edges, planeNormal: planeN, planeOrigin: P0 };
}

export interface DecomposeOptions {
  /**
   * 추가 안전 margin (0 ~ 0.3). 각 sub 의 scale 에 (1 − margin) 곱.
   * boundary 에서 살짝 더 들여 자르기 — 0 이면 정확히 boundary 까지, 0.05 면 5% 더 들여 자름.
   */
  safetyMargin?: number;
  /**
   * "boundary 에서 얼마나 떨어져야 fully inside/outside 로 판정하는지" 에 사용하는 σ 배수.
   * 기본 3 — 3DGS 렌더링이 2D projected footprint 를 3σ 에서 컷하므로 시각 한계 일치.
   * 코너 부근에서 드물게 새어나오는 경우 4 등으로 올려서 더 보수적 판정 가능.
   */
  sigmaMultiplier?: number;
  /**
   * 문 두께 (m). 벽 평면에서 **방 안쪽으로** 들어가는 단방향 깊이.
   * 도어로 분류되려면 splat center 가 벽 평면 ~0 부터 -doorThickness 사이여야 함
   * (방 바깥은 다듬기 단계에서 이미 alpha=0 처리되었으므로 슬랩이 비대칭).
   * 손잡이/잠금처럼 벽에서 방 안쪽으로 돌출된 splat 도 doorThickness 이내면 도어로 잡힘.
   * 미지정 또는 0 이하 시 깊이 필터 없음.
   */
  doorThickness?: number;
  /**
   * 벽 평면의 outward 방향 단위벡터 (방 바깥 방향). 슬랩의 비대칭 방향 결정에 사용.
   * `surfacePlanesFromRoom` 의 plane.normal 을 그대로 넘기면 됨.
   * 미지정 시 rectGeom.planeNormal 의 부호를 임의로 사용 — 비대칭이 의도와 반대로 동작할 수 있으므로 가능하면 명시.
   */
  wallOutwardNormal?: Vec3;
}

/**
 * splat center 가 도어 슬랩 안인지 판정 (decompose 와 페인트 분류가 같은 기준 사용 위해 export).
 *
 * 슬랩: 벽 평면에서 방 안쪽으로 doorThickness 깊이까지의 단방향 영역.
 * - sdOut = (c - pO) · wallOutward.  방 안쪽 → 음수, 방 바깥 → 양수.
 * - 허용: -doorThickness ≤ sdOut ≤ EPS_OUT (벽 바깥 미세 누출 1mm 까지만 허용).
 *
 * doorThickness ≤ 0 이면 깊이 필터 없음 (true 항상).
 */
export function isInDoorSlab(
  cx: number, cy: number, cz: number,
  planeOrigin: Vec3,
  wallOutward: Vec3,
  doorThickness: number,
): boolean {
  if (!(doorThickness > 0)) return true;
  const sdOut = (cx - planeOrigin[0]) * wallOutward[0]
              + (cy - planeOrigin[1]) * wallOutward[1]
              + (cz - planeOrigin[2]) * wallOutward[2];
  const EPS_OUT = 1e-3; // 1mm — 부동소수 오차 허용.
  return sdOut <= EPS_OUT && sdOut >= -doorThickness;
}

export interface BoundarySubUpdate {
  /** 원본 splat 인덱스 (메인 PLY) — 이 슬롯이 wall-side sub 로 in-place 덮어쓰기됨. */
  idx: number;
  /** wall-side sub 의 새 위치 (raw 프레임). */
  wallNewPos: Vec3;
  /** wall-side sub 의 새 log-scale (3축, log-space). */
  wallNewLogScale: [number, number, number];
}

export interface DoorSubMeta {
  /** door-side sub 의 출처가 된 원본 splat 인덱스 (attrs 복사용). */
  origIdx: number;
  /** door-side sub 의 새 위치 (raw 프레임). */
  doorNewPos: Vec3;
  /** door-side sub 의 새 log-scale. */
  doorNewLogScale: [number, number, number];
}

export interface DecomposeResult {
  /** boundary 였던 원본 splat 의 인덱스 (변경 대상). */
  boundaryIndices: number[];
  /** 메인 PLY 의 boundary 슬롯에 적용할 wall-side sub 데이터. */
  wallSideUpdates: BoundarySubUpdate[];
  /** door-side sub 메타데이터 (원본 인덱스 + 새 pos/scale). */
  doorSubMetadata: DoorSubMeta[];
  /** 4 edge 모두 inward 측 (fully inside) 인 원본 splat 인덱스. 회전 시 묶음 후보. */
  doorOriginalIndices: number[];
  /** 어느 한 edge 의 outward 측 (fully outside) 인 원본 splat 인덱스. */
  wallOriginalIndices: number[];
}

/**
 * 도어 boundary 분할 계산.
 *
 * scene 은 READ-only — 본 함수는 scene 을 변경하지 않음. 변경 사항은 결과 객체로 반환.
 * caller 가 wallSideUpdates 를 메인 splat data 에 적용 + doorSubMetadata 로 별도 GaussianScene 구성.
 *
 * @param scene 가우시안 씬 (raw PLY 프레임). corners 도 같은 프레임이어야 함.
 * @param rect 도어 직사각형.
 * @param opts safetyMargin 등.
 */
export function decomposeBoundaryGaussians(
  scene: GaussianScene,
  rect: DoorRectangle,
  opts: DecomposeOptions = {},
): DecomposeResult {
  const safety = Math.max(0, Math.min(0.5, opts.safetyMargin ?? 0));
  const kSigma = Math.max(2, opts.sigmaMultiplier ?? 3);
  const doorThickness = (opts.doorThickness !== undefined && opts.doorThickness > 0)
    ? opts.doorThickness
    : 0; // 0 = 깊이 필터 비활성.
  const geom = rectGeom(rect.corners);
  const pO = geom.planeOrigin;
  // 슬랩 방향: 명시된 wallOutwardNormal 우선. 없으면 rectGeom.planeNormal 부호를 임의로 사용 (구버전 호환).
  const wallOut: Vec3 = opts.wallOutwardNormal ?? geom.planeNormal;
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
    throw new Error('decomposeBoundaryGaussians: required attrs missing');
  }
  const N = scene.numSplats;

  const boundaryIndices: number[] = [];
  const wallSideUpdates: BoundarySubUpdate[] = [];
  const doorSubMetadata: DoorSubMeta[] = [];
  const doorOriginalIndices: number[] = [];
  const wallOriginalIndices: number[] = [];

  for (let i = 0; i < N; i++) {
    const cx = px[i], cy = py[i], cz = pz[i];
    // 쿼터니언 → 회전 행렬
    const qw0 = r0[i], qx0 = r1[i], qy0 = r2[i], qz0 = r3[i];
    const qLen = Math.hypot(qw0, qx0, qy0, qz0) || 1;
    const qw = qw0/qLen, qx = qx0/qLen, qy = qy0/qLen, qz = qz0/qLen;
    const xx = qx*qx, yy = qy*qy, zz = qz*qz;
    const xy = qx*qy, xz = qx*qz, yz = qy*qz;
    const wx = qw*qx, wy = qw*qy, wz = qw*qz;
    const R00 = 1-2*(yy+zz), R01 = 2*(xy-wz), R02 = 2*(xz+wy);
    const R10 = 2*(xy+wz),   R11 = 1-2*(xx+zz), R12 = 2*(yz-wx);
    const R20 = 2*(xz-wy),   R21 = 2*(yz+wx),   R22 = 1-2*(xx+yy);
    const s0 = Math.exp(sc0[i]), s1 = Math.exp(sc1[i]), s2 = Math.exp(sc2[i]);

    // 4 edge 검사: fully outside (한 edge 라도 sd <= -ext) 인지, 아니면 가로지르는 edge 가 있는지.
    let isOutside = false;
    let mostBoundaryEdge = -1;
    let bestAbsSd = Infinity;
    let bestSd = 0, bestExt = 0;
    let bestN: Vec3 = [0, 0, 0];
    // 비등방 분할용: 선택된 edge 의 n 이 splat local axis 들 (R 의 column) 에 갖는 방향 코사인.
    let bestA0n = 0, bestA1n = 0, bestA2n = 0;

    for (let e = 0; e < 4; e++) {
      const n = geom.edgeNormals[e];
      const o = geom.edgeOrigins[e];
      const sd = (cx-o[0])*n[0] + (cy-o[1])*n[1] + (cz-o[2])*n[2];
      const a0n = R00*n[0] + R10*n[1] + R20*n[2];
      const a1n = R01*n[0] + R11*n[1] + R21*n[2];
      const a2n = R02*n[0] + R12*n[1] + R22*n[2];
      const variance = a0n*a0n*s0*s0 + a1n*a1n*s1*s1 + a2n*a2n*s2*s2;
      const ext = kSigma * Math.sqrt(variance);
      if (ext < 1e-6) continue;
      // STRICT: center 가 어느 한 edge 의 outside (sd < 0) 면 도어 영역 X. 가로세로 방향 확장 없음.
      if (sd < 0) { isOutside = true; break; }
      if (sd < ext) {
        // 가로지름. 가장 깊게 가로지르는 (|sd| 작은) edge 를 분할 기준으로.
        const absSd = Math.abs(sd);
        if (absSd < bestAbsSd) {
          bestAbsSd = absSd;
          mostBoundaryEdge = e;
          bestSd = sd; bestExt = ext; bestN = n;
          bestA0n = a0n; bestA1n = a1n; bestA2n = a2n;
        }
      }
    }

    if (isOutside) {
      wallOriginalIndices.push(i);
      continue;
    }

    // 벽 평면 깊이 필터 — 비대칭 슬랩 (방 안쪽 단방향). 슬랩 밖이면 도어 영역 X.
    // (이 필터 없이 boundary 로 분류되면 door-side sub 가 깊은 위치에서 도어와 함께 회전 → 시각 이상)
    if (!isInDoorSlab(cx, cy, cz, pO, wallOut, doorThickness)) {
      continue;
    }

    if (mostBoundaryEdge < 0) {
      // 4 edge 모두 fully inside (sd >= ext) AND ±halfThickness 안 → 진짜 도어 영역.
      doorOriginalIndices.push(i);
      continue;
    }

    // 분할: door-side / wall-side sub 두 개 생성.
    const sd = bestSd, ext = bestExt, n = bestN;
    const fIn  = (sd + ext) / (2 * ext);   // door-side scale ratio
    const fOut = (ext - sd) / (2 * ext);   // wall-side scale ratio
    // 안전 margin 적용 (sub 가 boundary 에 살짝 못 미치도록)
    const fInS  = Math.max(1e-6, fIn  * (1 - safety));
    const fOutS = Math.max(1e-6, fOut * (1 - safety));
    const offsetIn  = (ext - sd) / 2;  // door-side: +n 방향
    const offsetOut = (ext + sd) / 2;  // wall-side: -n 방향

    const doorNewPos: Vec3 = [
      cx + n[0] * offsetIn,
      cy + n[1] * offsetIn,
      cz + n[2] * offsetIn,
    ];
    const wallNewPos: Vec3 = [
      cx - n[0] * offsetOut,
      cy - n[1] * offsetOut,
      cz - n[2] * offsetOut,
    ];

    // ── 비등방 (anisotropic) scale 보정 ──
    // 변 normal n 방향만 fInS / fOutS 배 줄이고, n 에 수직인 방향은 거의 그대로 유지.
    // 각 local axis i 에 곱할 배수 g_i:
    //   g_i^2 = 1 - a_in^2 * (1 - f^2)
    //   - axis 가 n 과 평행 (a_in^2 = 1): g_i = f → 그 축만 f 배 (1D 절단).
    //   - axis 가 n 에 수직 (a_in = 0):    g_i = 1 → 그대로 (변 평행한 두께 유지 → 빈틈 없음).
    //   - 중간 정렬: 부드러운 보간.
    // 결과: splat extent 가 변 수직 방향으로만 줄어들어 인접 splat 끼리 변에서 정확히 맞물림.
    const fIn2 = fInS * fInS;
    const fOut2 = fOutS * fOutS;
    const a0sq = bestA0n * bestA0n;
    const a1sq = bestA1n * bestA1n;
    const a2sq = bestA2n * bestA2n;
    const gIn0_sq  = Math.max(1e-12, 1 - a0sq * (1 - fIn2));
    const gIn1_sq  = Math.max(1e-12, 1 - a1sq * (1 - fIn2));
    const gIn2_sq  = Math.max(1e-12, 1 - a2sq * (1 - fIn2));
    const gOut0_sq = Math.max(1e-12, 1 - a0sq * (1 - fOut2));
    const gOut1_sq = Math.max(1e-12, 1 - a1sq * (1 - fOut2));
    const gOut2_sq = Math.max(1e-12, 1 - a2sq * (1 - fOut2));
    // log-scale 공간이라 0.5 * log(g^2) = log(g) 더하면 결과 scale = 원본 * g.
    const wallNewLogScale: [number, number, number] = [
      sc0[i] + 0.5 * Math.log(gOut0_sq),
      sc1[i] + 0.5 * Math.log(gOut1_sq),
      sc2[i] + 0.5 * Math.log(gOut2_sq),
    ];
    const doorNewLogScale: [number, number, number] = [
      sc0[i] + 0.5 * Math.log(gIn0_sq),
      sc1[i] + 0.5 * Math.log(gIn1_sq),
      sc2[i] + 0.5 * Math.log(gIn2_sq),
    ];

    boundaryIndices.push(i);
    wallSideUpdates.push({ idx: i, wallNewPos, wallNewLogScale });
    doorSubMetadata.push({ origIdx: i, doorNewPos, doorNewLogScale });
  }

  return {
    boundaryIndices,
    wallSideUpdates,
    doorSubMetadata,
    doorOriginalIndices,
    wallOriginalIndices,
  };
}

/**
 * decompose 결과의 doorSubMetadata 로 새 GaussianScene 생성.
 * 각 sub: 원본 splat 의 모든 attrs 복사 + pos/scale 만 새 값.
 */
export function buildDoorSubScene(
  scene: GaussianScene,
  doorSubs: DoorSubMeta[],
): GaussianScene {
  const M = doorSubs.length;
  const outAttrs = new Map<string, Float32Array>();
  for (const prop of scene.propertyOrder) {
    if (scene.attrs.has(prop)) outAttrs.set(prop, new Float32Array(M));
  }
  for (let i = 0; i < M; i++) {
    const meta = doorSubs[i];
    outAttrs.forEach((arr, prop) => {
      arr[i] = scene.attrs.get(prop)![meta.origIdx];
    });
    outAttrs.get('x')![i] = meta.doorNewPos[0];
    outAttrs.get('y')![i] = meta.doorNewPos[1];
    outAttrs.get('z')![i] = meta.doorNewPos[2];
    outAttrs.get('scale_0')![i] = meta.doorNewLogScale[0];
    outAttrs.get('scale_1')![i] = meta.doorNewLogScale[1];
    outAttrs.get('scale_2')![i] = meta.doorNewLogScale[2];
  }
  return {
    numSplats: M,
    propertyOrder: [...scene.propertyOrder],
    attrs: outAttrs,
  };
}

/** 점이 직사각형 (4 edge inward 측 모두) 안에 있는지. */
export function isInsideRect(point: Vec3, geom: RectGeom): boolean {
  for (let i = 0; i < 4; i++) {
    const d = vdot(vsub(point, geom.edgeOrigins[i]), geom.edgeNormals[i]);
    if (d < 0) return false;
  }
  return true;
}

/**
 * 도어 4꼭짓점 (CW: TL, TR, BR, BL) 으로 textureBake 의 PlaneBakeInput 구성.
 * normal 방향은 wallNormal 과 같은 방향 (방 바깥) 이 되도록 cross product 부호 보정.
 *
 * extends 0 — 도어는 인접 면이 wall 자신이라 padding 불필요. mesh quad 는 4꼭짓점 그대로.
 */
export function doorPlaneBakeInput(
  corners: [Vec3, Vec3, Vec3, Vec3],
  wallNormal: Vec3,
): {
  origin: Vec3; uAxis: Vec3; vAxis: Vec3; normal: Vec3;
  uMin: number; uMax: number; vMin: number; vMax: number;
  extendU0: number; extendU1: number; extendV0: number; extendV1: number;
  meshOffset: number;
} {
  const [TL, TR, , BL] = corners;
  const eU = vsub(TR, TL);
  const eV = vsub(BL, TL);
  const uLen = Math.hypot(eU[0], eU[1], eU[2]) || 1;
  const vLen = Math.hypot(eV[0], eV[1], eV[2]) || 1;
  const uAxis: Vec3 = [eU[0]/uLen, eU[1]/uLen, eU[2]/uLen];
  const vAxis: Vec3 = [eV[0]/vLen, eV[1]/vLen, eV[2]/vLen];
  let normal = vnorm(vcross(uAxis, vAxis));
  if (vdot(normal, wallNormal) < 0) normal = [-normal[0], -normal[1], -normal[2]];
  return {
    origin: TL,
    uAxis, vAxis, normal,
    uMin: 0, uMax: uLen,
    vMin: 0, vMax: vLen,
    extendU0: 0, extendU1: 0, extendV0: 0, extendV1: 0,
    meshOffset: 0,
  };
}

/**
 * 평면 4꼭짓점 (raw 프레임) + wall mesh 의 4꼭짓점/UVs 를 받아,
 * 도어 영역에 해당하는 wall texture 픽셀의 alpha 를 0 으로 설정.
 *
 * wall mesh corners 는 직사각형 (방 평면) — bilinear inverse 로 (s,t) ∈ [0,1]² 추출 후 UV 보간.
 * 도어 corner 4 점이 먼저 wall mesh 평면에 투영돼야 하지만, 도어 corner 는 이미 같은 평면 위
 * (raycastToPlanes 결과) 이므로 별도 투영 불필요.
 *
 * @param rgba    wall mesh emissiveMap 의 픽셀 데이터 (Uint8ClampedArray, 길이 = w*h*4).
 * @param w,h     wall texture 크기.
 * @param wallCorners wall mesh 4꼭짓점 (TL, TR, BR, BL, raw 프레임).
 * @param wallUvs     wall mesh 4꼭짓점의 UV (TL, TR, BR, BL).
 * @param doorCorners 도어 4꼭짓점 (TL, TR, BR, BL, raw 프레임).
 * @returns 변경된 픽셀 수.
 */
export function punchAlphaZeroInDoorRegion(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  wallCorners: [Vec3, Vec3, Vec3, Vec3],
  wallUvs: [[number, number], [number, number], [number, number], [number, number]],
  doorCorners: [Vec3, Vec3, Vec3, Vec3],
): number {
  // wall plane 의 (e_u, e_v) basis (TL 원점) — 평면 affine 좌표.
  const TLw = wallCorners[0], TRw = wallCorners[1], BLw = wallCorners[3];
  const eU = vsub(TRw, TLw);
  const eV = vsub(BLw, TLw);
  const eUlen2 = vdot(eU, eU);
  const eVlen2 = vdot(eV, eV);

  // 도어 corner 를 wall (s, t) 로 투영.
  const stOf = (P: Vec3): [number, number] => {
    const d = vsub(P, TLw);
    return [vdot(d, eU) / eUlen2, vdot(d, eV) / eVlen2];
  };
  const doorST: [number, number][] = [
    stOf(doorCorners[0]),
    stOf(doorCorners[1]),
    stOf(doorCorners[2]),
    stOf(doorCorners[3]),
  ];

  // 각 (s,t) 를 wall UV 로 보간 (bilinear) 후 픽셀 좌표로.
  const stToPixel = (s: number, t: number): [number, number] => {
    const omS = 1 - s, omT = 1 - t;
    const u = omS*omT*wallUvs[0][0] + s*omT*wallUvs[1][0] + s*t*wallUvs[2][0] + omS*t*wallUvs[3][0];
    const v = omS*omT*wallUvs[0][1] + s*omT*wallUvs[1][1] + s*t*wallUvs[2][1] + omS*t*wallUvs[3][1];
    return [u * w, v * h];
  };
  const doorPx: [number, number][] = doorST.map(([s, t]) => stToPixel(s, t));

  // bbox + point-in-quad (cross product test, 4 edges).
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const [px, py] of doorPx) {
    if (px < xMin) xMin = px; if (px > xMax) xMax = px;
    if (py < yMin) yMin = py; if (py > yMax) yMax = py;
  }
  const xLo = Math.max(0, Math.floor(xMin));
  const xHi = Math.min(w - 1, Math.ceil(xMax));
  const yLo = Math.max(0, Math.floor(yMin));
  const yHi = Math.min(h - 1, Math.ceil(yMax));
  if (xLo > xHi || yLo > yHi) return 0;

  // 4변 (P0→P1, P1→P2, P2→P3, P3→P0). inside = 모든 cross 가 같은 부호.
  // 부호는 첫 변에서 sample 후 일관 검사.
  const edgeCross = (i: number, x: number, y: number): number => {
    const [x0, y0] = doorPx[i];
    const [x1, y1] = doorPx[(i + 1) % 4];
    return (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0);
  };
  // 중심 좌표로 부호 판정 (안정).
  const cx = (doorPx[0][0] + doorPx[1][0] + doorPx[2][0] + doorPx[3][0]) / 4;
  const cy = (doorPx[0][1] + doorPx[1][1] + doorPx[2][1] + doorPx[3][1]) / 4;
  const sign = Math.sign(edgeCross(0, cx, cy));

  let touched = 0;
  for (let y = yLo; y <= yHi; y++) {
    const rowBase = y * w * 4 + 3;
    for (let x = xLo; x <= xHi; x++) {
      let inside = true;
      for (let i = 0; i < 4; i++) {
        const c = edgeCross(i, x + 0.5, y + 0.5);
        if (c * sign < 0) { inside = false; break; }
      }
      if (!inside) continue;
      const idx = rowBase + x * 4;
      if (rgba[idx] !== 0) { rgba[idx] = 0; touched++; }
    }
  }
  return touched;
}

/**
 * 평면 4꼭짓점 (raw 프레임) + wall mesh 의 4꼭짓점/UVs 를 받아,
 * 도어 영역에 해당하는 wall texture 픽셀들을 새 RGBA 버퍼로 잘라서 반환.
 *
 * `punchAlphaZeroInDoorRegion` 과 동일한 projection (wall plane (s,t) → wall UV → wall pixel).
 * axis-aligned bbox 로 cut → 실제 도어 사각형이 wall 텍스쳐와 정렬돼 있을 때 정확.
 * (도어가 wall 에 대해 회전돼 있으면 bbox 안에 도어 외부 픽셀도 포함되지만, 도어 mesh quad
 *  의 UV [(0,0),(1,0),(1,1),(0,1)] 매핑상 quad 내부로만 매핑되므로 시각 영향 미미.)
 *
 * 정합 단계의 도어 mesh 텍스쳐 = wall 텍스쳐의 도어 영역 픽셀 그대로. 알파블렌딩 X.
 *
 * @returns rgba/width/height. 도어 mesh 의 emissiveMap 으로 직접 사용 가능.
 */
export function extractDoorRegionTexture(
  wallRgba: Uint8ClampedArray | Uint8Array,
  wallW: number,
  wallH: number,
  wallCorners: [Vec3, Vec3, Vec3, Vec3],
  wallUvs: [[number, number], [number, number], [number, number], [number, number]],
  doorCorners: [Vec3, Vec3, Vec3, Vec3],
): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** 도어 4 코너의 cut texture 픽셀 좌표 ([0..width-1] × [0..height-1]).
   *  caller 가 정확한 mesh UV 를 산출하는 데 사용 (axis-aligned bbox crop 이라 도어 corner 가 bbox corner 와
   *  꼭 일치하지 않을 수 있음 — 사다리꼴 등 비축정렬 케이스). */
  doorCornerPx: [[number, number], [number, number], [number, number], [number, number]];
} {
  const TLw = wallCorners[0], TRw = wallCorners[1], BLw = wallCorners[3];
  const eU = vsub(TRw, TLw);
  const eV = vsub(BLw, TLw);
  const eUlen2 = vdot(eU, eU);
  const eVlen2 = vdot(eV, eV);

  const stOf = (P: Vec3): [number, number] => {
    const d = vsub(P, TLw);
    return [vdot(d, eU) / eUlen2, vdot(d, eV) / eVlen2];
  };
  const doorST: [number, number][] = [
    stOf(doorCorners[0]),
    stOf(doorCorners[1]),
    stOf(doorCorners[2]),
    stOf(doorCorners[3]),
  ];

  const stToPixel = (s: number, t: number): [number, number] => {
    const omS = 1 - s, omT = 1 - t;
    const u = omS*omT*wallUvs[0][0] + s*omT*wallUvs[1][0] + s*t*wallUvs[2][0] + omS*t*wallUvs[3][0];
    const v = omS*omT*wallUvs[0][1] + s*omT*wallUvs[1][1] + s*t*wallUvs[2][1] + omS*t*wallUvs[3][1];
    return [u * wallW, v * wallH];
  };
  const doorPx: [number, number][] = doorST.map(([s, t]) => stToPixel(s, t));

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const [px, py] of doorPx) {
    if (px < xMin) xMin = px; if (px > xMax) xMax = px;
    if (py < yMin) yMin = py; if (py > yMax) yMax = py;
  }
  const xLo = Math.max(0, Math.floor(xMin));
  const xHi = Math.min(wallW - 1, Math.ceil(xMax));
  const yLo = Math.max(0, Math.floor(yMin));
  const yHi = Math.min(wallH - 1, Math.ceil(yMax));
  const cutW = Math.max(1, xHi - xLo + 1);
  const cutH = Math.max(1, yHi - yLo + 1);
  const rgba = new Uint8ClampedArray(cutW * cutH * 4);
  for (let y = 0; y < cutH; y++) {
    const srcRowBase = (yLo + y) * wallW * 4;
    const dstRowBase = y * cutW * 4;
    for (let x = 0; x < cutW; x++) {
      const srcIdx = srcRowBase + (xLo + x) * 4;
      const dstIdx = dstRowBase + x * 4;
      rgba[dstIdx + 0] = wallRgba[srcIdx + 0];
      rgba[dstIdx + 1] = wallRgba[srcIdx + 1];
      rgba[dstIdx + 2] = wallRgba[srcIdx + 2];
      rgba[dstIdx + 3] = wallRgba[srcIdx + 3];
    }
  }
  // 도어 4 코너의 cut texture 픽셀 좌표 — wall texture 픽셀 - bbox 좌상단.
  const doorCornerPx: [[number, number], [number, number], [number, number], [number, number]] = [
    [doorPx[0][0] - xLo, doorPx[0][1] - yLo],
    [doorPx[1][0] - xLo, doorPx[1][1] - yLo],
    [doorPx[2][0] - xLo, doorPx[2][1] - yLo],
    [doorPx[3][0] - xLo, doorPx[3][1] - yLo],
  ];
  return { rgba, width: cutW, height: cutH, doorCornerPx };
}
