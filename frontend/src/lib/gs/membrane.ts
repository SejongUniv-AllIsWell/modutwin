import type { GaussianScene } from '../ply/types';
import { surfacePlanesFromRoom } from './planes';
import { knnMedianGPU } from './membraneGPU';

const SH0 = 0.28209479177387814;
const WHITE_F_DC = (1.0 - 0.5) / SH0;
const EPS = 1e-8;

export interface MembraneRoomGeometry {
  angleDeg: number;
  walls: [number, number, number, number];
  ceilingY: number;
  floorY: number;
}

export interface MembraneOptions {
  gridSpacing: number;
  patchRadius: number;
  patchThickness: number;
  /** 선형 불투명도 0~1 (0: 투명, 1: 완전 불투명) */
  patchOpacity: number;
  /** 패치 색 스무딩 반복 횟수 (0 = off) */
  colorSmoothIters: number;
  /** 색 샘플링 시 패치 평면 ±이 거리(m) 안 가우시안만 KNN 후보로 사용. floater 배제용. */
  depthGate: number;
}

export const DEFAULT_MEMBRANE_OPTIONS: MembraneOptions = {
  gridSpacing: 0.04,
  patchRadius: 0.08,
  patchThickness: 0.002,
  patchOpacity: 0.25,
  colorSmoothIters: 2,
  depthGate: 0.05,
};

/** 패치 최대 개수 — 초과 시 gridSpacing 자동 확대 */
const MAX_PATCHES = 200_000;

/** 선형 불투명도 → sigmoid logit (3DGS opacity 필드는 pre-sigmoid). */
function opacityToLogit(a: number): number {
  const clamped = Math.max(1e-5, Math.min(1 - 1e-5, a));
  return Math.log(clamped / (1 - clamped));
}

/**
 * 슬라이더 값(=원하는 최종 벽 불투명도)을 패치 1개의 알파로 변환.
 * 3DGS 누적: final = 1 - (1-α)^N. 따라서 α = 1 - (1-slider)^(1/N).
 * 슬라이더 1.0은 항상 per-patch 1.0 (완전 불투명) 보장.
 */
function targetToPerPatchAlpha(targetAlpha: number, patchRadius: number, gridSpacing: number): number {
  if (targetAlpha >= 0.999) return 1 - 1e-5;
  if (targetAlpha <= 0.001) return 1e-5;
  const overlap = Math.max(1, Math.PI * (patchRadius / gridSpacing) * (patchRadius / gridSpacing));
  return 1 - Math.pow(1 - targetAlpha, 1 / overlap);
}

interface PatchInfo {
  x: number; y: number; z: number;
  // 색 샘플링용 위치 (벽 표면, off 미반영). 벽 가우시안에 가까워야 KNN이 동작.
  sx: number; sy: number; sz: number;
  nx: number; ny: number; nz: number;
  qw: number; qx: number; qy: number; qz: number;
}

/** 한 plane의 2D 격자 정보 (패치 색 스무딩용) */
interface PatchGroup {
  start: number;  // patches[] 내 이 plane의 첫 패치 인덱스
  ni: number;     // row 개수 (i 방향)
  nj: number;     // col 개수 (j 방향)
}

function quatFromZToNormal(nx: number, ny: number, nz: number): [number, number, number, number] {
  if (nz > 1 - EPS) return [1, 0, 0, 0];
  if (nz < -1 + EPS) return [0, 1, 0, 0];
  const len = Math.hypot(nx, ny) || 1;
  const ax = -ny / len, ay = nx / len;
  const c2 = Math.sqrt((1 + nz) / 2);
  const s2 = Math.sqrt((1 - nz) / 2);
  return [c2, s2 * ax, s2 * ay, 0];
}

// ── Spatial Grid ──────────────────────────────────────────────

class SpatialGrid {
  private cells = new Map<string, number[]>();
  constructor(private cs: number) {}

  insert(idx: number, x: number, y: number, z: number) {
    const k = `${Math.floor(x / this.cs)},${Math.floor(y / this.cs)},${Math.floor(z / this.cs)}`;
    let cell = this.cells.get(k);
    if (!cell) { cell = []; this.cells.set(k, cell); }
    cell.push(idx);
  }

