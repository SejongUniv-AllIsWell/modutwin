/**
 * 문 4꼭짓점 직사각형 boundary 에 걸친 가우시안을 두 개로 분해.
 *
 * SAGS (Segment Anything in 3D Gaussians, https://github.com/XuHu0529/SAGS) 의 Gaussian
 * Decomposition 아이디어를 단순화. SAGS 는 임의 SAM mask 를 다루는 반면, 여기는 4꼭짓점으로
 * 정의된 직사각형이라 평면 4개 (각 변마다 변 평면) 만 검사.
 *
 * 개념:
 *  - 직사각형 = 평면 위 4 변 → 평면 4개 (변 평면, 직사각형 안쪽 향함).
 *  - 가우시안의 3σ extent 가 어떤 변 평면을 가로지르면 boundary.
 *  - boundary 가우시안 → 가장 변 평면 normal 과 정렬된 주축으로 ±s/2 만큼 분리한 두 가우시안으로 대체.
 *  - 각 sub-gaussian 의 center 가 직사각형 안쪽인지 여부로 door/wall 분류.
 *
 * 결과:
 *  - 입력 scene 보다 numSplats 가 boundary 갯수만큼 증가한 새 scene.
 *  - door / wall 인덱스 배열 (새 scene 의 인덱스).
 *
 * 한계 / 단순화:
 *  - 한 번에 하나의 변 평면 기준으로만 분해 (코너 가우시안 = 두 변에 동시에 걸친 경우 한 번만 처리).
 *    → 필요하면 재귀 분해로 확장 가능.
 *  - opacity 그대로 유지 (정확한 정수 보존 안 함). 시각 차이 미세.
 *  - Spherical harmonics 계수 (f_rest_*) 그대로 복사. 회전된 분해 후엔 view-dependent 색이
 *    조금 어긋날 수 있는데, 도어 정도 회전(개폐) 에는 무관할 가능성 큼.
 */

import type { GaussianScene } from '../ply/types';

export type Vec3 = [number, number, number];

export interface DoorRectangle {
  /** 4꼭짓점 (CCW 또는 CW). 평면 위 거의 동일한 평면에 있어야 함. */
  corners: [Vec3, Vec3, Vec3, Vec3];
}

export interface DecomposeResult {
  /** 분해 후 새 GaussianScene. numSplats = 입력 N + boundary 수. */
  scene: GaussianScene;
  /** 도어 영역 (직사각형 안) 으로 분류된 가우시안의 인덱스 (출력 scene 기준). */
  doorIndices: number[];
  /** 도어 외 (벽) 로 분류된 가우시안의 인덱스 (출력 scene 기준). */
  wallIndices: number[];
  /** 진단용: 분해된 boundary 가우시안 수. */
  numDecomposed: number;
}

interface RectGeom {
  /** 직사각형 평면의 한 점 (P0). */
  origin: Vec3;
  /** 직사각형 평면의 normal (양면 중 한쪽). */
  planeNormal: Vec3;
  /** 4 변 각각의 안쪽 normal (변 평면, 직사각형 안쪽 향함). */
  edgeNormals: [Vec3, Vec3, Vec3, Vec3];
  /** 4 변의 시작점 (P_i). */
  edgeOrigins: [Vec3, Vec3, Vec3, Vec3];
}

function vecSub(a: Vec3, b: Vec3): Vec3 { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vecCross(a: Vec3, b: Vec3): Vec3 {
  return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
}
function vecDot(a: Vec3, b: Vec3): number { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function vecNorm(a: Vec3): Vec3 {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0]/n, a[1]/n, a[2]/n];
}

/**
 * 4꼭짓점에서 직사각형 기하 (평면 normal + 변 평면 4개) 계산.
 *
 * 변 평면의 inward normal 부호는 직사각형 중심을 기준으로 자동 보정.
 */
