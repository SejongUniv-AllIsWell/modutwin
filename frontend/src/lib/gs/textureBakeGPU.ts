/// <reference types="@webgpu/types" />

const TILE_SIZE = 16;

const SHADER = /* wgsl */ `
const GSPLAT_Q_CUTOFF: f32 = 8.0;
const GSPLAT_EDGE_EXP: f32 = exp(-4.0);
const GSPLAT_INV_EDGE_NORM: f32 = 1.0 / (1.0 - GSPLAT_EDGE_EXP);
const GSPLAT_ALPHA_CUTOFF: f32 = 1.0 / 255.0;

struct Params {
  width: u32,
  height: u32,
  tilesPerRow: u32,
  _pad: u32,
};

struct Splat {
  tu: f32,
  tv: f32,
  inv00: f32,
  inv01: f32,
  inv11: f32,
  bbR: f32,
  r: f32,
  g: f32,
  b: f32,
  alpha: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<storage, read> splats: array<Splat>;
@group(0) @binding(1) var<storage, read_write> outRGBA: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(4) var<storage, read> tileSplatList: array<u32>;

// 타일 기반 binning 셰이더.
// 각 픽셀이 자기 타일의 splat 리스트만 순회 (사전에 CPU 에서 각 splat 이 영향 줄 타일에
// 등록해둠). sd ascending 순서로 등록되었으므로 리스트 순회만으로 알파 컴포지팅 순서 보존.
// workgroup_size = TILE_SIZE × TILE_SIZE (16×16=256 threads) → 한 workgroup 의 모든 픽셀이
// 같은 타일에 속해서 tileOffsets, tileSplatList 캐시 효율 최대.
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let px = gid.x;
  let py = gid.y;
  if (px >= params.width || py >= params.height) { return; }

  let tileX = px / 16u;
  let tileY = py / 16u;
  let tileIdx = tileY * params.tilesPerRow + tileX;
  let start = tileOffsets[tileIdx];
  let end = tileOffsets[tileIdx + 1u];

  let pxF = f32(px) + 0.5;
  let pyF = f32(py) + 0.5;

  var T: f32 = 1.0;
  var rgb = vec3<f32>(0.0, 0.0, 0.0);

  for (var i: u32 = start; i < end; i = i + 1u) {
    let splatIdx = tileSplatList[i];
    let sp = splats[splatIdx];
    let du = pxF - sp.tu;
    let dv = pyF - sp.tv;
    if (abs(du) > sp.bbR || abs(dv) > sp.bbR) { continue; }
    let q = du * du * sp.inv00 + 2.0 * du * dv * sp.inv01 + dv * dv * sp.inv11;
    if (q > GSPLAT_Q_CUTOFF) { continue; }
    let profile = (exp(-0.5 * q) - GSPLAT_EDGE_EXP) * GSPLAT_INV_EDGE_NORM;
    let ag = sp.alpha * profile;
    if (ag < GSPLAT_ALPHA_CUTOFF) { continue; }
    let w = T * ag;
    rgb = rgb + w * vec3<f32>(sp.r, sp.g, sp.b);
    T = T * (1.0 - ag);
    if (T < 0.001) { break; }
  }

  outRGBA[py * params.width + px] = vec4<f32>(rgb, 1.0 - T);
}
`;

export interface SplatGPU {
  tu: number; tv: number;
  inv00: number; inv01: number; inv11: number;
  bbR: number;
  r: number; g: number; b: number;
  alpha: number;
}

let cachedDevice: GPUDevice | null = null;
let cachedPipeline: GPUComputePipeline | null = null;

async function getDevice(): Promise<GPUDevice | null> {
  if (cachedDevice) return cachedDevice;
  const gpu = (navigator as any).gpu as GPU | undefined;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;
  const adapterLimits = adapter.limits;
  const requiredLimits: Record<string, number> = {};
  if (adapterLimits.maxStorageBufferBindingSize > 0) {
    requiredLimits.maxStorageBufferBindingSize = adapterLimits.maxStorageBufferBindingSize;
  }
  if (adapterLimits.maxBufferSize > 0) {
    requiredLimits.maxBufferSize = adapterLimits.maxBufferSize;
  }
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ requiredLimits });
  } catch (e) {
    console.warn('[textureBakeGPU] requestDevice with raised limits failed, falling back to defaults:', e);
    device = await adapter.requestDevice();
  }
  device.lost.then((info) => {
    console.error('[textureBakeGPU] device lost:', info);
    cachedDevice = null;
    cachedPipeline = null;
  });
  cachedDevice = device;
  return device;
}

async function getPipeline(device: GPUDevice): Promise<GPUComputePipeline> {
  if (cachedPipeline) return cachedPipeline;
  const module = device.createShaderModule({ code: SHADER });
  cachedPipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  return cachedPipeline;
}

function makeBuf(device: GPUDevice, data: ArrayBuffer, usage: GPUBufferUsageFlags): GPUBuffer {
  const buf = device.createBuffer({ size: Math.max(4, data.byteLength), usage, mappedAtCreation: true });
  new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data));
  buf.unmap();
  return buf;
}

