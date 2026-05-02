/**
 * 평면도 (top-down) 베이크 — PlayCanvas GS 렌더링 버전.
 *
 * splat entity world bbox 를 구한 뒤,
 *  - 별도 직교(orthographic) 카메라를 (cutoffY) 위치에서 -Y 방향 lookdown 으로 배치
 *    → nearClip 으로 천장(=cutoffY) 위쪽 splat 자동 컷
 *  - 오프스크린 RenderTarget 에 한 프레임 렌더
 *  - gl.readPixels 로 RGBA 읽고 Y-flip 해서 HTMLCanvas 로 변환
 *
 * 결과: { canvas, ppm, minX, minZ, maxX, maxZ, width, height }.
 *  - 미니맵에서 (worldX, worldZ) → 픽셀 (px, py): px = (worldX - minX) * ppm, py = (worldZ - minZ) * ppm.
 */

export interface FloorplanResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  // World-space XZ 영역
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  ppm: number; // pixels per meter
}

export interface BakeFloorplanOptions {
  pixelsPerMeter?: number;     // default 50
  cutoffOffsetMeters?: number; // default 0.05 (천장에서 5cm 아래까지 자름)
  alphaThreshold?: number;     // default 0.05 (bbox 산출용)
  paddingMeters?: number;      // default 0.5
  maxDimension?: number;       // default 1500
}

interface SplatLike {
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  numSplats: number;
  origColorData: Uint16Array | null;
  splatEntity: any;
}

