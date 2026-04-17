/// <reference types="@webgpu/types" />
import type { GaussianScene } from '../ply/types';

const SH0 = 0.28209479177387814;
const WHITE_F_DC = (1.0 - 0.5) / SH0;

const KNN_WGSL = /* wgsl */ `
struct Params {
  cell_size: f32,
  search_r: f32,
  num_patches: u32,
  _pad0: u32,
  grid_min: vec4<f32>,
  grid_dim: vec4<u32>,
};

@group(0) @binding(0) var<storage, read> g_pos: array<f32>;
@group(0) @binding(1) var<storage, read> g_fdc: array<f32>;
@group(0) @binding(2) var<storage, read> p_pos: array<f32>;
@group(0) @binding(3) var<storage, read> cell_data: array<u32>;
@group(0) @binding(4) var<storage, read> sorted_idx: array<u32>;
@group(0) @binding(5) var<uniform> params: Params;
@group(0) @binding(6) var<storage, read_write> out_fdc: array<f32>;

const K = 8u;
const WHITE = 1.7724539;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pid = gid.x;
  if (pid >= params.num_patches) { return; }

  let px = p_pos[pid * 3u];
  let py = p_pos[pid * 3u + 1u];
  let pz = p_pos[pid * 3u + 2u];
  let sr2 = params.search_r * params.search_r;
  let cs = params.cell_size;
  let gmin = params.grid_min.xyz;
  let gdim = params.grid_dim.xyz;

  var kd: array<f32, 8>;
  var ki: array<u32, 8>;
  var kn: u32 = 0u;
  for (var i = 0u; i < K; i++) { kd[i] = 1e30; }

  let cx0 = max(0, i32(floor((px - params.search_r - gmin.x) / cs)));
  let cy0 = max(0, i32(floor((py - params.search_r - gmin.y) / cs)));
  let cz0 = max(0, i32(floor((pz - params.search_r - gmin.z) / cs)));
  let cx1 = min(i32(gdim.x) - 1, i32(floor((px + params.search_r - gmin.x) / cs)));
  let cy1 = min(i32(gdim.y) - 1, i32(floor((py + params.search_r - gmin.y) / cs)));
  let cz1 = min(i32(gdim.z) - 1, i32(floor((pz + params.search_r - gmin.z) / cs)));

  for (var ix = cx0; ix <= cx1; ix++) {
    for (var iy = cy0; iy <= cy1; iy++) {
      for (var iz = cz0; iz <= cz1; iz++) {
        let ci = u32(ix) + u32(iy) * gdim.x + u32(iz) * gdim.x * gdim.y;
        let cst = cell_data[ci * 2u];
        let ccn = cell_data[ci * 2u + 1u];
        for (var j = 0u; j < ccn; j++) {
          let gi = sorted_idx[cst + j];
          let dx = px - g_pos[gi * 3u];
          let dy = py - g_pos[gi * 3u + 1u];
          let dz = pz - g_pos[gi * 3u + 2u];
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= sr2 || d2 >= kd[K - 1u]) { continue; }
          var ins = K - 1u;
          for (var s = 0u; s < K; s++) { if (d2 < kd[s]) { ins = s; break; } }
          for (var s = K - 1u; s > ins; s--) { kd[s] = kd[s - 1u]; ki[s] = ki[s - 1u]; }
          kd[ins] = d2; ki[ins] = gi;
          kn = min(kn + 1u, K);
        }
      }
    }
  }

  if (kn == 0u) {
    out_fdc[pid * 3u] = WHITE; out_fdc[pid * 3u + 1u] = WHITE; out_fdc[pid * 3u + 2u] = WHITE;
    return;
  }

  let mid = kn / 2u;
  var v: array<f32, 8>;

  for (var ch = 0u; ch < 3u; ch++) {
    for (var i = 0u; i < kn; i++) { v[i] = g_fdc[ki[i] * 3u + ch]; }
    for (var i = 0u; i < kn; i++) {
      for (var j = i + 1u; j < kn; j++) {
        if (v[j] < v[i]) { let t = v[i]; v[i] = v[j]; v[j] = t; }
      }
    }
    if (kn % 2u == 1u) {
      out_fdc[pid * 3u + ch] = v[mid];
    } else {
      out_fdc[pid * 3u + ch] = (v[mid - 1u] + v[mid]) * 0.5;
    }
  }
}
`;

