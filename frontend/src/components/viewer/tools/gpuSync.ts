import { SplatData } from '../SplatViewerCore';

/**
 * gsplatData (x/y/z, rot_*, scale_*) 를 in-place 수정한 후 호출. PC 의 GSplat.updateTransformData 가
 * gsplatData iter 로 pos+rot+scale 을 읽어 covariance (covA, covB) 를 계산하고 transformA/B 텍스처 전체를
 * 정확히 재계산해 GPU 에 올린다.
 *
 * transformA/B 의 슬롯은 raw pos/rot/scale 이 아니라 PC 가 미리 계산한 covariance 값이므로 직접 슬롯에
 * write 하면 가우시안 모양/크기가 깨진다. 항상 이 함수로 위임.
 *
 * sorter centers + lastCameraPosition 도 reset → 카메라 정지 상태에서도 re-sort 트리거.
 */
export function refreshGPUFromSplatData(splatData: SplatData) {
  const instance = (splatData.splatEntity as any)?.gsplat?.instance;
  const splat = instance?.splat;
  const gsplatData = splatData.gsplatData;
  if (splat?.updateTransformData && gsplatData) {
    splat.updateTransformData(gsplatData);
  }
  if (instance?.sorter) {
    const centers = instance.sorter.centers;
    if (centers && splatData.posX && splatData.posY && splatData.posZ) {
      const N = splatData.numSplats;
      for (let i = 0; i < N; i++) {
        centers[i * 3 + 0] = splatData.posX[i];
        centers[i * 3 + 1] = splatData.posY[i];
        centers[i * 3 + 2] = splatData.posZ[i];
      }
      instance.sorter.setMapping(null);
    }
    instance.lastCameraPosition?.set(Infinity, Infinity, Infinity);
  }
}

/**
 * 가우시안 위치+쿼터니언 변경 후 GPU 동기화. PC GSplat.updateTransformData 를 호출 (covariance 정확 재계산).
 * indices 인자는 무시됨 — PC API 가 partial 갱신을 지원하지 않아 전체 재계산.
 */
export function syncGPU(
  _indices: number[],
  splatData: SplatData,
  _float2HalfFn: (v: number) => number,
) {
  refreshGPUFromSplatData(splatData);
}

/**
 * 가우시안 scale 변경 후 GPU 동기화. PC GSplat.updateTransformData 호출 (위와 동일).
 */
export function syncScalesGPU(
  _indices: number[],
  splatData: SplatData,
  _float2HalfFn: (v: number) => number,
) {
  refreshGPUFromSplatData(splatData);
}

/**
 * gsplatData 에서 인덱스 배열에 해당하는 위치+쿼터니언 원본을 저장한다.
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