  queryRadius(cx: number, cy: number, cz: number, r: number): number[] {
    const out: number[] = [];
    const cs = this.cs;
    const x0 = Math.floor((cx - r) / cs), x1 = Math.floor((cx + r) / cs);
    const y0 = Math.floor((cy - r) / cs), y1 = Math.floor((cy + r) / cs);
    const z0 = Math.floor((cz - r) / cs), z1 = Math.floor((cz + r) / cs);
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++)
        for (let iz = z0; iz <= z1; iz++) {
          const cell = this.cells.get(`${ix},${iy},${iz}`);
          if (cell) for (const idx of cell) out.push(idx);
        }
    return out;
  }
}

function buildGrid(scene: GaussianScene, cellSize: number): SpatialGrid {
  const px = scene.attrs.get('x')!, py = scene.attrs.get('y')!, pz = scene.attrs.get('z')!;
  const grid = new SpatialGrid(cellSize);
  for (let i = 0; i < scene.numSplats; i++) grid.insert(i, px[i], py[i], pz[i]);
  return grid;
}

// ── Patch geometry ───────────────────────────────────────────

function generatePatchPositions(
  surfaceIds: string[],
  room: MembraneRoomGeometry,
  surfaceOffsets: Record<string, number>,
  opts: MembraneOptions,
): { patches: PatchInfo[]; groups: PatchGroup[] } {
  const selected = new Set(surfaceIds);
  const allPlanes = surfacePlanesFromRoom(room);
  const rad = (room.angleDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const [a1, b1, a2, b2] = room.walls;
  const { ceilingY: cy, floorY: fy } = room;
  const gs = opts.gridSpacing;

  const ow1a = surfaceOffsets['w1a'] ?? 0, ow1b = surfaceOffsets['w1b'] ?? 0;
  const ow2a = surfaceOffsets['w2a'] ?? 0, ow2b = surfaceOffsets['w2b'] ?? 0;
  const oCeil = surfaceOffsets['ceiling'] ?? 0, oFloor = surfaceOffsets['floor'] ?? 0;
  const uLo = a1 - ow1a, uHi = b1 + ow1b;
  const vLo = a2 - ow2a, vHi = b2 + ow2b;
  const yLo = fy - oFloor, yHi = cy + oCeil;

  const patches: PatchInfo[] = [];
  const groups: PatchGroup[] = [];

  for (const plane of allPlanes) {
    if (!selected.has(plane.id)) continue;
    const [nx, ny, nz] = plane.normal;
    const q = quatFromZToNormal(nx, ny, nz);
    const off = surfaceOffsets[plane.id] ?? 0;
    const start = patches.length;

    if (plane.id === 'ceiling' || plane.id === 'floor') {
      const yBase = plane.id === 'ceiling' ? cy : fy;
      const yOut = yBase + off * ny;
      const nu = Math.max(1, Math.ceil((uHi - uLo) / gs));
      const nv = Math.max(1, Math.ceil((vHi - vLo) / gs));
      for (let i = 0; i <= nu; i++) {
        const u = uLo + (uHi - uLo) * (i / nu);
        for (let j = 0; j <= nv; j++) {
          const v = vLo + (vHi - vLo) * (j / nv);
          const px = c * u - s * v, pz = s * u + c * v;
          patches.push({
            x: px, y: yOut, z: pz,
            sx: px, sy: yBase, sz: pz,  // 색 샘플링은 벽 표면(yBase)에서
            nx, ny, nz, qw: q[0], qx: q[1], qy: q[2], qz: q[3],
          });
        }
      }
      groups.push({ start, ni: nu + 1, nj: nv + 1 });
    } else {
      let uFix: number | null = null, vFix: number | null = null;
      let tMin: number, tMax: number;
      if (plane.id === 'w1a')      { uFix = a1; tMin = vLo; tMax = vHi; }
      else if (plane.id === 'w1b') { uFix = b1; tMin = vLo; tMax = vHi; }
      else if (plane.id === 'w2a') { vFix = a2; tMin = uLo; tMax = uHi; }
      else if (plane.id === 'w2b') { vFix = b2; tMin = uLo; tMax = uHi; }
      else continue;

      const yN = Math.max(1, Math.ceil((yHi - yLo) / gs));
      const tN = Math.max(1, Math.ceil((tMax - tMin) / gs));
      for (let i = 0; i <= yN; i++) {
        const yV = yLo + (yHi - yLo) * (i / yN);
        for (let j = 0; j <= tN; j++) {
          const t = tMin + (tMax - tMin) * (j / tN);
          const uu = uFix !== null ? uFix : t;
          const vv = vFix !== null ? vFix : t;
          // 벽 표면 위치 (off 미반영) — 색 샘플링용
          const wallX = c * uu - s * vv;
          const wallY = yV;
          const wallZ = s * uu + c * vv;
          patches.push({
            x: wallX + off * nx,
            y: wallY + off * ny,
            z: wallZ + off * nz,
            sx: wallX, sy: wallY, sz: wallZ,
            nx, ny, nz, qw: q[0], qx: q[1], qy: q[2], qz: q[3],
          });
        }
      }
      groups.push({ start, ni: yN + 1, nj: tN + 1 });
    }
  }
  return { patches, groups };
}

// ── Color smoothing: plane별 2D separable Gaussian blur ──────
// KNN median이 패치마다 독립적이라 인접 색이 튀는 걸 격자 위에서 스무딩.
// [1,2,1]/4 세 탭 필터를 수평·수직 각 1회 = 1 iteration (≈ σ=0.7 격자).
// 기본 2회 → σ≈1.0, 격자 간격 2cm면 약 2cm 범위 보간.
function smoothPatchColors(
  colors: Float32Array,
  groups: PatchGroup[],
  iters: number,
): void {
  for (let it = 0; it < iters; it++) {
    for (const g of groups) {
      const { start, ni, nj } = g;
      const tmp = new Float32Array(ni * nj * 3);
      // 수평 (j 방향)
      for (let i = 0; i < ni; i++) {
        for (let j = 0; j < nj; j++) {
          let r = 0, gg = 0, b = 0, w = 0;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= nj) continue;
            const wt = dj === 0 ? 2 : 1;
            const src = (start + i * nj + jj) * 3;
            r += colors[src] * wt;
            gg += colors[src + 1] * wt;
            b += colors[src + 2] * wt;
            w += wt;
          }
          const dst = (i * nj + j) * 3;
          tmp[dst] = r / w; tmp[dst + 1] = gg / w; tmp[dst + 2] = b / w;
        }
      }
      // 수직 (i 방향) — colors로 덮어쓰기
      for (let i = 0; i < ni; i++) {
        for (let j = 0; j < nj; j++) {
          let r = 0, gg = 0, b = 0, w = 0;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= ni) continue;
            const wt = di === 0 ? 2 : 1;
            const src = (ii * nj + j) * 3;
            r += tmp[src] * wt;
            gg += tmp[src + 1] * wt;
            b += tmp[src + 2] * wt;
            w += wt;
          }
          const dst = (start + i * nj + j) * 3;
          colors[dst] = r / w; colors[dst + 1] = gg / w; colors[dst + 2] = b / w;
        }
      }
    }
  }
}

