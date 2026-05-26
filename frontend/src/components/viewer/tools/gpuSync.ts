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
  // 스케일은 베이크 회전 등 전체 일괄 sync 시 transformB lock 이 zeroed buffer 를 반환하면
  // slot 0~2 가 0 으로 덮여 exp(0)=1m 로 부풀므로, 회전 quat 옆에 항상 같이 써준다.
  const sc0 = gsplatData?.getProp('scale_0');
  const sc1 = gsplatData?.getProp('scale_1');
  const sc2 = gsplatData?.getProp('scale_2');

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
      if (sc0 && sc1 && sc2) {
        dataB[idx * 4 + 0] = float2HalfFn(Math.exp(sc0[idx]));
        dataB[idx * 4 + 1] = float2HalfFn(Math.exp(sc1[idx]));
        dataB[idx * 4 + 2] = float2HalfFn(Math.exp(sc2[idx]));
      }
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
 * 가우시안 scale (log-scale) 만 변경한 후 GPU 동기화. 위치/쿼터니언은 손대지 않음.
 *
 * 호출 전에 gsplatData.scale_0/1/2 가 새 log-scale 로 업데이트되어 있어야 한다.
 * (transformBTexture 의 scale 슬롯은 exp(log-scale) 의 half-float — 이 함수가 GPU 에 동기화.)
 */
export function syncScalesGPU(
  indices: number[],
  splatData: SplatData,
  float2HalfFn: (v: number) => number,
) {
  const transformB = splatData.transformBTexture;
  const dataB = transformB?.lock();
  const gsplatData = splatData.gsplatData;
  const sc0 = gsplatData?.getProp('scale_0');
  const sc1 = gsplatData?.getProp('scale_1');
  const sc2 = gsplatData?.getProp('scale_2');
  if (!sc0 || !sc1 || !sc2) {
    if (transformB) transformB.unlock();
    return;
  }
  if (dataB) {
    for (const idx of indices) {
      // transformB: [scaleX(half), scaleY(half), scaleZ(half), rotZ(half)]
      dataB[idx * 4 + 0] = float2HalfFn(Math.exp(sc0[idx]));
      dataB[idx * 4 + 1] = float2HalfFn(Math.exp(sc1[idx]));
      dataB[idx * 4 + 2] = float2HalfFn(Math.exp(sc2[idx]));
    }
  }
  if (transformB) transformB.unlock();
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