interface PatchPos { x: number; y: number; z: number }

let cachedDevice: GPUDevice | null = null;
let cachedPipeline: GPUComputePipeline | null = null;

async function getDevice(): Promise<GPUDevice | null> {
  if (cachedDevice) return cachedDevice;
  const gpu = (navigator as any).gpu as GPU | undefined;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  device.lost.then(() => { cachedDevice = null; cachedPipeline = null; });
  cachedDevice = device;
  return device;
}

async function getPipeline(device: GPUDevice): Promise<GPUComputePipeline> {
  if (cachedPipeline) return cachedPipeline;
  const module = device.createShaderModule({ code: KNN_WGSL });
  cachedPipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  return cachedPipeline;
}

function buildGrid(scene: GaussianScene, cellSize: number) {
  const px = scene.attrs.get('x')!, py = scene.attrs.get('y')!, pz = scene.attrs.get('z')!;
  const N = scene.numSplats;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < N; i++) {
    if (px[i] < minX) minX = px[i]; if (px[i] > maxX) maxX = px[i];
    if (py[i] < minY) minY = py[i]; if (py[i] > maxY) maxY = py[i];
    if (pz[i] < minZ) minZ = pz[i]; if (pz[i] > maxZ) maxZ = pz[i];
  }
  minX -= cellSize; minY -= cellSize; minZ -= cellSize;

  let dimX = Math.ceil((maxX - minX) / cellSize) + 1;
  let dimY = Math.ceil((maxY - minY) / cellSize) + 1;
  let dimZ = Math.ceil((maxZ - minZ) / cellSize) + 1;

  // 그리드가 너무 크면 셀 크기 확대
  const maxDim = 128;
  if (dimX > maxDim || dimY > maxDim || dimZ > maxDim) {
    const scale = Math.max(dimX, dimY, dimZ) / maxDim;
    const newCS = cellSize * scale;
    dimX = Math.ceil((maxX - minX) / newCS) + 1;
    dimY = Math.ceil((maxY - minY) / newCS) + 1;
    dimZ = Math.ceil((maxZ - minZ) / newCS) + 1;
    cellSize = newCS;
  }

  const totalCells = dimX * dimY * dimZ;
  const counts = new Uint32Array(totalCells);
  const cellOf = new Uint32Array(N);

  for (let i = 0; i < N; i++) {
    const cx = Math.floor((px[i] - minX) / cellSize);
    const cy = Math.floor((py[i] - minY) / cellSize);
    const cz = Math.floor((pz[i] - minZ) / cellSize);
    const ci = cx + cy * dimX + cz * dimX * dimY;
    cellOf[i] = ci;
    counts[ci]++;
  }

  const offsets = new Uint32Array(totalCells);
  for (let i = 1; i < totalCells; i++) offsets[i] = offsets[i - 1] + counts[i - 1];

  const sortedIdx = new Uint32Array(N);
  const writePos = new Uint32Array(offsets);
  for (let i = 0; i < N; i++) sortedIdx[writePos[cellOf[i]]++] = i;

  const cellData = new Uint32Array(totalCells * 2);
  for (let i = 0; i < totalCells; i++) {
    cellData[i * 2] = offsets[i];
    cellData[i * 2 + 1] = counts[i];
  }

  return { cellData, sortedIdx, minX, minY, minZ, dimX, dimY, dimZ, cellSize };
}