// ── Coloring: k-nearest median ──────────────────────────────

function colorByKnnMedian(
  patches: PatchInfo[],
  scene: GaussianScene,
  k = 8,
  searchR = 0.5,
  depthGate = 0.05,
): Float32Array {
  const grid = buildGrid(scene, searchR / 3);
  const sx = scene.attrs.get('x')!, sy = scene.attrs.get('y')!, sz = scene.attrs.get('z')!;
  const f0 = scene.attrs.get('f_dc_0')!, f1 = scene.attrs.get('f_dc_1')!, f2 = scene.attrs.get('f_dc_2')!;

  const N = patches.length;
  const colors = new Float32Array(N * 3);

  for (let p = 0; p < N; p++) {
    const patch = patches[p];
    // 색 샘플링은 벽 표면 위치(sx/sy/sz)에서 수행 — patch.x/y/z는 off만큼 밀려있음
    const cx = patch.sx, cy = patch.sy, cz = patch.sz;
    const { nx, ny, nz } = patch;
    const cands = grid.queryRadius(cx, cy, cz, searchR);

    const dists: { idx: number; d2: number }[] = [];
    for (const idx of cands) {
      const dx = sx[idx] - cx, dy = sy[idx] - cy, dz = sz[idx] - cz;
      // depth gate: 벽 표면 평면으로부터 수직 거리. floater 배제.
      const sd = dx * nx + dy * ny + dz * nz;
      if (sd > depthGate || sd < -depthGate) continue;
      dists.push({ idx, d2: dx * dx + dy * dy + dz * dz });
    }
    dists.sort((a, b) => a.d2 - b.d2);
    const nearest = dists.slice(0, k);

    if (nearest.length === 0) {
      colors[p * 3] = WHITE_F_DC;
      colors[p * 3 + 1] = WHITE_F_DC;
      colors[p * 3 + 2] = WHITE_F_DC;
      continue;
    }

    const v0 = nearest.map(n => f0[n.idx]).sort((a, b) => a - b);
    const v1 = nearest.map(n => f1[n.idx]).sort((a, b) => a - b);
    const v2 = nearest.map(n => f2[n.idx]).sort((a, b) => a - b);
    const mid = Math.floor(v0.length / 2);
    colors[p * 3]     = v0.length % 2 ? v0[mid] : (v0[mid - 1] + v0[mid]) / 2;
    colors[p * 3 + 1] = v1.length % 2 ? v1[mid] : (v1[mid - 1] + v1[mid]) / 2;
    colors[p * 3 + 2] = v2.length % 2 ? v2[mid] : (v2[mid - 1] + v2[mid]) / 2;
  }
  return colors;
}