export function rectangleGeom(corners: [Vec3, Vec3, Vec3, Vec3]): RectGeom {
  const [P0, P1, P2, P3] = corners;
  // 평면 normal: 두 인접 변의 외적
  const e01 = vecSub(P1, P0);
  const e03 = vecSub(P3, P0);
  const planeNormal = vecNorm(vecCross(e01, e03));

  // 직사각형 중심 (4꼭짓점 평균)
  const center: Vec3 = [
    (P0[0] + P1[0] + P2[0] + P3[0]) / 4,
    (P0[1] + P1[1] + P2[1] + P3[1]) / 4,
    (P0[2] + P1[2] + P2[2] + P3[2]) / 4,
  ];

  // 변 4개 (P0→P1, P1→P2, P2→P3, P3→P0)
  const edges: [Vec3, Vec3, Vec3, Vec3] = [P0, P1, P2, P3];
  const edgeDirs: [Vec3, Vec3, Vec3, Vec3] = [
    vecSub(P1, P0), vecSub(P2, P1), vecSub(P3, P2), vecSub(P0, P3),
  ];

  const edgeNormals: [Vec3, Vec3, Vec3, Vec3] = [
    [0,0,0], [0,0,0], [0,0,0], [0,0,0],
  ];
  for (let i = 0; i < 4; i++) {
    // 변 방향과 평면 normal 의 외적 → 변에 수직이고 평면 안에 있는 벡터
    let n = vecNorm(vecCross(planeNormal, edgeDirs[i]));
    // 직사각형 중심을 기준으로 방향 보정 (안쪽 향하도록)
    const toCenter = vecSub(center, edges[i]);
    if (vecDot(n, toCenter) < 0) {
      n = [-n[0], -n[1], -n[2]];
    }
    edgeNormals[i] = n;
  }

  return {
    origin: P0,
    planeNormal,
    edgeNormals,
    edgeOrigins: edges,
  };
}

/** 점이 직사각형 (확장) 안에 있는지: 모든 변 평면에 대해 inward 측. */
function isInsideRect(point: Vec3, geom: RectGeom): boolean {
  for (let i = 0; i < 4; i++) {
    const d = vecDot(vecSub(point, geom.edgeOrigins[i]), geom.edgeNormals[i]);
    if (d < 0) return false;
  }
  return true;
}

/**
 * 가우시안의 한 방향 n 에 대한 3σ extent 계산.
 * Σ = R · diag(s²) · Rᵀ. n^T Σ n = sum_k (a_k · n)² · s_k².
 */
function extentAlong(
  n: Vec3,
  R00: number, R10: number, R20: number,  // a0
  R01: number, R11: number, R21: number,  // a1
  R02: number, R12: number, R22: number,  // a2
  s0: number, s1: number, s2: number,
): number {
  const a0n = R00*n[0] + R10*n[1] + R20*n[2];
  const a1n = R01*n[0] + R11*n[1] + R21*n[2];
  const a2n = R02*n[0] + R12*n[1] + R22*n[2];
  const variance = a0n*a0n*s0*s0 + a1n*a1n*s1*s1 + a2n*a2n*s2*s2;
  return 3 * Math.sqrt(variance);
}

/**
 * 직사각형 boundary 에 걸친 가우시안을 두 개로 분해.
 *
 * @param scene - 입력 가우시안 씬 (예: 회전 적용된 정제본 + door 영역만 추출 전).
 * @param rect - 4꼭짓점으로 정의된 직사각형 (사용자 클릭).
 * @returns 분해된 새 씬 + door/wall 인덱스.
 */
