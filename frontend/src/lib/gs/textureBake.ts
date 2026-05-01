import type { GaussianScene } from '../ply/types';
import { compositeTextureGPU, type SplatGPU } from './textureBakeGPU';

const SH0 = 0.28209479177387814;

export type Vec3 = [number, number, number];

/** 방 기하 — 벽4 거리, 회전각, 천장/바닥 Y. */
export interface RoomGeometry {
  angleDeg: number;
  walls: [number, number, number, number];  // a1, b1, a2, b2
  ceilingY: number;
  floorY: number;
}

export interface TextureBakeOptions {
  /** 텍스처 해상도. 1m당 픽셀 수. 디폴트 512 (~2mm/px) */
  texelsPerMeter: number;
  /** 샘플 평면(origin) ±이 거리 안 가우시안만 채택 (m) */
  depthGate: number;
  /** 한 가우시안의 텍스처 footprint 픽셀 반경 한계. 너무 큰 가우시안(스카이/노이즈) 배제용 */
  maxFootprintPx: number;
  /** 자동 게이트 산정 시 paint peak 안쪽으로 추가로 더 보는 거리 (m).
   *  실제 dgateEff = max(depthGate, |paintSd 음수 부분| + autoMargin).
   *  너무 작으면 paint peak 가까이만 채택 → 빈 텍셀, 너무 크면 occluder 가구 가 합성 → 어두워짐. */
  autoMargin: number;
}

export const DEFAULT_TEXTURE_BAKE_OPTIONS: TextureBakeOptions = {
  texelsPerMeter: 512,
  // 안쪽 마진 — 벽면에서 방 쪽으로 이만큼 안쪽까지만 가우시안 채택 (페인트 살짝 새는 것만 허용).
  // 너무 크면 벽 앞의 occluder (TV, 조명, 가구) 가 sd ascending sort 에서 먼저 컴포지팅 → 어두워짐.
  depthGate: 0.005,
  maxFootprintPx: 500,
  autoMargin: 0.05,
};

/**
 * 텍스처 메시(quad)를 방 경계 평면(sd=0) 으로부터 법선 방향(=방 바깥쪽) 으로 얼마나 들여놓을지 (m).
 *
 * 0 = 사용자가 모달에서 정의한 경계면 위치에 정확히 막 배치 (사용자 요청).
 * 막 위치 + 텍스처 베이크 시작 위치가 모두 사용자 경계면(sd=0) 에 정렬됨 → "층 두 개" 잔상 최소화.
 * 메시 배치 위치(`bakeTextureForPlane` 안의 `meshOffsetEff`)와 코너 extend (`planeBakeInputForSurface`
 * 의 `extend*`) 가 모두 이 단일 상수에서 파생되므로 항상 동기화.
 */
export const MESH_PLANE_INSET = 0;

export interface PlaneBakeInput {
  /** 샘플링 평면의 한 점 (보통 벽 표면 sd=0). 가우시안 sd는 이 origin 기준. */
  origin: Vec3;
  /** 평면 위 u축 (단위 벡터) */
  uAxis: Vec3;
  /** 평면 위 v축 (단위 벡터) */
  vAxis: Vec3;
  /** 평면 법선 (단위 벡터, 방 바깥) */
  normal: Vec3;
  /** 베이크(샘플링) 범위 — 텍스처 컨텐츠가 차지하는 (u, v) 영역. 원래 방 범위. */
  uMin: number; uMax: number;
  vMin: number; vMax: number;
  /** 메시 quad는 베이크 범위보다 양쪽으로 이만큼 더 뻗는다 (m).
   *  텍스처 자체는 늘어나지 않고, UV가 [0,1] 밖으로 나가 clamp-to-edge로 가장자리 픽셀이
   *  복제됨 (replicate padding). 인접 면과 만나도록 직육면체 코너 닫는 용도. */
  extendU0: number; extendU1: number;
  extendV0: number; extendV1: number;
  /** 메시 quad를 origin 으로부터 normal 방향으로 얼마나 떨어진 곳에 배치할지 (m). */
  meshOffset: number;
}

