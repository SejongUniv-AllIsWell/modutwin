// 클라이언트 렌더 SAM3 — 뷰셋을 오프스크린 256x256 RenderTarget 으로 렌더해
// PNG + 카메라 K/c2w(raw OpenCV) 를 추출한다. floorplan.ts 의 RT+readPixels 패턴 재사용.
//
// 좌표 계약 (server prerendered 경로와 일치, docs/client-render-sam3-plan.md §3):
//  - K(OpenCV 픽셀): fx=fy=(size/2)/tan(fovV/2), cx=cy=size/2 (정사각).
//  - c2w(raw OpenCV cam→world): 열 = [right, -up, forward], 평행이동 = camPos.
//      (OpenCV cam axes: x=right, y=down=-up, z=forward=look)
//  - 이미지: WebGL bottom-left → Y-flip 으로 top-left(=장면 위) upright. 서버는 identity 픽셀 매핑.

import type { DoorCameraSpec } from './doorViewSet';

export interface CapturedDoorView {
  idx: number;
  blob: Blob;
  /** OpenCV 3x3 */
  K: number[][];
  /** raw OpenCV cam→world 4x4 */
  c2w: number[][];
  w: number;
  h: number;
}

interface CoreLike {
  getApp: () => any | null;
  getPC: () => any | null;
}

export async function captureDoorViews(
  core: CoreLike,
  specs: DoorCameraSpec[],
  opts?: { size?: number },
): Promise<CapturedDoorView[]> {
  const app = core.getApp();
  const pc = core.getPC();
  if (!app || !pc) throw new Error('PlayCanvas app/pc 미초기화');
  if (!specs.length) return [];

  const size = opts?.size ?? 256;
  const device = app.graphicsDevice;

  const colorTex = new pc.Texture(device, {
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8 ?? pc.PIXELFORMAT_R8_G8_B8_A8,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    mipmaps: false,
    name: 'doorview_rt_color',
  });
  const rt = new pc.RenderTarget({ colorBuffer: colorTex, depth: true });

  const camEnt = new pc.Entity('doorview_cam', app);
  camEnt.addComponent('camera', {
    projection: pc.PROJECTION_PERSPECTIVE,
    fov: specs[0].fov, // 세로 FOV (aspect=1 정사각 → fx=fy)
    horizontalFov: false,
    aspectRatioMode: pc.ASPECT_MANUAL,
    aspectRatio: 1,
    nearClip: 0.01,
    farClip: 1000,
    clearColor: new pc.Color(0.5, 0.5, 0.5, 1), // SAM3 용 중립 배경 (alpha 불투명)
    clearColorBuffer: true,
    clearDepthBuffer: true,
    renderTarget: rt,
    priority: -10, // 메인 카메라보다 먼저
  });
  app.root.addChild(camEnt);

  const out: CapturedDoorView[] = [];
  try {
    const gl: WebGL2RenderingContext | WebGLRenderingContext = device.gl;
    const fb = (rt as any).impl?.glFrameBuffer ?? (rt as any)._glFrameBuffer ?? null;
    if (!fb) throw new Error('RT framebuffer 접근 실패');

    for (const spec of specs) {
      const cam = camEnt.camera!;
      cam.fov = spec.fov;
      camEnt.setPosition(spec.position[0], spec.position[1], spec.position[2]);
      camEnt.lookAt(
        new pc.Vec3(spec.target[0], spec.target[1], spec.target[2]),
        new pc.Vec3(spec.up[0], spec.up[1], spec.up[2]),
      );

      // 새 포즈로 렌더 반영 (2 RAF — floorplan 패턴과 동일).
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

      const pixels = new Uint8Array(size * size * 4);
      const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev);

      // WebGL bottom-left → top-left Y-flip
      const flipped = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) {
        const srcRow = (size - 1 - y) * size * 4;
        flipped.set(pixels.subarray(srcRow, srcRow + size * 4), y * size * 4);
      }
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d ctx 실패');
      ctx.putImageData(new ImageData(flipped, size, size), 0, 0);
      const blob = await new Promise<Blob>((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob null'))), 'image/png'),
      );

      // K (OpenCV)
      const fy = (size / 2) / Math.tan((spec.fov * Math.PI) / 180 / 2);
      const fx = fy;
      const c = size / 2;
      const K = [[fx, 0, c], [0, fy, c], [0, 0, 1]];

      // c2w (raw OpenCV): 열 = [right, -up, forward], t = pos
      const r = camEnt.right;   // pc.Vec3 (world)
      const u = camEnt.up;
      const f = camEnt.forward; // look 방향 (= 엔티티 -Z 의 world)
      const p = camEnt.getPosition();
      const c2w = [
        [r.x, -u.x, f.x, p.x],
        [r.y, -u.y, f.y, p.y],
        [r.z, -u.z, f.z, p.z],
        [0, 0, 0, 1],
      ];

      out.push({ idx: spec.idx, blob, K, c2w, w: size, h: size });
    }
  } finally {
    try { app.root.removeChild(camEnt); } catch { /* ignore */ }
    try { camEnt.destroy(); } catch { /* ignore */ }
    try { rt.destroy(); } catch { /* ignore */ }
    try { colorTex.destroy(); } catch { /* ignore */ }
  }
  return out;
}

/** captureDoorViews 결과 + 방기하 → /uploads/sam3/detect-temp-image multipart FormData. */
export function buildDetectImageFormData(params: {
  captured: CapturedDoorView[];
  room: {
    rot_x: number; rot_z: number; floor_y: number; ceiling_y: number;
    wall_polygon: { x: number; z: number }[] | number[][];
  };
  wallAngleRad: number;
  prompt?: string;
  sam3Prob?: number;
}): FormData {
  const { captured, room, wallAngleRad, prompt = 'white door', sam3Prob = 0.55 } = params;
  const meta = {
    prompt,
    sam3_prob: sam3Prob,
    wall_angle_rad: wallAngleRad,
    views: captured.map((v) => ({ idx: v.idx, K: v.K, c2w: v.c2w, w: v.w, h: v.h })),
    room,
  };
  const fd = new FormData();
  fd.append('meta', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'meta.json');
  for (const v of captured) {
    const name = `view_${String(v.idx).padStart(4, '0')}.png`;
    fd.append('views', v.blob, name);
  }
  return fd;
}
