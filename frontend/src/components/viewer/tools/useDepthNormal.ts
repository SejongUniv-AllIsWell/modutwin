'use client';

import { useRef, useCallback } from 'react';

type Vec3 = [number, number, number];

let pipelinePromise: Promise<any> | null = null;

async function getDepthPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      // Runtime CDN imports execute code outside the locked dependency graph and
      // are difficult to cover with CSP. Keep depth normals disabled until the
      // model runtime is bundled through a Next-compatible browser package.
      return null;
    })();
  }
  return pipelinePromise;
}

/**
 * Compute surface normal from depth map at pixel (px, py).
 *
 * Approach:
 *   1. Back-project each pixel to 3D camera-space via pinhole model:
 *        P(u, v) = (z·(u−cx)/f, z·(v−cy)/f, z)
 *      with pixel +Y flipped to camera +Y (up).
 *   2. Finite-difference tangent vectors between 3D points:
 *        t_u = P(u+h, v) − P(u−h, v)
 *        t_v = P(u, v+h) − P(u, v−h)
 *   3. Normal = t_u × t_v, normalized.
 *
 * Using 3D points directly (not depth alone) means the derivatives already
 * account for perspective — accurate anywhere in the image.
 */
function normalFromDepth(
  depthData: Float32Array,
  width: number,
  height: number,
  px: number,
  py: number,
  focalLength: number,
): Vec3 {
  const ix = Math.round(px);
  const iy = Math.round(py);
  const cx = width / 2;
  const cy = height / 2;

  // Back-project one pixel to 3D camera space.
  // DA2 output is inverse-depth / disparity (bright=near), so real Z ∝ 1/value.
  const backProject = (x: number, y: number): Vec3 | null => {
    const bx = Math.max(0, Math.min(width - 1, x));
    const by = Math.max(0, Math.min(height - 1, y));
    const v = depthData[by * width + bx];
    if (v <= 1e-6) return null;
    const z = 1 / v;   // disparity → metric depth
    return [
      z * (bx - cx) / focalLength,
      z * -(by - cy) / focalLength,   // pixel +Y down → camera +Y up
      z,
    ];
  };

  // Average tangent vectors over several step sizes for noise robustness
  const steps = [1, 2, 3];
  let tu: Vec3 = [0, 0, 0];
  let tv: Vec3 = [0, 0, 0];
  let tuCount = 0;
  let tvCount = 0;

  for (const h of steps) {
    const pxp = backProject(ix + h, iy);
    const pxm = backProject(ix - h, iy);
    if (pxp && pxm) {
      tu[0] += (pxp[0] - pxm[0]) / (2 * h);
      tu[1] += (pxp[1] - pxm[1]) / (2 * h);
      tu[2] += (pxp[2] - pxm[2]) / (2 * h);
      tuCount++;
    }
    const pyp = backProject(ix, iy + h);
    const pym = backProject(ix, iy - h);
    if (pyp && pym) {
      tv[0] += (pyp[0] - pym[0]) / (2 * h);
      tv[1] += (pyp[1] - pym[1]) / (2 * h);
      tv[2] += (pyp[2] - pym[2]) / (2 * h);
      tvCount++;
    }
  }

  if (tuCount === 0 || tvCount === 0) return [0, 0, 1];
  tu = [tu[0] / tuCount, tu[1] / tuCount, tu[2] / tuCount];
  tv = [tv[0] / tvCount, tv[1] / tvCount, tv[2] / tvCount];

  // Cross product: tv × tu (not tu × tv) — tv was derived with +Y flipped,
  // so swap to keep normal pointing outward (toward camera: +Z).
  const nx = tv[1] * tu[2] - tv[2] * tu[1];
  const ny = tv[2] * tu[0] - tv[0] * tu[2];
  const nz = tv[0] * tu[1] - tv[1] * tu[0];
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-8) return [0, 0, 1];
  return [nx / len, ny / len, nz / len];
}

interface DepthCache {
  data: Float32Array;
  width: number;
  height: number;
  camRight: Vec3;
  camUp: Vec3;
  camForward: Vec3;
  canvasWidth: number;
  canvasHeight: number;
  focalLength: number;
}

export function useDepthNormal() {
  const loadingRef = useRef(false);
  const depthCacheRef = useRef<DepthCache | null>(null);

  /**
   * Capture current canvas view and compute depth map.
   * fovDeg: camera vertical field of view in degrees.
   */
  const computeDepthMap = useCallback(async (
    canvas: HTMLCanvasElement,
    camRight: Vec3,
    camUp: Vec3,
    camForward: Vec3,
    fovDeg: number,
  ) => {
    if (loadingRef.current) return null;
    loadingRef.current = true;

    try {
      const pipe = await getDepthPipeline();
      if (!pipe) return null;

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas capture failed'))), 'image/png');
      });

      const url = URL.createObjectURL(blob);
      const result = await pipe(url);
      URL.revokeObjectURL(url);

      const depthImage = result.depth;
      const w = depthImage.width;
      const h = depthImage.height;

      const raw = depthImage.data;
      const floatData = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        floatData[i] = raw[i] / 255;
      }

      // focal length in pixels: f = (h/2) / tan(fov/2)
      const fovRad = (fovDeg * Math.PI) / 180;
      const focalLength = (h / 2) / Math.tan(fovRad / 2);

      console.log(`[DepthNormal] depth ${w}x${h}, FOV=${fovDeg.toFixed(1)}°, focal=${focalLength.toFixed(1)}px`);

      depthCacheRef.current = {
        data: floatData,
        width: w,
        height: h,
        camRight: [...camRight] as Vec3,
        camUp: [...camUp] as Vec3,
        camForward: [...camForward] as Vec3,
        canvasWidth: canvas.clientWidth,
        canvasHeight: canvas.clientHeight,
        focalLength,
      };
      return depthCacheRef.current;
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const getNormalAt = useCallback(
    (sx: number, sy: number): Vec3 | null => {
      const cache = depthCacheRef.current;
      if (!cache) return null;

      const dx = (sx / cache.canvasWidth) * cache.width;
      const dy = (sy / cache.canvasHeight) * cache.height;

      const camNormal = normalFromDepth(
        cache.data, cache.width, cache.height, dx, dy, cache.focalLength,
      );

      const { camRight, camUp, camForward } = cache;
      const worldNormal: Vec3 = [
        camNormal[0] * camRight[0] + camNormal[1] * camUp[0] + camNormal[2] * (-camForward[0]),
        camNormal[0] * camRight[1] + camNormal[1] * camUp[1] + camNormal[2] * (-camForward[1]),
        camNormal[0] * camRight[2] + camNormal[1] * camUp[2] + camNormal[2] * (-camForward[2]),
      ];

      const len = Math.sqrt(worldNormal[0] ** 2 + worldNormal[1] ** 2 + worldNormal[2] ** 2);
      if (len < 1e-8) return null;
      return [worldNormal[0] / len, worldNormal[1] / len, worldNormal[2] / len];
    },
    [],
  );

  const isLoading = useCallback(() => loadingRef.current, []);
  const hasDepth = useCallback(() => depthCacheRef.current !== null, []);
  const clearDepth = useCallback(() => { depthCacheRef.current = null; }, []);

  return { computeDepthMap, getNormalAt, isLoading, hasDepth, clearDepth };
}