function makeBuf(device: GPUDevice, data: ArrayBuffer, usage: GPUBufferUsageFlags): GPUBuffer {
  const buf = device.createBuffer({ size: Math.max(4, data.byteLength), usage, mappedAtCreation: true });
  new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data));
  buf.unmap();
  return buf;
}

export async function knnMedianGPU(
  patches: PatchPos[],
  scene: GaussianScene,
  searchR = 0.5,
): Promise<Float32Array | null> {
  const device = await getDevice();
  if (!device) return null;

  const pipeline = await getPipeline(device);
  const N = scene.numSplats;
  const M = patches.length;
  if (M === 0) return new Float32Array(0);

  const t0 = performance.now();

  // Grid
  const grid = buildGrid(scene, searchR);

  // Pack positions & colors
  const px = scene.attrs.get('x')!, py = scene.attrs.get('y')!, pz = scene.attrs.get('z')!;
  const f0 = scene.attrs.get('f_dc_0')!, f1 = scene.attrs.get('f_dc_1')!, f2 = scene.attrs.get('f_dc_2')!;

  const gaussPos = new Float32Array(N * 3);
  const gaussFdc = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    gaussPos[i * 3] = px[i]; gaussPos[i * 3 + 1] = py[i]; gaussPos[i * 3 + 2] = pz[i];
    gaussFdc[i * 3] = f0[i]; gaussFdc[i * 3 + 1] = f1[i]; gaussFdc[i * 3 + 2] = f2[i];
  }

  const patchArr = new Float32Array(M * 3);
  for (let i = 0; i < M; i++) {
    patchArr[i * 3] = patches[i].x; patchArr[i * 3 + 1] = patches[i].y; patchArr[i * 3 + 2] = patches[i].z;
  }

  // Params uniform (48 bytes)
  const paramsBuf = new ArrayBuffer(48);
  const pf = new Float32Array(paramsBuf);
  const pu = new Uint32Array(paramsBuf);
  pf[0] = grid.cellSize; pf[1] = searchR; pu[2] = M; pu[3] = 0;
  pf[4] = grid.minX; pf[5] = grid.minY; pf[6] = grid.minZ; pf[7] = 0;
  pu[8] = grid.dimX; pu[9] = grid.dimY; pu[10] = grid.dimZ; pu[11] = 0;

  const S = GPUBufferUsage.STORAGE;
  const b0 = makeBuf(device, gaussPos.buffer, S);
  const b1 = makeBuf(device, gaussFdc.buffer, S);
  const b2 = makeBuf(device, patchArr.buffer, S);
  const b3 = makeBuf(device, grid.cellData.buffer, S);
  const b4 = makeBuf(device, grid.sortedIdx.buffer, S);
  const b5 = makeBuf(device, paramsBuf, GPUBufferUsage.UNIFORM);

  const outSize = M * 3 * 4;
  const b6 = device.createBuffer({ size: outSize, usage: S | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: b0 } },
      { binding: 1, resource: { buffer: b1 } },
      { binding: 2, resource: { buffer: b2 } },
      { binding: 3, resource: { buffer: b3 } },
      { binding: 4, resource: { buffer: b4 } },
      { binding: 5, resource: { buffer: b5 } },
      { binding: 6, resource: { buffer: b6 } },
    ],
  });

  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(M / 64));
  pass.end();
  enc.copyBufferToBuffer(b6, 0, readBuf, 0, outSize);
  device.queue.submit([enc.finish()]);

  await readBuf.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  [b0, b1, b2, b3, b4, b5, b6, readBuf].forEach(b => b.destroy());

  console.log(`[GPU KNN] ${M} patches, ${N} gaussians → ${(performance.now() - t0).toFixed(0)}ms`);
  return result;
}

export async function isWebGPUAvailable(): Promise<boolean> {
  const gpu = (navigator as any).gpu as GPU | undefined;
  if (!gpu) return false;
  const adapter = await gpu.requestAdapter();
  return adapter !== null;
}