// ── Scene builder ────────────────────────────────────────────

function buildMembraneScene(
  patches: PatchInfo[],
  patchColors: Float32Array,
  propertyOrder: string[],
  opts: MembraneOptions,
): GaussianScene {
  const N = patches.length;
  const attrs = new Map<string, Float32Array>();
  for (const p of propertyOrder) attrs.set(p, new Float32Array(N));

  const logR = Math.log(opts.patchRadius);
  const logT = Math.log(opts.patchThickness);
  // 슬라이더 = 원하는 최종 벽 불투명도. 중첩 N 만큼 보정해 per-patch 알파 계산.
  const perPatchAlpha = targetToPerPatchAlpha(opts.patchOpacity, opts.patchRadius, opts.gridSpacing);
  const opacityLogit = opacityToLogit(perPatchAlpha);
  const overlap = Math.PI * (opts.patchRadius / opts.gridSpacing) ** 2;
  console.log(`[Membrane] target wall α=${opts.patchOpacity}, overlap≈${overlap.toFixed(1)}, per-patch α=${perPatchAlpha.toFixed(4)}, logit=${opacityLogit.toFixed(3)}`);

  for (let i = 0; i < N; i++) {
    const p = patches[i];
    for (const prop of propertyOrder) {
      const arr = attrs.get(prop)!;
      switch (prop) {
        case 'x': arr[i] = p.x; break;
        case 'y': arr[i] = p.y; break;
        case 'z': arr[i] = p.z; break;
        case 'f_dc_0': arr[i] = patchColors[i * 3]; break;
        case 'f_dc_1': arr[i] = patchColors[i * 3 + 1]; break;
        case 'f_dc_2': arr[i] = patchColors[i * 3 + 2]; break;
        case 'opacity': arr[i] = opacityLogit; break;
        case 'scale_0': arr[i] = logR; break;
        case 'scale_1': arr[i] = logR; break;
        case 'scale_2': arr[i] = logT; break;
        case 'rot_0': arr[i] = p.qw; break;
        case 'rot_1': arr[i] = p.qx; break;
        case 'rot_2': arr[i] = p.qy; break;
        case 'rot_3': arr[i] = p.qz; break;
        default: arr[i] = 0;
      }
    }
  }
  return { numSplats: N, attrs, propertyOrder: [...propertyOrder] };
}

// ── Public API ───────────────────────────────────────────────

export async function generateMembrane(
  propertyOrder: string[],
  surfaceIds: string[],
  room: MembraneRoomGeometry,
  surfaceOffsets: Record<string, number>,
  sourceScene: GaussianScene,
  options: Partial<MembraneOptions> = {},
): Promise<GaussianScene> {
  const opts = { ...DEFAULT_MEMBRANE_OPTIONS, ...options };

  // 패치 수 초과 시 gridSpacing 자동 확대
  let result = generatePatchPositions(surfaceIds, room, surfaceOffsets, opts);
  while (result.patches.length > MAX_PATCHES) {
    opts.gridSpacing *= 1.5;
    console.warn(`[Membrane] ${result.patches.length} patches > ${MAX_PATCHES}, gridSpacing → ${opts.gridSpacing.toFixed(3)}`);
    result = generatePatchPositions(surfaceIds, room, surfaceOffsets, opts);
  }
  const { patches, groups } = result;

  const gpuResult = await knnMedianGPU(patches, sourceScene, 0.5, opts.depthGate);
  let patchColors: Float32Array;
  if (gpuResult) {
    patchColors = gpuResult;
  } else {
    console.log('[Membrane] WebGPU unavailable, falling back to CPU KNN');
    patchColors = colorByKnnMedian(patches, sourceScene, 8, 0.5, opts.depthGate);
  }
  if (opts.colorSmoothIters > 0) smoothPatchColors(patchColors, groups, opts.colorSmoothIters);

  return buildMembraneScene(patches, patchColors, propertyOrder, opts);
}