/**
 * 타일 기반 binning 으로 width×height 텍스처에 alpha compositing.
 * @param splats - sd ascending 정렬된 splat 배열
 * @param width, height - 텍스처 크기
 * @param tileOffsets - 길이 (numTiles+1) prefix-sum
 * @param tileSplatList - flat splat 인덱스 리스트, 타일별 그룹화 + sd 순서 보존
 *
 * 반환값: width*height*4 의 Float32 (PlayCanvas gsplat gamma RGB premultiplied + alpha).
 * GPU 미지원 / 한계 초과 / 에러 시 null 반환 → 호출자가 CPU fallback.
 */
export async function compositeTextureGPU(
  splats: SplatGPU[],
  width: number,
  height: number,
  tileOffsets: Uint32Array,
  tileSplatList: Uint32Array,
): Promise<Float32Array | null> {
  const device = await getDevice();
  if (!device) return null;

  const pipeline = await getPipeline(device);
  const M = splats.length;
  const totalPixels = width * height;
  if (totalPixels === 0) return new Float32Array(0);

  const tilesPerRow = Math.ceil(width / TILE_SIZE);
  const tilesPerCol = Math.ceil(height / TILE_SIZE);
  const numTiles = tilesPerRow * tilesPerCol;
  if (tileOffsets.length !== numTiles + 1) {
    throw new Error(`compositeTextureGPU: tileOffsets length ${tileOffsets.length} != numTiles+1 ${numTiles + 1}`);
  }

  // Pack splats: 12 floats per splat (48 bytes, vec4 aligned)
  const splatArr = new Float32Array(Math.max(12, M * 12));
  for (let i = 0; i < M; i++) {
    const sp = splats[i];
    const o = i * 12;
    splatArr[o]      = sp.tu;
    splatArr[o + 1]  = sp.tv;
    splatArr[o + 2]  = sp.inv00;
    splatArr[o + 3]  = sp.inv01;
    splatArr[o + 4]  = sp.inv11;
    splatArr[o + 5]  = sp.bbR;
    splatArr[o + 6]  = sp.r;
    splatArr[o + 7]  = sp.g;
    splatArr[o + 8]  = sp.b;
    splatArr[o + 9]  = sp.alpha;
  }

  const outSize = totalPixels * 4 * 4; // f32 RGBA per pixel
  const splatBytes = splatArr.byteLength;
  const tileOffsetsBytes = tileOffsets.byteLength;
  const tileListBytes = Math.max(4, tileSplatList.byteLength);

  // 한계 사전 체크
  const maxStorage = device.limits.maxStorageBufferBindingSize;
  if (outSize > maxStorage || splatBytes > maxStorage || tileOffsetsBytes > maxStorage || tileListBytes > maxStorage) {
    console.warn(`[textureBakeGPU] buffer size exceeds device limit. Falling back to CPU.`);
    return null;
  }

  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');

  const S = GPUBufferUsage.STORAGE;
  const splatGpu = makeBuf(device, splatArr.buffer, S);
  const outGpu = device.createBuffer({ size: outSize, usage: S | GPUBufferUsage.COPY_SRC });
  const paramsGpu = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const readBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  // typed array → ArrayBuffer (Uint32Array.buffer 가 SharedArrayBuffer 일 수도 있어서 새 ArrayBuffer 로 복사).
  const tileOffsetsAB = new ArrayBuffer(tileOffsets.byteLength);
  new Uint32Array(tileOffsetsAB).set(tileOffsets);
  const tileOffsetsGpu = makeBuf(device, tileOffsetsAB, S);
  // tileSplatList 가 비어있을 수 있음 (M=0 케이스) — 4byte 더미 버퍼라도 만들어야 bind group 생성 됨.
  const tileListAB = new ArrayBuffer(Math.max(4, tileSplatList.byteLength));
  if (tileSplatList.byteLength > 0) new Uint32Array(tileListAB).set(tileSplatList);
  const tileListGpu = makeBuf(device, tileListAB, S);

  const bg = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: splatGpu } },
      { binding: 1, resource: { buffer: outGpu } },
      { binding: 2, resource: { buffer: paramsGpu } },
      { binding: 3, resource: { buffer: tileOffsetsGpu } },
      { binding: 4, resource: { buffer: tileListGpu } },
    ],
  });

  const paramsBuf = new ArrayBuffer(16);
  const pu = new Uint32Array(paramsBuf);
  pu[0] = width;
  pu[1] = height;
  pu[2] = tilesPerRow;
  pu[3] = 0;
  device.queue.writeBuffer(paramsGpu, 0, paramsBuf);

  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  // workgroup 16×16 → 한 workgroup 이 한 타일 (16×16 픽셀) 처리.
  pass.dispatchWorkgroups(tilesPerRow, tilesPerCol);
  pass.end();
  enc.copyBufferToBuffer(outGpu, 0, readBuf, 0, outSize);
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();

  const oomErr = await device.popErrorScope();
  const valErr = await device.popErrorScope();
  if (oomErr || valErr) {
    console.warn(`[textureBakeGPU] GPU error detected → CPU fallback. validation=${valErr?.message ?? 'none'}, oom=${oomErr?.message ?? 'none'}`);
    [splatGpu, outGpu, paramsGpu, readBuf, tileOffsetsGpu, tileListGpu].forEach(b => { try { b.destroy(); } catch {} });
    return null;
  }

  await readBuf.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  [splatGpu, outGpu, paramsGpu, readBuf, tileOffsetsGpu, tileListGpu].forEach(b => b.destroy());

  return result;
}

export const TILE_SIZE_EXPORT = TILE_SIZE;
