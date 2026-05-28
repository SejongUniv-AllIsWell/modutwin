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
  // 출력 버퍼가 maxStorageBufferBindingSize 를 초과하지 않도록 strip 별 dispatch.
  // 셰이더는 global py (= pyLocal + yOffset) 로 tile 조회, local pyLocal 로 출력 인덱스 계산.
  yOffset: u32,
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
  let pyLocal = gid.y;
  let py = pyLocal + params.yOffset;
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

  outRGBA[pyLocal * params.width + px] = vec4<f32>(rgb, 1.0 - T);
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

  const splatBytes = splatArr.byteLength;
  const tileOffsetsBytes = tileOffsets.byteLength;
  const tileListBytes = Math.max(4, tileSplatList.byteLength);

  // 정적 버퍼 한계 사전 체크 — output 버퍼는 strip 분할로 우회 가능하지만
  // splat/tileOffsets/tileList 는 전체가 한 번에 바인딩되어야 함.
  const maxStorage = device.limits.maxStorageBufferBindingSize;
  if (splatBytes > maxStorage) {
    console.warn(`[textureBakeGPU] splat buffer ${splatBytes} > limit ${maxStorage}. Falling back to CPU.`);
    return null;
  }
  if (tileOffsetsBytes > maxStorage) {
    console.warn(`[textureBakeGPU] tileOffsets buffer ${tileOffsetsBytes} > limit ${maxStorage}. Falling back to CPU.`);
    return null;
  }
  if (tileListBytes > maxStorage) {
    console.warn(`[textureBakeGPU] tileSplatList buffer ${tileListBytes} > limit ${maxStorage}. Falling back to CPU.`);
    return null;
  }

  // Output 버퍼는 width*height*16 byte (RGBA f32). 가로 strip 으로 분할.
  //
  // strip 크기 결정:
  //  - 하드 cap (32 MiB) — Firefox/시스템 GPU 풀 압박 회피. outGpu + readBuf 합쳐 64 MiB.
  //  - 정적 버퍼 (splats + tileOffsets + tileList) 합산 후에도 GPU 풀이 남도록.
  //  - 한도 (maxStorage / maxBufferSize) 와 cap 의 min.
  const STRIP_BUF_CAP = 32 * 1024 * 1024;  // 32 MiB
  const bytesPerRow = width * 16;
  const maxStripBytes = Math.min(maxStorage, device.limits.maxBufferSize, STRIP_BUF_CAP);
  const maxRowsPerStripRaw = Math.floor(maxStripBytes / bytesPerRow);
  if (maxRowsPerStripRaw < TILE_SIZE) {
    console.warn(`[textureBakeGPU] texture row too wide (${bytesPerRow} bytes/row, cap ${maxStripBytes}). Falling back to CPU.`);
    return null;
  }
  const stripRowsMax = Math.min(height, Math.floor(maxRowsPerStripRaw / TILE_SIZE) * TILE_SIZE);
  const stripBufSizeMax = stripRowsMax * width * 16;
  void tilesPerCol;  // strip 분할 시 strip 별 workgroupsY 로 대체.

  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');

  const S = GPUBufferUsage.STORAGE;
  // 정적 버퍼 — 한 번만 생성, strip 간 공유.
  const splatGpu = makeBuf(device, splatArr.buffer, S);
  splatGpu.label = 'bake-splats';
  const paramsGpu = device.createBuffer({
    label: 'bake-params',
    size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // typed array → ArrayBuffer (Uint32Array.buffer 가 SharedArrayBuffer 일 수도 있어서 새 ArrayBuffer 로 복사).
  const tileOffsetsAB = new ArrayBuffer(tileOffsets.byteLength);
  new Uint32Array(tileOffsetsAB).set(tileOffsets);
  const tileOffsetsGpu = makeBuf(device, tileOffsetsAB, S);
  tileOffsetsGpu.label = 'bake-tileOffsets';
  // tileSplatList 가 비어있을 수 있음 (M=0 케이스) — 4byte 더미 버퍼라도 만들어야 bind group 생성 됨.
  const tileListAB = new ArrayBuffer(Math.max(4, tileSplatList.byteLength));
  if (tileSplatList.byteLength > 0) new Uint32Array(tileListAB).set(tileSplatList);
  const tileListGpu = makeBuf(device, tileListAB, S);
  tileListGpu.label = 'bake-tileList';

  // outGpu, readBuf — 최대 strip 크기로 1회 할당, 모든 strip 이 재사용.
  // 마지막 strip 이 작으면 버퍼 끝부분은 미사용 (셰이더가 안 쓰는 영역, 읽기도 안 함).
  const outGpu = device.createBuffer({
    label: 'bake-out',
    size: stripBufSizeMax, usage: S | GPUBufferUsage.COPY_SRC,
  });
  const readBuf = device.createBuffer({
    label: 'bake-read',
    size: stripBufSizeMax, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // bind group 도 한 번만 — 모든 버퍼가 strip 간 불변.
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

  const fullOut = new Float32Array(totalPixels * 4);
  let stripFailed = false;

  try {
    for (let yStart = 0; yStart < height; yStart += stripRowsMax) {
      const actualRows = Math.min(stripRowsMax, height - yStart);
      const workgroupsY = Math.ceil(actualRows / TILE_SIZE);
      // 셰이더는 pyLocal ∈ [0, workgroupsY*16) 까지 쓰지만 outGpu/readBuf 는 stripBufSizeMax 로 잡혀있어 안전.
      const stripCopySize = workgroupsY * TILE_SIZE * width * 16;

      const paramsBuf = new ArrayBuffer(16);
      const pu = new Uint32Array(paramsBuf);
      pu[0] = width;
      pu[1] = height;
      pu[2] = tilesPerRow;
      pu[3] = yStart;
      device.queue.writeBuffer(paramsGpu, 0, paramsBuf);

      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(tilesPerRow, workgroupsY);
      pass.end();
      enc.copyBufferToBuffer(outGpu, 0, readBuf, 0, stripCopySize);
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();

      await readBuf.mapAsync(GPUMapMode.READ, 0, stripCopySize);
      const stripData = new Float32Array(readBuf.getMappedRange(0, stripCopySize).slice(0));
      readBuf.unmap();

      // actualRows 행만 fullOut 에 복사 (workgroupsY*16 의 마지막 패딩 행은 무시).
      const copyFloats = actualRows * width * 4;
      fullOut.set(stripData.subarray(0, copyFloats), yStart * width * 4);
    }
  } catch (e) {
    console.warn('[textureBakeGPU] strip dispatch failed:', e);
    stripFailed = true;
  }

  const oomErr = await device.popErrorScope();
  const valErr = await device.popErrorScope();
  const cleanup = () => {
    [splatGpu, outGpu, paramsGpu, readBuf, tileOffsetsGpu, tileListGpu].forEach(b => { try { b.destroy(); } catch {} });
  };
  if (stripFailed || oomErr || valErr) {
    console.warn(`[textureBakeGPU] GPU error → CPU fallback. validation=${valErr?.message ?? 'none'}, oom=${oomErr?.message ?? 'none'}`);
    cleanup();
    return null;
  }
  cleanup();
  return fullOut;
}

export const TILE_SIZE_EXPORT = TILE_SIZE;
