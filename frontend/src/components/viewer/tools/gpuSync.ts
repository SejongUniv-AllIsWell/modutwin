import { SplatData } from '../SplatViewerCore';

/**
 * 가우시안 위치+쿼터니언 변경 후 GPU 텍스처 및 sorter를 동기화한다.
 *
 * 호출 전에 splatData.posX/Y/Z와 gsplatData.rot_0~3이
 * 이미 새 값으로 업데이트되어 있어야 한다.
 */
export function syncGPU(
  indices: number[],
  splatData: SplatData,
  float2HalfFn: (v: number) => number,
) {
  const transformA = splatData.transformATexture;
  const transformB = splatData.transformBTexture;
  const dataA = transformA?.lock();
  const dataAF32 = dataA ? new Float32Array(dataA.buffer) : null;
  const dataB = transformB?.lock();

  const gsplatData = splatData.gsplatData;
  const rot1 = gsplatData?.getProp('rot_1'); // x
  const rot2 = gsplatData?.getProp('rot_2'); // y
  const rot3 = gsplatData?.getProp('rot_3'); // z

  for (const idx of indices) {
    const nx = splatData.posX[idx];
    const ny = splatData.posY[idx];
    const nz = splatData.posZ[idx];
    const qx = rot1?.[idx] ?? 0;
    const qy = rot2?.[idx] ?? 0;
    const qz = rot3?.[idx] ?? 0;

    // transformA: [posX(f32), posY(f32), posZ(f32), rotXY(packed half)]
    if (dataAF32 && dataA) {
      dataAF32[idx * 4 + 0] = nx;
      dataAF32[idx * 4 + 1] = ny;
      dataAF32[idx * 4 + 2] = nz;
      dataA[idx * 4 + 3] = float2HalfFn(qx) | (float2HalfFn(qy) << 16);
    }

    // transformB: [scaleX(half), scaleY(half), scaleZ(half), rotZ(half)]
    if (dataB) {
      dataB[idx * 4 + 3] = float2HalfFn(qz);
    }
  }

  if (transformA) transformA.unlock();
  if (transformB) transformB.unlock();

  // sorter에 변경된 위치 전달
  const splatInstance = (splatData.splatEntity as any)?.gsplat?.instance;
  if (splatInstance?.sorter) {
    const centers = splatInstance.sorter.centers;
    if (centers) {
      for (const idx of indices) {
        centers[idx * 3 + 0] = splatData.posX[idx];
        centers[idx * 3 + 1] = splatData.posY[idx];
        centers[idx * 3 + 2] = splatData.posZ[idx];
      }
      splatInstance.sorter.setMapping(null);
    }
    splatInstance.lastCameraPosition.set(Infinity, Infinity, Infinity);
  }
}

/**
 * gsplatData에서 인덱스 배열에 해당하는 위치+쿼터니언 원본을 저장한다.
 * positions: [x0,y0,z0, x1,y1,z1, ...]
 * quaternions: [w0,x0,y0,z0, w1,x1,y1,z1, ...]
 */
export function snapshotSplatData(
  splatData: SplatData,
  indices: number[],
): { positions: Float32Array; quaternions: Float32Array } {
  const positions = new Float32Array(indices.length * 3);
  const quaternions = new Float32Array(indices.length * 4);
  const gsplatData = splatData.gsplatData;
  const rot0 = gsplatData?.getProp('rot_0'); // w
  const rot1 = gsplatData?.getProp('rot_1'); // x
  const rot2 = gsplatData?.getProp('rot_2'); // y
  const rot3 = gsplatData?.getProp('rot_3'); // z

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    positions[i * 3 + 0] = splatData.posX[idx];
    positions[i * 3 + 1] = splatData.posY[idx];
    positions[i * 3 + 2] = splatData.posZ[idx];
    quaternions[i * 4 + 0] = rot0?.[idx] ?? 1;
    quaternions[i * 4 + 1] = rot1?.[idx] ?? 0;
    quaternions[i * 4 + 2] = rot2?.[idx] ?? 0;
    quaternions[i * 4 + 3] = rot3?.[idx] ?? 0;
  }

  return { positions, quaternions };
}
