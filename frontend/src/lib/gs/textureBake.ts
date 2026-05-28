import type { GaussianScene } from '../ply/types';
import { compositeTextureGPU, type SplatGPU } from './textureBakeGPU';
import type { PolygonPoint, SurfacePlane } from './planes';
import { GSPLAT_SH0, gsplatKernelAlpha, gsplatVisibleSigmaRadius, sigmoidOpacity } from './playcanvasGsplat';

export type Vec3 = [number, number, number];

/**
 * 방 기하 — N벽 폴리곤 + 천장/바닥 Y.
 *
 * `surfacePlanes` 는 천장/바닥 + N벽 (`w0..w(N-1)`) 모두 포함된 SurfacePlane[].
 * 보통 `surfacePlanesFromPolygon` 결과 그대로 전달. wall ID `wi` ↔ polygon i번째 변 매칭.
 */
export interface RoomGeometry {
  surfacePlanes: SurfacePlane[];
  polygon: PolygonPoint[];
  ceilingY: number;
  floorY: number;
}

export interface TextureBakeOptions {
  /** 텍스처 해상도. 1m당 픽셀 수. 디폴트 512 (~2mm/px) */
  texelsPerMeter: number;
  /** 한 가우시안의 텍스처 footprint 픽셀 반경 한계. 너무 큰 가우시안(스카이/노이즈) 배제용 */
  maxFootprintPx: number;
  /**
   * 지정하면 단순 surface-normal depth(sd) 대신 대표 카메라 위치/방향 기준 depth 로 합성한다.
   * viewpoint 만 있으면 거리순, viewDirection 도 있으면 dot(center-viewpoint, viewDirection) 순.
   */
  viewpoint?: Vec3;
  viewDirection?: Vec3;
}

export const DEFAULT_TEXTURE_BAKE_OPTIONS: TextureBakeOptions = {
  texelsPerMeter: 512,
  // 저주파 벽/천장 색을 담당하는 큰 Gaussian 이 잘려나가면 coverage 와 색이 크게 틀어진다.
  // 기본값은 사실상 "안전장치" 수준으로만 두고, 필요 시 호출자가 낮춰 제한한다.
  maxFootprintPx: 4096,
};

export interface PlaneBakeInput {
  /** 샘플링 평면의 한 점 (보통 벽 표면 sd=0). 가우시안 sd는 이 origin 기준. */
  origin: Vec3;
  /** 평면 위 u축 (단위 벡터) */
  uAxis: Vec3;
  /** 평면 위 v축 (단위 벡터) */
  vAxis: Vec3;
  /** 평면 법선 (단위 벡터, 방 바깥) */
  normal: Vec3;
  /**
   * 베이크(샘플링) 범위.
   *
   * u/v 는 픽셀 좌표나 0..1 UV 가 아니라, origin + u*uAxis + v*vAxis 로
   * 3D 위치를 복원하는 평면 로컬 실제 거리 좌표다. 벽의 경우 보통
   * uMin=0, uMax=벽 실제 길이, vMin=0, vMax=천장-바닥 높이로 잡는다.
   *
   * 텍스처 픽셀 크기 = (uMax-uMin, vMax-vMin) * texelsPerMeter.
   * mesh UV 는 나중에 이 실제 거리 범위를 0..1 로 정규화해서 만든다.
   */
  uMin: number; uMax: number;
  vMin: number; vMax: number;
  /** 천장/바닥 한정 — 픽셀의 world XZ 가 이 polygon 외부면 alpha=0 처리.
   *  mesh quad 는 polygon bbox 직사각이지만 텍스처 알파로 polygon 모양 시각화.
   *  벽 surface 는 undefined (직사각 그대로). */
  polygonMaskXZ?: { x: number; z: number }[];
}

export interface TextureBakeResult {
  /** sRGB 인코딩된 RGBA8. 빈 텍셀은 alpha=0 */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** 같은 면을 여러 대표 시점에서 굽는 view-dependent texture variants. */
  viewVariants?: Array<{
    id: string;
    viewpoint: Vec3;
    rgba: Uint8ClampedArray;
  }>;
  /** 4 코너 (월드 좌표) — TL, TR, BR, BL 순서. extend* 적용 후 위치. */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** 각 코너의 UV (TL, TR, BR, BL). extend가 있으면 [0,1] 밖으로 나갈 수 있음 (clamp-to-edge). */
  uvs: [[number, number], [number, number], [number, number], [number, number]];
  input: PlaneBakeInput;
}