export async function bakeFloorplan(
  pc: any,
  app: any,
  splat: SplatLike,
  half2Float: (h: number) => number,
  opts: BakeFloorplanOptions = {},
): Promise<FloorplanResult | null> {
  const ppmInit = opts.pixelsPerMeter ?? 50;
  const cutoff = opts.cutoffOffsetMeters ?? 0.05;
  const alphaT = opts.alphaThreshold ?? 0.05;
  const pad = opts.paddingMeters ?? 0.5;
  const maxDim = opts.maxDimension ?? 1500;

  const orig = splat.origColorData;
  const splatEntity = splat.splatEntity;
  if (!orig || !splatEntity || !pc || !app) return null;
  const device = app.graphicsDevice;
  if (!device) return null;

  // 1) world bbox (CPU 1-pass) — alpha 작은 splat 무시.
  //    splatEntity.getWorldTransform() 으로 world 변환.
  const m = splatEntity.getWorldTransform().data;
  const n = splat.numSplats;
  let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = half2Float(orig[i * 4 + 3]);
    if (a < alphaT) continue;
    const px = splat.posX[i], py = splat.posY[i], pz = splat.posZ[i];
    const wx = m[0]*px + m[4]*py + m[8]*pz + m[12];
    const wy = m[1]*px + m[5]*py + m[9]*pz + m[13];
    const wz = m[2]*px + m[6]*py + m[10]*pz + m[14];
    if (wx < mnX) mnX = wx; if (wx > mxX) mxX = wx;
    if (wy < mnY) mnY = wy; if (wy > mxY) mxY = wy;
    if (wz < mnZ) mnZ = wz; if (wz > mxZ) mxZ = wz;
  }
  if (!Number.isFinite(mnX) || !Number.isFinite(mxY)) return null;

  // splat entity 에 Z-180 회전이 적용돼있어 world frame 에서 visual ceiling = mnY (small Y),
  // visual floor = mxY (large Y). PC 의 +Y up 컨벤션 기준으로는 방이 거꾸로 매달려있음.
  // 사용자가 원하는 "천장 컷" = 시각적 천장에서 cutoff 만큼 안쪽 (방 내부 방향) → world frame 에선 mnY + cutoff.
  const cutoffY = mnY + cutoff;
  // padding 적용 (xz 만)
  const minX = mnX - pad, maxX = mxX + pad;
  const minZ = mnZ - pad, maxZ = mxZ + pad;
  const worldX = maxX - minX;
  const worldZ = maxZ - minZ;
  if (worldX <= 0 || worldZ <= 0) return null;

  // RenderTarget 해상도. ppm 기준 W,H. maxDim 초과 시 ppm 축소.
  let ppm = ppmInit;
  let W = Math.max(2, Math.ceil(worldX * ppm));
  let H = Math.max(2, Math.ceil(worldZ * ppm));
  if (W > maxDim || H > maxDim) {
    const scale = maxDim / Math.max(W, H);
    ppm *= scale;
    W = Math.max(2, Math.ceil(worldX * ppm));
    H = Math.max(2, Math.ceil(worldZ * ppm));
  }

  // 2) 오프스크린 컬러 텍스처 + RenderTarget
  const colorTex = new pc.Texture(device, {
    width: W,
    height: H,
    format: pc.PIXELFORMAT_RGBA8 ?? pc.PIXELFORMAT_R8_G8_B8_A8,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    mipmaps: false,
    name: 'floorplan_rt_color',
  });
  const rt = new pc.RenderTarget({
    colorBuffer: colorTex,
    depth: true,
  });

  // 3) 직교 top-down 카메라.
  //    카메라 위치 y = cutoffY. -Y 로 lookdown. near 작게 → 카메라 바로 아래 (= cutoffY 미만) splat 만 frustum 내.
  //    orthoHeight = worldZ / 2 (PC 의 orthoHeight 는 frustum 절반 높이).
  //
  //    좌표 정합 핵심 (Z-180 으로 인해 visual UP = world -Y direction):
  //    카메라는 mnY 부근 (visual ceiling 바깥) 에 두고 +Y 방향 (visual DOWN) 으로 lookAt.
  //    PlayCanvas lookAt(target, up): localY = up, localZ = -(target-pos), localX = cross(localY, localZ).
  //    target-pos = (0,+1,0) → localZ = (0,-1,0).
  //    up = (0,0,+1) 로 잡으면:
  //      localY = (0,0,+1)
  //      localX = cross((0,0,1), (0,-1,0)) = (1,0,0)  → 카메라 right = +X world (정상)
  //      screen +Y (framebuffer up) = +Z world → framebuffer top = world maxZ
  //    Y-flip 후 canvas (0,0) = world (minX, _, minZ) → 미니맵의 (pos.x-minX, pos.z-minZ)*ppm 매핑과 일치.
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const camEnt = new pc.Entity('floorplan_cam');
  camEnt.addComponent('camera', {
    projection: pc.PROJECTION_ORTHOGRAPHIC,
    orthoHeight: worldZ / 2,
    nearClip: 0.001,
    farClip: Math.max(1, (mxY - mnY) + 2),
    clearColor: new pc.Color(0, 0, 0, 0),
    clearColorBuffer: true,
    clearDepthBuffer: true,
    renderTarget: rt,
    priority: -10, // 메인보다 먼저 렌더
  });
  camEnt.setPosition(cx, cutoffY, cz);
  // lookAt: target (cx, cutoffY+1, cz) — +Y 방향 (visual DOWN). up = +Z (좌표 정합).
  camEnt.lookAt(new pc.Vec3(cx, cutoffY + 1, cz), new pc.Vec3(0, 0, 1));
  app.root.addChild(camEnt);

  try {
    // 4) 한 프레임 렌더 대기 — postrender 이벤트로 정확히 잡거나, raf 두 번이면 안전.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    // 5) gl.readPixels 로 RGBA 읽기.
    const gl: WebGL2RenderingContext | WebGLRenderingContext = device.gl;
    // PC v2: rt.impl.glFrameBuffer / v1: rt._glFrameBuffer
    const fb = (rt as any).impl?.glFrameBuffer ?? (rt as any)._glFrameBuffer ?? null;
    const pixels = new Uint8Array(W * H * 4);
    if (fb) {
      const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    } else {
      console.warn('[floorplan] could not access RT framebuffer');
      return null;
    }

    // 6) WebGL 은 좌하단 origin → Y-flip
    const flipped = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const srcRow = (H - 1 - y) * W * 4;
      const dstRow = y * W * 4;
      flipped.set(pixels.subarray(srcRow, srcRow + W * 4), dstRow);
    }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(flipped, W, H), 0, 0);

    return { canvas, width: W, height: H, minX, minZ, maxX, maxZ, ppm };
  } finally {
    // 7) 정리
    try { app.root.removeChild(camEnt); } catch { /* ignore */ }
    try { camEnt.destroy(); } catch { /* ignore */ }
    try { rt.destroy(); } catch { /* ignore */ }
    try { colorTex.destroy(); } catch { /* ignore */ }
  }
}