export function decomposeAtRectangle(
  scene: GaussianScene,
  rect: DoorRectangle,
): DecomposeResult {
  const geom = rectangleGeom(rect.corners);
  const N = scene.numSplats;

  const px = scene.attrs.get('x'); const py = scene.attrs.get('y'); const pz = scene.attrs.get('z');
  const r0 = scene.attrs.get('rot_0'); const r1 = scene.attrs.get('rot_1');
  const r2 = scene.attrs.get('rot_2'); const r3 = scene.attrs.get('rot_3');
  const sc0 = scene.attrs.get('scale_0'); const sc1 = scene.attrs.get('scale_1'); const sc2 = scene.attrs.get('scale_2');
  if (!px || !py || !pz || !r0 || !r1 || !r2 || !r3 || !sc0 || !sc1 || !sc2) {
    throw new Error('decomposeAtRectangle: required PLY attrs missing (x/y/z/rot_*/scale_*)');
  }

  // ── Pass 1: 분류 + boundary 메타 수집 ──
  type Status = 'door' | 'wall' | 'boundary';
  const status: Status[] = new Array(N);
  // boundary 케이스 메타: { axisIdx, edgeNormal, axisVec, axisScale (real, exp'd) }
  const boundaryMeta: Array<{
    edgeNormal: Vec3;
    axisVec: Vec3;
    axisIdx: number;
    realScale: number;
  } | null> = new Array(N).fill(null);

  for (let i = 0; i < N; i++) {
    const c: Vec3 = [px[i], py[i], pz[i]];

    // 쿼터니언 → 회전 행렬
    const qw0 = r0[i], qx0 = r1[i], qy0 = r2[i], qz0 = r3[i];
    const qLen = Math.hypot(qw0, qx0, qy0, qz0) || 1;
    const qw = qw0/qLen, qx = qx0/qLen, qy = qy0/qLen, qz = qz0/qLen;
    const xx = qx*qx, yy = qy*qy, zz = qz*qz;
    const xy = qx*qy, xz = qx*qz, yz = qy*qz;
    const wx = qw*qx, wy = qw*qy, wz = qw*qz;
    const R00 = 1 - 2*(yy+zz), R01 = 2*(xy-wz), R02 = 2*(xz+wy);
    const R10 = 2*(xy+wz),     R11 = 1 - 2*(xx+zz), R12 = 2*(yz-wx);
    const R20 = 2*(xz-wy),     R21 = 2*(yz+wx),     R22 = 1 - 2*(xx+yy);

    const s0 = Math.exp(sc0[i]), s1 = Math.exp(sc1[i]), s2 = Math.exp(sc2[i]);

    // 4 변 평면에 대한 sd + extent
    let allInside = true;
    let anyOutside = false;
    let mostBoundaryEdge = -1;
    let smallestAbsSd = Infinity;

    for (let e = 0; e < 4; e++) {
      const n = geom.edgeNormals[e];
      const o = geom.edgeOrigins[e];
      const sd = (c[0]-o[0])*n[0] + (c[1]-o[1])*n[1] + (c[2]-o[2])*n[2];
      const ext = extentAlong(n, R00, R10, R20, R01, R11, R21, R02, R12, R22, s0, s1, s2);

      if (sd > ext) {
        // 변 안쪽 (이 변 기준)
      } else if (sd < -ext) {
        // 변 바깥쪽 → 도어 영역에서 완전히 벗어남
        allInside = false;
        anyOutside = true;
        break;
      } else {
        // boundary on this edge
        allInside = false;
        if (Math.abs(sd) < smallestAbsSd) {
          smallestAbsSd = Math.abs(sd);
          mostBoundaryEdge = e;
        }
      }
    }

    if (allInside) {
      status[i] = 'door';
    } else if (anyOutside || mostBoundaryEdge < 0) {
      status[i] = 'wall';
    } else {
      // boundary case — 분해 준비
      status[i] = 'boundary';
      const eIdx = mostBoundaryEdge;
      const n_e = geom.edgeNormals[eIdx];

      // 가장 n_e 와 정렬된 주축 찾기 (variance contribution 기준)
      const a0n = R00*n_e[0] + R10*n_e[1] + R20*n_e[2];
      const a1n = R01*n_e[0] + R11*n_e[1] + R21*n_e[2];
      const a2n = R02*n_e[0] + R12*n_e[1] + R22*n_e[2];
      const c0 = a0n*a0n * s0*s0;
      const c1 = a1n*a1n * s1*s1;
      const c2 = a2n*a2n * s2*s2;
      let axisIdx = 0; let maxC = c0;
      if (c1 > maxC) { axisIdx = 1; maxC = c1; }
      if (c2 > maxC) { axisIdx = 2; maxC = c2; }

      const axisVec: Vec3 = axisIdx === 0
        ? [R00, R10, R20]
        : axisIdx === 1
        ? [R01, R11, R21]
        : [R02, R12, R22];
      const realScale = axisIdx === 0 ? s0 : axisIdx === 1 ? s1 : s2;

      boundaryMeta[i] = { edgeNormal: n_e, axisVec, axisIdx, realScale };
    }
  }

  // ── 출력 사이즈 = N + boundary 수 (각 boundary 가 1개 → 2개로) ──
  let numBoundary = 0;
  for (let i = 0; i < N; i++) if (status[i] === 'boundary') numBoundary++;
  const outN = N + numBoundary;

  // ── 출력 attrs 준비: 모든 propertyOrder 에 대해 새 Float32Array 할당 ──
  const outAttrs = new Map<string, Float32Array>();
  for (const prop of scene.propertyOrder) {
    if (scene.attrs.has(prop)) {
      outAttrs.set(prop, new Float32Array(outN));
    }
  }

  // ── Pass 2: 작성 (non-boundary 그대로 복사 / boundary 분해 후 2개 작성) ──
  const doorIndices: number[] = [];
  const wallIndices: number[] = [];
  let writeIdx = 0;

  for (let i = 0; i < N; i++) {
    const st = status[i];
    if (st !== 'boundary') {
      // 그대로 복사
      outAttrs.forEach((arr, prop) => {
        arr[writeIdx] = scene.attrs.get(prop)![i];
      });
      if (st === 'door') doorIndices.push(writeIdx);
      else wallIndices.push(writeIdx);
      writeIdx++;
    } else {
      // 분해
      const meta = boundaryMeta[i]!;
      const { axisVec, axisIdx, realScale } = meta;
      const halfScale = realScale / 2;
      const offset: Vec3 = [axisVec[0] * halfScale, axisVec[1] * halfScale, axisVec[2] * halfScale];

      // 두 sub-gaussian: g+, g- (axis 방향 +, -)
      for (let sub = 0; sub < 2; sub++) {
        const sign = sub === 0 ? 1 : -1;
        // 모든 prop 복사
        outAttrs.forEach((arr, prop) => {
          arr[writeIdx] = scene.attrs.get(prop)![i];
        });
        // 위치 갱신
        const newC: Vec3 = [
          px[i] + sign * offset[0],
          py[i] + sign * offset[1],
          pz[i] + sign * offset[2],
        ];
        outAttrs.get('x')![writeIdx] = newC[0];
        outAttrs.get('y')![writeIdx] = newC[1];
        outAttrs.get('z')![writeIdx] = newC[2];
        // scale 축소: log(s/2) = log(s) - log(2). 해당 axisIdx 만 축소.
        const scaleProp = `scale_${axisIdx}`;
        const origScale = scene.attrs.get(scaleProp)![i];
        outAttrs.get(scaleProp)![writeIdx] = origScale - Math.LN2;

        // 분류: 새 center 가 직사각형 안쪽인지 (변 4개 모두 inward 측)
        if (isInsideRect(newC, geom)) {
          doorIndices.push(writeIdx);
        } else {
          wallIndices.push(writeIdx);
        }
        writeIdx++;
      }
    }
  }

  if (writeIdx !== outN) {
    console.warn(`[doorDecompose] writeIdx mismatch: ${writeIdx} vs ${outN}`);
  }

  console.log(`[doorDecompose] N=${N}, boundary=${numBoundary}, outN=${outN}, door=${doorIndices.length}, wall=${wallIndices.length}`);

  return {
    scene: {
      numSplats: outN,
      propertyOrder: [...scene.propertyOrder],
      attrs: outAttrs,
    },
    doorIndices,
    wallIndices,
    numDecomposed: numBoundary,
  };
}
