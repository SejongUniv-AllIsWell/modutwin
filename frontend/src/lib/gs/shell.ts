import type { GaussianScene } from '../ply/types';
import { filterScene } from '../ply/writer';
import type { SurfacePlane } from './planes';
import { signedDistance } from './planes';

export interface ShellOptions {
  marginIn: number;
  marginOut: number;
  nearProtect: number;
}

export const DEFAULT_SHELL_OPTIONS: ShellOptions = {
  marginIn: 0.05,
  marginOut: 0.3,
  nearProtect: 0.03,
};

/**
 * 현재 Shell MVP: 선택된 경계면 바깥 `marginOut` 초과 가우시안 삭제.
 * 색상 샘플링·패치 생성은 다음 단계에서 추가.
 *
 * 각 입자에 대해 선택된 평면 중 하나라도 signedDistance > marginOut 이면 삭제.
 * 단 nearProtect 이내 벽면 본체는 항상 보호.
 */
export function deleteOutsideSurfaces(
  scene: GaussianScene,
  planes: SurfacePlane[],
  options: Partial<ShellOptions> = {},
): { scene: GaussianScene; deletedCount: number; keep: Uint8Array } {
  const opts = { ...DEFAULT_SHELL_OPTIONS, ...options };

  const N = scene.numSplats;
  const posX = scene.attrs.get('x');
  const posY = scene.attrs.get('y');
  const posZ = scene.attrs.get('z');
  if (!posX || !posY || !posZ) throw new Error('shell: x/y/z attributes required');

  const keep = new Uint8Array(N);
  keep.fill(1);

  for (let i = 0; i < N; i++) {
    const x = posX[i], y = posY[i], z = posZ[i];
    let killed = false;
    for (const plane of planes) {
      const sd = signedDistance(plane, x, y, z);
      if (sd > opts.nearProtect && sd > opts.marginOut) { killed = true; break; }
    }
    if (killed) keep[i] = 0;
  }

  let deleted = 0;
  for (let i = 0; i < N; i++) if (!keep[i]) deleted++;

  return { scene: filterScene(scene, keep), deletedCount: deleted, keep };
}