/**
 * point-in-polygon 테스트 (ray casting, XZ 평면).
 *
 * polygon 은 cycle 순서의 점 배열 (마지막→첫 점 자동 연결). polygon 변 위에 정확히 닿는 경계
 * 점은 ray casting 의 동률 보정상 일부는 inside, 일부는 outside 로 잡힐 수 있음 — 텍스처 마스크
 * 용도에서는 1픽셀 오차라 무방.
 */
function isPointInPolygonXZ(x: number, z: number, polygon: { x: number; z: number }[]): boolean {
  let inside = false;
  const N = polygon.length;
  for (let i = 0, j = N - 1; i < N; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    const intersect = ((zi > z) !== (zj > z)) &&
      (x < (xj - xi) * (z - zi) / (zj - zi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

interface SplatInfo {
  /** 픽셀 좌표계 가우시안 중심 */
  tu: number; tv: number;
  /** 픽셀 좌표계 2D inverse covariance (대칭) */
  inv00: number; inv01: number; inv11: number;
  /** 3-sigma 픽셀 footprint 반경 */
  bbR: number;
  /** 색 (linear 0..1) */
  r: number; g: number; b: number;
  /** 불투명도 (sigmoid 후, 0..1) */
  alpha: number;
  /** signed distance (origin 평면 기준). 정렬 key (ascending = 안쪽→바깥). */
  sd: number;
  /** 대표 시점 기준 거리 정렬 key. 작을수록 먼저 합성. */
  viewDepth: number;
}

/**
 * 한 평면의 텍스처를 가우시안 수직투영 + alpha 컴포지팅으로 굽는다.
 *
 * 경계 교차 샘플링:
 *   - 평면 바깥쪽 중심(sd >= 0) 가우시안은 채택
 *   - 평면 안쪽 중심(sd < 0) 가우시안은 렌더 가능한 extent 가 평면에 닿을 때만 채택
 *   - sd ascending (signed) 으로 정렬 → 안쪽에서 바깥으로 walk
 *   - 픽셀별로 T saturate(<1e-3) 시 break → wall paint 충분한 픽셀은 빨리 멈추고,
 *     sparse한 픽셀은 더 멀리까지 walk해서 coverage alpha 를 최대한 누적
 *
 * 알고리즘:
 *  1. 각 가우시안:
 *     - sd = (g - origin) · normal.
 *     - sd < 0 이고 normal 방향 render extent 가 평면에 닿지 않으면 스킵
 *     - 평면 좌표 (u, v) 계산
 *     - 2D 투영 covariance Σ₂ = J · Σ₃ · Jᵀ (anisotropic 그대로 보존)
 *     - 픽셀 footprint = PlayCanvas visible radius bbox (opacity 에 따라 0..√8σ)
 *  2. sd ascending 정렬 (signed)
 *  3. 각 가우시안을 footprint 픽셀에 splat:
 *     PlayCanvas gsplat fragment 와 같은 커널:
 *     `q = dᵀ Σ₂⁻¹ d`
 *     `profile = (exp(-0.5q) - exp(-4)) / (1 - exp(-4))`, q <= 8
 *     `α_g = opacity · profile`, α_g >= 1/255
 *     `rgb_acc += T · α_g · color; T *= (1 - α_g); break if T < 1e-3`
 *  4. 최종: alpha = 1 - T, rgb = rgb_acc / alpha (un-premultiply)
 *
 * 색 공간:
 * PlayCanvas uncompressed gsplat 은 `f_dc*C0+0.5` 를 gamma color 로 `splatColor` 에 저장하고,
 * 기본 출력도 그 gamma color 를 사용한다. 따라서 여기서 linear→sRGB 변환을 추가로 걸지 않는다.
 */
export async function bakeTextureForPlane(
  input: PlaneBakeInput,
  scene: GaussianScene,
  options: Partial<TextureBakeOptions> = {},
): Promise<TextureBakeResult> {
  const opts = { ...DEFAULT_TEXTURE_BAKE_OPTIONS, ...options };

  const uW = input.uMax - input.uMin;
  const vH = input.vMax - input.vMin;
  if (uW <= 0 || vH <= 0) throw new Error('bakeTextureForPlane: empty bounds');

  const width = Math.max(1, Math.ceil(uW * opts.texelsPerMeter));
  const height = Math.max(1, Math.ceil(vH * opts.texelsPerMeter));

  const px = scene.attrs.get('x');
  const py = scene.attrs.get('y');
  const pz = scene.attrs.get('z');
  const f0 = scene.attrs.get('f_dc_0');
  const f1 = scene.attrs.get('f_dc_1');
  const f2 = scene.attrs.get('f_dc_2');
  const op = scene.attrs.get('opacity');
  const r0 = scene.attrs.get('rot_0');
  const r1 = scene.attrs.get('rot_1');
  const r2 = scene.attrs.get('rot_2');
  const r3 = scene.attrs.get('rot_3');
  const sc0 = scene.attrs.get('scale_0');
  const sc1 = scene.attrs.get('scale_1');
  const sc2 = scene.attrs.get('scale_2');
  if (!px || !py || !pz || !f0 || !f1 || !f2 || !op || !r0 || !r1 || !r2 || !r3 || !sc0 || !sc1 || !sc2) {
    throw new Error('bakeTextureForPlane: required attrs missing (x,y,z,f_dc_0..2,opacity,rot_0..3,scale_0..2)');
  }

  const [ox, oy, oz] = input.origin;
  const [ux, uy, uz] = input.uAxis;
  const [vx, vy, vz] = input.vAxis;
  const [nx, ny, nz] = input.normal;
  const tpm = opts.texelsPerMeter;
  const tpm2 = tpm * tpm;
  const maxBB = opts.maxFootprintPx;
  const N = scene.numSplats;

  // ── 단계 1: 필터 + 투영 + 2D covariance ──
  const splats: SplatInfo[] = [];

  for (let i = 0; i < N; i++) {
    const dx = px[i] - ox, dy = py[i] - oy, dz = pz[i] - oz;
    const sd = dx * nx + dy * ny + dz * nz;

    // 쿼터니언 정규화 + 회전 행렬
    const qw0 = r0[i], qx0 = r1[i], qy0 = r2[i], qz0 = r3[i];
    const qLen = Math.hypot(qw0, qx0, qy0, qz0) || 1;
    const qw = qw0 / qLen, qx = qx0 / qLen, qy = qy0 / qLen, qz = qz0 / qLen;
    const xx = qx * qx, yy = qy * qy, zz = qz * qz;
    const xy = qx * qy, xz = qx * qz, yz = qy * qz;
    const wx = qw * qx, wy = qw * qy, wz = qw * qz;
    const R00 = 1 - 2 * (yy + zz), R01 = 2 * (xy - wz), R02 = 2 * (xz + wy);
    const R10 = 2 * (xy + wz),     R11 = 1 - 2 * (xx + zz), R12 = 2 * (yz - wx);
    const R20 = 2 * (xz - wy),     R21 = 2 * (yz + wx),     R22 = 1 - 2 * (xx + yy);

    // 스케일 (log → exp). Σ₃ = R · diag(s²) · Rᵀ
    const s0 = Math.exp(sc0[i]), s1 = Math.exp(sc1[i]), s2 = Math.exp(sc2[i]);
    const ss00 = s0 * s0, ss11 = s1 * s1, ss22 = s2 * s2;
    const alpha = sigmoidOpacity(op[i]);
    const visibleSigma = gsplatVisibleSigmaRadius(alpha);
    if (visibleSigma <= 0) continue;

    // 중심이 평면 안쪽(sd < 0)에 있더라도 Gaussian의 렌더 가능한 normal 방향 extent 가
    // 평면을 가로지르면 bake 대상이다. PlayCanvas gsplat fragment 의 alpha cutoff 까지 반영한다.
    const anX = R00 * nx + R10 * ny + R20 * nz;
    const anY = R01 * nx + R11 * ny + R21 * nz;
    const anZ = R02 * nx + R12 * ny + R22 * nz;
    const sigmaN = Math.sqrt(anX * anX * ss00 + anY * anY * ss11 + anZ * anZ * ss22);
    if (sd < 0 && sd + visibleSigma * sigmaN < 0) continue;

    const u = dx * ux + dy * uy + dz * uz;
    const v = dx * vx + dy * vy + dz * vz;

    // a_u = Rᵀ · uAxis, a_v = Rᵀ · vAxis (각 3-vector). Σ₂ = a^T · diag(s²) · a 형태.
    const auX = R00 * ux + R10 * uy + R20 * uz;
    const auY = R01 * ux + R11 * uy + R21 * uz;
    const auZ = R02 * ux + R12 * uy + R22 * uz;
    const avX = R00 * vx + R10 * vy + R20 * vz;
    const avY = R01 * vx + R11 * vy + R21 * vz;
    const avZ = R02 * vx + R12 * vy + R22 * vz;

    // Σ₂ in meters
    const c00 = auX * auX * ss00 + auY * auY * ss11 + auZ * auZ * ss22;
    const c01 = auX * avX * ss00 + auY * avY * ss11 + auZ * avZ * ss22;
    const c11 = avX * avX * ss00 + avY * avY * ss11 + avZ * avZ * ss22;

    // 픽셀 좌표계로 변환 (variance × tpm²)
    const p00 = c00 * tpm2;
    const p01 = c01 * tpm2;
    const p11 = c11 * tpm2;

    const det = p00 * p11 - p01 * p01;
    if (det < 1e-10) continue; // degenerate

    const inv00 = p11 / det;
    const inv01 = -p01 / det;
    const inv11 = p00 / det;

    // PlayCanvas fragment 에서 실제 보이는 radius 기준 bbox (opacity 에 따라 0..sqrt(8)σ).
    const sigU = Math.sqrt(p00);
    const sigV = Math.sqrt(p11);
    const bbR = visibleSigma * Math.max(sigU, sigV);
    if (bbR > maxBB) continue; // 너무 큰 가우시안 (스카이 등)
    if (bbR < 0.3) continue;  // 너무 작은 가우시안

    // 픽셀 좌표계 중심.
    // u/v 는 평면 로컬 실제 거리 좌표이고, texelsPerMeter 를 곱해 texel 좌표로 변환한다.
    const tu = (u - input.uMin) * tpm;
    const tv = (v - input.vMin) * tpm;
    if (tu < -bbR || tu > width + bbR) continue;
    if (tv < -bbR || tv > height + bbR) continue;

    const r = Math.max(0, Math.min(1, 0.5 + GSPLAT_SH0 * f0[i]));
    const g = Math.max(0, Math.min(1, 0.5 + GSPLAT_SH0 * f1[i]));
    const b = Math.max(0, Math.min(1, 0.5 + GSPLAT_SH0 * f2[i]));

    let viewDepth = sd;
    if (opts.viewpoint && opts.viewDirection) {
      viewDepth =
        (px[i] - opts.viewpoint[0]) * opts.viewDirection[0] +
        (py[i] - opts.viewpoint[1]) * opts.viewDirection[1] +
        (pz[i] - opts.viewpoint[2]) * opts.viewDirection[2];
    } else if (opts.viewpoint) {
      viewDepth = Math.hypot(px[i] - opts.viewpoint[0], py[i] - opts.viewpoint[1], pz[i] - opts.viewpoint[2]);
    }

    splats.push({ tu, tv, inv00, inv01, inv11, bbR, r, g, b, alpha, sd, viewDepth });
  }

  // ── 단계 2: front-to-back 정렬 ──
  // 기본은 plane normal 기준(sd ascending), viewpoint 가 있으면 대표 시점에서 가까운 순.
  splats.sort((a, b) => a.viewDepth - b.viewDepth);

  // ── 단계 2.5: 타일 인덱스 자료구조 빌드 ──
  // 각 splat 의 footprint(bbR) 가 닿는 16×16 픽셀 타일들에 등록.
  // sd 정렬 순서로 등록하므로 각 타일의 splat 리스트도 자동으로 sd 정렬됨.
  // 셰이더는 픽셀 별로 자기 타일의 리스트만 순회 → O(splats per tile) per pixel.
  const TILE = 16;
  const tilesPerRow = Math.ceil(width / TILE);
  const tilesPerCol = Math.ceil(height / TILE);
  const numTiles = tilesPerRow * tilesPerCol;

  // Pass 1: count entries per tile
  const tileCounts = new Uint32Array(numTiles);
  for (let i = 0; i < splats.length; i++) {
    const sp = splats[i];
    const xMin = Math.max(0, Math.floor((sp.tu - sp.bbR) / TILE));
    const xMax = Math.min(tilesPerRow - 1, Math.floor((sp.tu + sp.bbR) / TILE));
    const yMin = Math.max(0, Math.floor((sp.tv - sp.bbR) / TILE));
    const yMax = Math.min(tilesPerCol - 1, Math.floor((sp.tv + sp.bbR) / TILE));
    if (xMin > xMax || yMin > yMax) continue;
    for (let ty = yMin; ty <= yMax; ty++) {
      const rowBase = ty * tilesPerRow;
      for (let tx = xMin; tx <= xMax; tx++) {
        tileCounts[rowBase + tx]++;
      }
    }
  }

  // Prefix sum → tileOffsets (length numTiles+1)
  const tileOffsets = new Uint32Array(numTiles + 1);
  let acc = 0;
  for (let t = 0; t < numTiles; t++) {
    tileOffsets[t] = acc;
    acc += tileCounts[t];
  }
  tileOffsets[numTiles] = acc;
  const totalEntries = acc;

  // Pass 2: scatter splat indices in sd-sorted order
  const tileSplatList = new Uint32Array(totalEntries);
  const writeOffsets = new Uint32Array(tileOffsets); // copy (size N+1, but we use only [0..N))
  for (let i = 0; i < splats.length; i++) {
    const sp = splats[i];
    const xMin = Math.max(0, Math.floor((sp.tu - sp.bbR) / TILE));
    const xMax = Math.min(tilesPerRow - 1, Math.floor((sp.tu + sp.bbR) / TILE));
    const yMin = Math.max(0, Math.floor((sp.tv - sp.bbR) / TILE));
    const yMax = Math.min(tilesPerCol - 1, Math.floor((sp.tv + sp.bbR) / TILE));
    if (xMin > xMax || yMin > yMax) continue;
    for (let ty = yMin; ty <= yMax; ty++) {
      const rowBase = ty * tilesPerRow;
      for (let tx = xMin; tx <= xMax; tx++) {
        const tile = rowBase + tx;
        tileSplatList[writeOffsets[tile]++] = i;
      }
    }
  }

  // ── 단계 3: alpha compositing — GPU 우선, CPU 폴백 ──
  // 둘 다 결과: width*height*4 의 Float32Array [r_premult, g_premult, b_premult, alpha]
  let composited: Float32Array | null = null;
  const splatsForGPU: SplatGPU[] = splats.map(s => ({
    tu: s.tu, tv: s.tv,
    inv00: s.inv00, inv01: s.inv01, inv11: s.inv11,
    bbR: s.bbR,
    r: s.r, g: s.g, b: s.b,
    alpha: s.alpha,
  }));
  try {
    composited = await compositeTextureGPU(splatsForGPU, width, height, tileOffsets, tileSplatList);
  } catch (e) {
    console.warn('[textureBake] GPU compositing failed, falling back to CPU:', e);
    composited = null;
  }

  if (!composited) {
    // CPU 폴백
    composited = new Float32Array(width * height * 4);
    const T = new Float32Array(width * height);
    T.fill(1.0);

    for (const sp of splats) {
      const u0 = Math.max(0, Math.floor(sp.tu - sp.bbR));
      const u1 = Math.min(width - 1, Math.ceil(sp.tu + sp.bbR));
      const v0 = Math.max(0, Math.floor(sp.tv - sp.bbR));
      const v1 = Math.min(height - 1, Math.ceil(sp.tv + sp.bbR));
      if (u0 > u1 || v0 > v1) continue;

      for (let yy = v0; yy <= v1; yy++) {
        const rowBase = yy * width;
        for (let xx = u0; xx <= u1; xx++) {
          const du = xx + 0.5 - sp.tu;
          const dv = yy + 0.5 - sp.tv;
          const q = du * du * sp.inv00 + 2 * du * dv * sp.inv01 + dv * dv * sp.inv11;
          const ag = gsplatKernelAlpha(sp.alpha, q);
          if (ag <= 0) continue;

          const idx = rowBase + xx;
          const t = T[idx];
          if (t < 1e-3) continue;

          const w = t * ag;
          const o = idx * 4;
          composited[o]     += w * sp.r;
          composited[o + 1] += w * sp.g;
          composited[o + 2] += w * sp.b;
          T[idx] = t * (1 - ag);
        }
      }
    }
    // alpha = 1 - T 채우기
    for (let i = 0; i < width * height; i++) {
      composited[i * 4 + 3] = 1 - T[i];
    }
  }

  // ── 단계 4: 최종 RGBA8 (un-premultiply + V flip + polygon/cutout mask) ──
  // composited alpha 는 색을 un-premultiply 하기 위한 coverage 신뢰도로만 사용한다.
  // wall mesh PNG 의 alpha 채널은 렌더링 투명도가 아니라 cutout mask 이므로,
  // 유효 texel 은 255, polygon 외부/coverage 없음은 0 으로 저장한다.
  // polygon mask (ceiling/floor 한정): 픽셀의 world XZ 가 polygon 외부면 alpha=0.
  // 픽셀 (xx, yy) → 베이크 (u_local, v_local) = ((xx+0.5)/tpm, (yy+0.5)/tpm)
  //   → world: origin + u_local * uAxis + v_local * vAxis. y 성분은 평면에 의존하므로 무시 (XZ test).
  const mask = input.polygonMaskXZ;
  const useMask = !!mask && mask.length >= 3;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      const srcIdx = (yy * width + xx) * 4;
      const finalAlpha = composited[srcIdx + 3];
      const imgRow = height - 1 - yy; // V 뒤집기
      const imgIdx = (imgRow * width + xx) * 4;

      let alphaPass = finalAlpha > 1e-3;
      if (alphaPass && useMask) {
        // textureBake 좌표계 — input.uMin/vMin 은 0 또는 음수일 수 있음.
        // 픽셀 중심: (xx+0.5)/tpm + uMin = ... 이건 splat sampling 식과 일치.
        const uLocal = input.uMin + (xx + 0.5) / tpm;
        const vLocal = input.vMin + (yy + 0.5) / tpm;
        const worldX = ox + uLocal * ux + vLocal * vx;
        const worldZ = oz + uLocal * uz + vLocal * vz;
        if (!isPointInPolygonXZ(worldX, worldZ, mask!)) {
          alphaPass = false;
        }
      }

      if (alphaPass) {
        const r = Math.max(0, Math.min(1, composited[srcIdx]     / finalAlpha));
        const g = Math.max(0, Math.min(1, composited[srcIdx + 1] / finalAlpha));
        const b = Math.max(0, Math.min(1, composited[srcIdx + 2] / finalAlpha));
        rgba[imgIdx]     = Math.round(r * 255);
        rgba[imgIdx + 1] = Math.round(g * 255);
        rgba[imgIdx + 2] = Math.round(b * 255);
        rgba[imgIdx + 3] = 255;
      } else {
        rgba[imgIdx] = 0;
        rgba[imgIdx + 1] = 0;
        rgba[imgIdx + 2] = 0;
        rgba[imgIdx + 3] = 0;
      }
    }
  }
  // 메시 코너 = 베이크 origin 위치 (사용자가 정의한 경계 평면, sd=0) 에 정확히 배치.
  const corner = (uu: number, vv: number): Vec3 => [
    ox + uu * ux + vv * vx,
    oy + uu * uy + vv * vy,
    oz + uu * uz + vv * vz,
  ];
  const corners: [Vec3, Vec3, Vec3, Vec3] = [
    corner(input.uMin, input.vMax),  // TL
    corner(input.uMax, input.vMax),  // TR
    corner(input.uMax, input.vMin),  // BR
    corner(input.uMin, input.vMin),  // BL
  ];

  // UV 매핑: 평면 로컬 실제 거리 범위 [uMin, uMax] × [vMin, vMax] 를
  // 텍스처 [0,1] 범위로 정규화한다.
  // 이미지 row 0 = vMax (V flip 적용했으므로). 따라서 UV v = (vMax - world_v) / (vMax - vMin).
  const uvOf = (uu: number, vv: number): [number, number] => [
    (uu - input.uMin) / uW,
    (input.vMax - vv) / vH,
  ];
  const uvs: [[number, number], [number, number], [number, number], [number, number]] = [
    uvOf(input.uMin, input.vMax),  // TL
    uvOf(input.uMax, input.vMax),  // TR
    uvOf(input.uMax, input.vMin),  // BR
    uvOf(input.uMin, input.vMin),  // BL
  ];

  return { rgba, width, height, corners, uvs, input };
}

/**
 * 방 기하 + 면 ID → PlaneBakeInput.
 *
 * - 샘플 평면(origin) = **벽 표면 sd=0**. 벽 paint 가우시안을 그대로 샘플.
 * - 메시는 `bakeTextureForPlane` 에서 origin 위치(사용자 경계면, sd=0) 에 정확히 배치.
 *
 * N벽 일반화:
 *   - wall surfaceId `wi` → 폴리곤 i 번째 변 (`polygon[i]` → `polygon[(i+1)%N]`).
 *   - 변 방향이 uAxis, Y축이 vAxis.
 *   - 벽은 평면 로컬 실제 거리 범위를 u=0..벽 길이, v=0..천장-바닥 높이로 둔다.
 *   - ceiling/floor: 폴리곤 XZ bbox 로 직사각 quad. polygon 외부 픽셀은 빈 텍셀 (alpha=0).
 *
 * 좌표 규약은 planes.ts와 동일 (raw PLY 프레임).
 */
export function planeBakeInputForSurface(
  surfaceId: string,
  room: RoomGeometry,
): PlaneBakeInput {
  const { polygon, ceilingY: cy, floorY: fy, surfacePlanes } = room;
  const N = polygon.length;

  if (surfaceId === 'ceiling' || surfaceId === 'floor') {
    // 폴리곤 XZ bbox.
    let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
    for (const p of polygon) {
      if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
      if (p.z < mnZ) mnZ = p.z; if (p.z > mxZ) mxZ = p.z;
    }
    const plane = surfacePlanes.find(p => p.id === surfaceId);
    const normal: Vec3 = plane
      ? [plane.normal[0], plane.normal[1], plane.normal[2]]
      : (surfaceId === 'ceiling' ? [0, 1, 0] : [0, -1, 0]);
    const yLevel = surfaceId === 'ceiling' ? cy : fy;
    return {
      origin: [mnX, yLevel, mnZ],
      uAxis: [1, 0, 0],
      vAxis: [0, 0, 1],
      normal,
      uMin: 0, uMax: mxX - mnX,
      vMin: 0, vMax: mxZ - mnZ,
      // polygon 외부 픽셀 alpha=0 — quad 는 bbox 직사각, 텍스처 알파로 polygon 모양 시각화.
      polygonMaskXZ: polygon.map(p => ({ x: p.x, z: p.z })),
    };
  }

  const m = /^w(\d+)$/.exec(surfaceId);
  if (!m) throw new Error(`planeBakeInputForSurface: unknown surfaceId "${surfaceId}"`);
  const i = parseInt(m[1], 10);
  if (i < 0 || i >= N) throw new Error(`planeBakeInputForSurface: wall index ${i} out of range (N=${N})`);

  const a = polygon[i];
  const b = polygon[(i + 1) % N];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) throw new Error(`planeBakeInputForSurface: degenerate edge "${surfaceId}"`);

  const plane = surfacePlanes.find(p => p.id === surfaceId);
  if (!plane) throw new Error(`planeBakeInputForSurface: SurfacePlane "${surfaceId}" not in surfacePlanes`);
  const normal: Vec3 = [plane.normal[0], plane.normal[1], plane.normal[2]];

  // uAxis = 변 방향 (a→b 정규화). vAxis = Y up.
  // origin = 벽 시작점 a 의 바닥 위치. 즉 벽 평면 로컬 좌표 (u=0, v=0) 의 3D 위치.
  // bakeTextureForPlane 안의 V flip 으로 vMax 가 텍스처 row 0 (이미지 상단) 이 됨.
  const uAxis: Vec3 = [dx / len, 0, dz / len];
  const vAxis: Vec3 = [0, 1, 0];
  return {
    origin: [a.x, fy, a.z],
    uAxis,
    vAxis,
    normal,
    // u/v 범위는 실제 거리 단위다. 여기서 len 은 실제 3D 벽 길이이며,
    // texelsPerMeter 를 곱해 텍스처 픽셀 폭으로 변환된다.
    uMin: 0, uMax: len,
    vMin: 0, vMax: cy - fy,
  };
}