export interface TextureBakeResult {
  /** sRGB 인코딩된 RGBA8. 빈 텍셀은 alpha=0 */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** 4 코너 (월드 좌표) — TL, TR, BR, BL 순서. extend* 적용 후 위치. */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** 각 코너의 UV (TL, TR, BR, BL). extend가 있으면 [0,1] 밖으로 나갈 수 있음 (clamp-to-edge). */
  uvs: [[number, number], [number, number], [number, number], [number, number]];
  input: PlaneBakeInput;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function linToSrgb(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * 평면 위의 paint plane 위치를 자동 검출.
 * sd = 0 부근 ±searchRangeM 범위에서 opacity 가중 sd 히스토그램의 peak 를 찾음.
 *
 * 메시 코너 정합용: 각 면 베이크 전에 미리 호출해서 모든 인접 면의 paintSd 를 알아야
 * extend 거리를 정확히 잡을 수 있음.
 */
export function detectPaintSd(
  origin: Vec3,
  normal: Vec3,
  scene: GaussianScene,
  searchRangeM = 0.5,
): number {
  const px = scene.attrs.get('x');
  const py = scene.attrs.get('y');
  const pz = scene.attrs.get('z');
  const op = scene.attrs.get('opacity');
  if (!px || !py || !pz || !op) throw new Error('detectPaintSd: required attrs missing');

  const [ox, oy, oz] = origin;
  const [nx, ny, nz] = normal;
  const N = scene.numSplats;

  const HIST_BINS = 400;
  const HIST_RANGE = 2.0;
  const HIST_RES = (2 * HIST_RANGE) / HIST_BINS;
  const wHist = new Float32Array(HIST_BINS);
  for (let i = 0; i < N; i++) {
    const dx = px[i] - ox, dy = py[i] - oy, dz = pz[i] - oz;
    const sd = dx * nx + dy * ny + dz * nz;
    const bin = Math.floor((sd + HIST_RANGE) / HIST_RES);
    if (bin >= 0 && bin < HIST_BINS) {
      wHist[bin] += sigmoid(op[i]);
    }
  }

  const centerBin = Math.floor(HIST_RANGE / HIST_RES);
  const halfSearch = Math.floor(searchRangeM / HIST_RES);
  let peakBin = centerBin;
  let peakW = -1;
  for (let b = Math.max(0, centerBin - halfSearch); b <= Math.min(HIST_BINS - 1, centerBin + halfSearch); b++) {
    if (wHist[b] > peakW) { peakW = wHist[b]; peakBin = b; }
  }
  return (peakBin + 0.5) * HIST_RES - HIST_RANGE;
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
}

/**
 * 한 평면의 텍스처를 가우시안 수직투영 + alpha 컴포지팅으로 굽는다.
 *
 * 적응형 깊이 샘플링 (Adaptive depth):
 *   - 안쪽 경계: sd ≥ -depthGate (방 쪽 occluder 배제)
 *   - 바깥쪽 경계: 없음 (벽 안쪽 깊이 / 다른 방 / 벽 너머까지 모두 채택)
 *   - sd ascending (signed) 으로 정렬 → 안쪽에서 바깥으로 walk
 *   - 픽셀별로 T saturate(<1e-3) 시 break → wall paint 충분한 픽셀은 빨리 멈추고,
 *     sparse한 픽셀만 더 멀리까지 walk해서 alpha=1 채움
 *
 * 알고리즘:
 *  1. 각 가우시안:
 *     - sd = (g - origin) · normal. sd < -depthGate 이면 스킵
 *     - 평면 좌표 (u, v) 계산
 *     - 2D 투영 covariance Σ₂ = J · Σ₃ · Jᵀ (anisotropic 그대로 보존)
 *     - 픽셀 footprint = 3σ bbox
 *  2. sd ascending 정렬 (signed)
 *  3. 각 가우시안을 footprint 픽셀에 splat:
 *     `α_g = opacity · exp(-0.5 · dᵀ Σ₂⁻¹ d)`
 *     `rgb_acc += T · α_g · color; T *= (1 - α_g); break if T < 1e-3`
 *  4. 최종: alpha = 1 - T, rgb = rgb_acc / alpha (un-premultiply)
 */
export async function bakeTextureForPlane(
  input: PlaneBakeInput,
  scene: GaussianScene,
  options: Partial<TextureBakeOptions> = {},
): Promise<TextureBakeResult> {
  const opts = { ...DEFAULT_TEXTURE_BAKE_OPTIONS, ...options };
  console.log(`[bakeTextureForPlane] ENTER — received options=${JSON.stringify(options)}, merged opts=${JSON.stringify(opts)}`);

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
  const dgate = opts.depthGate;
  const maxBB = opts.maxFootprintPx;
  const N = scene.numSplats;

  // ── 단계 1: 필터 + 투영 + 2D covariance ──
  const splats: SplatInfo[] = [];
  let candCount = 0;
  // 진단 카운터
  let rejSdInner = 0;     // sd < -dgate (방 안쪽 너무 깊음)
  let rejDet = 0;         // 2D 공분산 degenerate
  let rejBigBB = 0;       // bbR > maxBB (스카이/노이즈)
  let rejTinyBB = 0;      // bbR < 0.3 (너무 작음)
  let rejOutOfRange = 0;  // 큰 텍스처에서 픽셀 범위 밖

  // ── 사전 패스: opacity-가중 sd 히스토그램으로 paint plane 자동 검출 ──
  //  - 1cm 빈, ±2m 범위 (200 + 200 = 400 빈)
  //  - 빈마다 sigmoid(opacity) 합산 — opacity 높은 가우시안일수록 가중
  //  - sd=0 부근 ±50cm 에서 peak 찾기 → 거기가 실제 paint plane
  //  - 자동 게이트 = max(slider, |peak sd| + 5cm 마진) 으로 paint 포함 보장
  // 부수: 진단용 통계도 같이 계산.
  const HIST_BINS = 400;
  const HIST_RANGE = 2.0;
  const HIST_RES = (2 * HIST_RANGE) / HIST_BINS; // 0.01 m
  const wHist = new Float32Array(HIST_BINS);
  let sdMin = Infinity, sdMax = -Infinity, sdSum = 0;
  const sdHist = new Int32Array(40); // 진단용 10cm 빈 (±2m)
  for (let i = 0; i < N; i++) {
    const dx = px[i] - ox, dy = py[i] - oy, dz = pz[i] - oz;
    const sd0 = dx * nx + dy * ny + dz * nz;
    if (sd0 < sdMin) sdMin = sd0;
    if (sd0 > sdMax) sdMax = sd0;
    sdSum += sd0;
    // 10cm 빈 (진단용)
    const dbin = Math.floor((sd0 + 2) / 0.1);
    if (dbin >= 0 && dbin < 40) sdHist[dbin]++;
    // 1cm 빈 (auto-gate 용, opacity 가중)
    const fbin = Math.floor((sd0 + HIST_RANGE) / HIST_RES);
    if (fbin >= 0 && fbin < HIST_BINS) {
      const w = sigmoid(op[i]);
      wHist[fbin] += w;
    }
  }
  const sdMean = sdSum / Math.max(1, N);

  // sd=0 ±50cm 범위에서 paint peak 검출
  const SEARCH_RANGE = 0.5;
  const centerBin = Math.floor(HIST_RANGE / HIST_RES);
  const halfSearch = Math.floor(SEARCH_RANGE / HIST_RES);
  let peakBin = centerBin;
  let peakW = -1;
  for (let b = Math.max(0, centerBin - halfSearch); b <= Math.min(HIST_BINS - 1, centerBin + halfSearch); b++) {
    if (wHist[b] > peakW) { peakW = wHist[b]; peakBin = b; }
  }
  const paintSd = (peakBin + 0.5) * HIST_RES - HIST_RANGE;
  // 자동 게이트 — paint peak 가 음수면 그만큼 안쪽까지 허용 + autoMargin.
  // autoMargin = 0 이면 자동 확장 비활성화 → 사용자가 설정한 경계면(depthGate)을 그대로 사용 (strict mode).
  const autoMargin = opts.autoMargin;
  const autoGate = autoMargin > 0
    ? Math.max(opts.depthGate, -Math.min(0, paintSd) + autoMargin)
    : opts.depthGate;
  console.log(`[textureBake] paint peak: sd=${paintSd.toFixed(3)}m (weight=${peakW.toFixed(0)}) → autoGate=${autoGate.toFixed(3)}m (slider=${opts.depthGate.toFixed(3)}m, autoMargin=${autoMargin.toFixed(3)}m), mesh placed at sd=${MESH_PLANE_INSET.toFixed(3)}m (fixed)`);
  const dgateEff = autoGate;

  for (let i = 0; i < N; i++) {
    const dx = px[i] - ox, dy = py[i] - oy, dz = pz[i] - oz;
    const sd = dx * nx + dy * ny + dz * nz;
    // 적응형 깊이: 안쪽 경계만 차단, 바깥쪽은 무한대까지 허용. 픽셀별 T saturate 로 자동 종료.
    // dgateEff = max(슬라이더, paint peak 안쪽 + 5cm). 자동 검출이라 사용자 입력 0.5cm 도 OK.
    if (sd < -dgateEff) { rejSdInner++; continue; }
    const u = dx * ux + dy * uy + dz * uz;
    const v = dx * vx + dy * vy + dz * vz;
    candCount++;

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
    if (det < 1e-10) { rejDet++; continue; } // degenerate

    const inv00 = p11 / det;
    const inv01 = -p01 / det;
    const inv11 = p00 / det;

    // 3σ bounding box (보수적, 이방성 포함)
    const sigU = Math.sqrt(p00);
    const sigV = Math.sqrt(p11);
    const bbR = 3 * Math.max(sigU, sigV);
    if (bbR > maxBB) { rejBigBB++; continue; } // 너무 큰 가우시안 (스카이 등)
    if (bbR < 0.3) { rejTinyBB++; continue; }  // 너무 작은 가우시안

    // 픽셀 좌표계 중심
    const tu = (u - input.uMin) * tpm;
    const tv = (v - input.vMin) * tpm;
    if (tu < -bbR || tu > width + bbR) { rejOutOfRange++; continue; }
    if (tv < -bbR || tv > height + bbR) { rejOutOfRange++; continue; }

    const r = Math.max(0, Math.min(1, 0.5 + SH0 * f0[i]));
    const g = Math.max(0, Math.min(1, 0.5 + SH0 * f1[i]));
    const b = Math.max(0, Math.min(1, 0.5 + SH0 * f2[i]));
    const alpha = sigmoid(op[i]);

    splats.push({ tu, tv, inv00, inv01, inv11, bbR, r, g, b, alpha, sd });
  }

  // ── 단계 2: sd ascending 정렬 (signed) — 안쪽에서 바깥쪽 순 ──
  splats.sort((a, b) => a.sd - b.sd);

  // ── 단계 2.5: 타일 인덱스 자료구조 빌드 ──
  // 각 splat 의 footprint(bbR) 가 닿는 16×16 픽셀 타일들에 등록.
  // sd 정렬 순서로 등록하므로 각 타일의 splat 리스트도 자동으로 sd 정렬됨.
  // 셰이더는 픽셀 별로 자기 타일의 리스트만 순회 → O(splats per tile) per pixel.
  const TILE = 16;
  const tilesPerRow = Math.ceil(width / TILE);
  const tilesPerCol = Math.ceil(height / TILE);
  const numTiles = tilesPerRow * tilesPerCol;

  const tBinStart = performance.now();

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

  let maxTileCount = 0;
  for (let t = 0; t < numTiles; t++) if (tileCounts[t] > maxTileCount) maxTileCount = tileCounts[t];
  console.log(`[textureBake] tile binning: ${numTiles} tiles (${tilesPerRow}×${tilesPerCol}), ${totalEntries} entries (avg ${(totalEntries / Math.max(1, numTiles)).toFixed(1)}/tile, max ${maxTileCount}/tile) → ${(performance.now() - tBinStart).toFixed(0)}ms`);

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
    const tCpuStart = performance.now();
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
          const exponent = -0.5 * (du * du * sp.inv00 + 2 * du * dv * sp.inv01 + dv * dv * sp.inv11);
          if (exponent < -6) continue;
          const ag = sp.alpha * Math.exp(exponent);
          if (ag < 1e-3) continue;

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
    console.log(`[textureBake CPU] ${(performance.now() - tCpuStart).toFixed(0)}ms`);
  }

  // ── 단계 4: 최종 RGBA8 (un-premultiply + sRGB encode + V flip) ──
  const rgba = new Uint8ClampedArray(width * height * 4);
  let nOpaque = 0;
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      const srcIdx = (yy * width + xx) * 4;
      const finalAlpha = composited[srcIdx + 3];
      const imgRow = height - 1 - yy; // V 뒤집기
      const imgIdx = (imgRow * width + xx) * 4;
      if (finalAlpha > 1e-3) {
        const r = composited[srcIdx]     / finalAlpha;
        const g = composited[srcIdx + 1] / finalAlpha;
        const b = composited[srcIdx + 2] / finalAlpha;
        rgba[imgIdx]     = Math.round(linToSrgb(r) * 255);
        rgba[imgIdx + 1] = Math.round(linToSrgb(g) * 255);
        rgba[imgIdx + 2] = Math.round(linToSrgb(b) * 255);
        rgba[imgIdx + 3] = Math.round(finalAlpha * 255);
        nOpaque++;
      } else {
        rgba[imgIdx] = 0;
        rgba[imgIdx + 1] = 0;
        rgba[imgIdx + 2] = 0;
        rgba[imgIdx + 3] = 0;
      }
    }
  }

  // ── 코너: 메시는 베이크 범위보다 extend* 만큼 더 뻗음. ──
  // 메시 위치는 방 경계 평면(sd=0) 에서 법선 방향(=방 바깥) 으로 MESH_PLANE_INSET (1mm) 들여놓음.
  // paintSd 와 무관 → 6면 모두 동일한 오프셋을 가지므로, 인접 면도 같은 1mm 오프셋으로 extend
  // 하면 직육면체 코너에서 메시들이 정확히 만남. (paintSd 는 autoGate 산정용으로만 사용.)
  const meshOffsetEff = MESH_PLANE_INSET;
  const mox = ox + meshOffsetEff * nx;
  const moy = oy + meshOffsetEff * ny;
  const moz = oz + meshOffsetEff * nz;
  const meshUMin = input.uMin - input.extendU0;
  const meshUMax = input.uMax + input.extendU1;
  const meshVMin = input.vMin - input.extendV0;
  const meshVMax = input.vMax + input.extendV1;

  const corner = (uu: number, vv: number): Vec3 => [
    mox + uu * ux + vv * vx,
    moy + uu * uy + vv * vy,
    moz + uu * uz + vv * vz,
  ];
  const corners: [Vec3, Vec3, Vec3, Vec3] = [
    corner(meshUMin, meshVMax),  // TL
    corner(meshUMax, meshVMax),  // TR
    corner(meshUMax, meshVMin),  // BR
    corner(meshUMin, meshVMin),  // BL
  ];

  // UV 매핑: 텍스처 [0,1] 범위가 베이크 범위 [uMin, uMax] × [vMin, vMax] 에 대응.
  // 메시 코너가 베이크 범위 밖이면 UV도 [0,1] 밖으로 나감 → clamp-to-edge로 가장자리 픽셀 복제.
  // 이미지 row 0 = vMax (V flip 적용했으므로). 따라서 UV v = (vMax - world_v) / (vMax - vMin).
  const uvOf = (uu: number, vv: number): [number, number] => [
    (uu - input.uMin) / uW,
    (input.vMax - vv) / vH,
  ];
  const uvs: [[number, number], [number, number], [number, number], [number, number]] = [
    uvOf(meshUMin, meshVMax),  // TL
    uvOf(meshUMax, meshVMax),  // TR
    uvOf(meshUMax, meshVMin),  // BR
    uvOf(meshUMin, meshVMin),  // BL
  ];

  const tag = `[textureBake]`;
  console.log(`${tag} ${width}×${height}, candidates ${candCount}, splats ${splats.length}, opaque texels ${nOpaque}/${width * height} (${(100 * nOpaque / (width * height)).toFixed(1)}%)`);
  console.log(`${tag} sd dist: min=${sdMin.toFixed(3)} max=${sdMax.toFixed(3)} mean=${sdMean.toFixed(3)} (m), dgateEff=-${dgateEff.toFixed(3)} (slider=${dgate.toFixed(3)}, autoGate=${autoGate.toFixed(3)})`);
  console.log(`${tag} reject: sdInner=${rejSdInner} (sd<-dgate), det=${rejDet}, bigBB=${rejBigBB}, tinyBB=${rejTinyBB}, outRange=${rejOutOfRange}`);
  // sd 히스토그램 — -2..+2m, 10cm 빈. paint peak 위치 확인용.
  const histLines: string[] = [];
  for (let i = 0; i < 40; i++) {
    if (sdHist[i] > 0) {
      const lo = (-2 + i * 0.1).toFixed(2);
      const hi = (-2 + (i + 1) * 0.1).toFixed(2);
      histLines.push(`  [${lo}..${hi}] = ${sdHist[i]}`);
    }
  }
  console.log(`${tag} sd histogram (10cm bins, only nonzero):\n${histLines.join('\n')}`);

  return { rgba, width, height, corners, uvs, input };
}

/**
 * 방 기하 + 면 ID → PlaneBakeInput.
 *
 * - 샘플 평면(origin) = **벽 표면 sd=0**. 벽 paint 가우시안을 그대로 샘플.
 * - 메시는 `bakeTextureForPlane` 에서 항상 `MESH_PLANE_INSET` (1mm) 위치에 배치.
 * - (u, v) 범위는 인접 면의 메시 오프셋 (= MESH_PLANE_INSET) 만큼 양쪽 확장 → 직육면체 코너에서
 *   메시들이 정확히 만남. 본 면의 메시 오프셋과 인접 면의 extend 가 같은 상수에서 파생되므로 항상 동기화.
 *
 * 좌표 규약은 planes.ts와 동일 (raw PLY 프레임).
 */
export function planeBakeInputForSurface(
  surfaceId: string,
  room: RoomGeometry,
): PlaneBakeInput {
  const rad = (room.angleDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const [a1, b1, a2, b2] = room.walls;
  const { ceilingY: cy, floorY: fy } = room;

  // 모든 면의 메시 오프셋이 동일 (MESH_PLANE_INSET) → 인접 면 extend 도 그대로 이 값.
  // 본 면의 메시는 bakeTextureForPlane 안에서 `meshOffsetEff = MESH_PLANE_INSET` 으로 배치되므로,
  // 여기서 같은 상수를 extend* 에 쓰면 직육면체 6면이 정확히 만남.
  const offSelf = MESH_PLANE_INSET;
  const oCeil = MESH_PLANE_INSET;
  const oFloor = MESH_PLANE_INSET;
  const oW1a = MESH_PLANE_INSET;
  const oW1b = MESH_PLANE_INSET;
  const oW2a = MESH_PLANE_INSET;
  const oW2b = MESH_PLANE_INSET;

  // 베이크 범위는 원래 방 범위 그대로. 메시는 인접 offset 만큼 extend (replicate padding).
  switch (surfaceId) {
    case 'ceiling': {
      const normal: Vec3 = [0, 1, 0];
      return {
        origin: [c * a1 - s * a2, cy, s * a1 + c * a2],
        uAxis: [c, 0, s],
        vAxis: [-s, 0, c],
        normal,
        uMin: 0, uMax: b1 - a1, vMin: 0, vMax: b2 - a2,
        extendU0: oW1a, extendU1: oW1b,
        extendV0: oW2a, extendV1: oW2b,
        meshOffset: offSelf,
      };
    }
    case 'floor': {
      const normal: Vec3 = [0, -1, 0];
      return {
        origin: [c * a1 - s * a2, fy, s * a1 + c * a2],
        uAxis: [c, 0, s],
        vAxis: [-s, 0, c],
        normal,
        uMin: 0, uMax: b1 - a1, vMin: 0, vMax: b2 - a2,
        extendU0: oW1a, extendU1: oW1b,
        extendV0: oW2a, extendV1: oW2b,
        meshOffset: offSelf,
      };
    }
    case 'w1a': {
      const normal: Vec3 = [-c, 0, -s];
      return {
        origin: [c * a1 - s * a2, fy, s * a1 + c * a2],
        uAxis: [-s, 0, c],
        vAxis: [0, 1, 0],
        normal,
        uMin: 0, uMax: b2 - a2, vMin: 0, vMax: cy - fy,
        extendU0: oW2a, extendU1: oW2b,
        extendV0: oFloor, extendV1: oCeil,
        meshOffset: offSelf,
      };
    }
    case 'w1b': {
      const normal: Vec3 = [c, 0, s];
      return {
        origin: [c * b1 - s * a2, fy, s * b1 + c * a2],
        uAxis: [-s, 0, c],
        vAxis: [0, 1, 0],
        normal,
        uMin: 0, uMax: b2 - a2, vMin: 0, vMax: cy - fy,
        extendU0: oW2a, extendU1: oW2b,
        extendV0: oFloor, extendV1: oCeil,
        meshOffset: offSelf,
      };
    }
    case 'w2a': {
      const normal: Vec3 = [s, 0, -c];
      return {
        origin: [c * a1 - s * a2, fy, s * a1 + c * a2],
        uAxis: [c, 0, s],
        vAxis: [0, 1, 0],
        normal,
        uMin: 0, uMax: b1 - a1, vMin: 0, vMax: cy - fy,
        extendU0: oW1a, extendU1: oW1b,
        extendV0: oFloor, extendV1: oCeil,
        meshOffset: offSelf,
      };
    }
    case 'w2b': {
      const normal: Vec3 = [-s, 0, c];
      return {
        origin: [c * a1 - s * b2, fy, s * a1 + c * b2],
        uAxis: [c, 0, s],
        vAxis: [0, 1, 0],
        normal,
        uMin: 0, uMax: b1 - a1, vMin: 0, vMax: cy - fy,
        extendU0: oW1a, extendU1: oW1b,
        extendV0: oFloor, extendV1: oCeil,
        meshOffset: offSelf,
      };
    }
    default:
      throw new Error(`planeBakeInputForSurface: unknown surfaceId "${surfaceId}"`);
  }
}
