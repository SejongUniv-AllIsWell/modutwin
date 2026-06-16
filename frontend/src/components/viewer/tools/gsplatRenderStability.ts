const FULL_COUNT_PATCH_FLAG = '__modutwinFullSplatCountPatch';

const getSplatCount = (instance: any, resource: any): number => {
  const fromResource = Number(resource?.numSplats ?? resource?.gsplatData?.numSplats);
  if (Number.isFinite(fromResource) && fromResource > 0) return fromResource;
  const fromCenters = Number(instance?.sorter?.centers?.length ?? 0) / 3;
  return Number.isFinite(fromCenters) && fromCenters > 0 ? Math.floor(fromCenters) : 0;
};

const stabilizeSorterCount = (instance: any, resource: any): void => {
  const sorter = instance?.sorter;
  if (!sorter || sorter[FULL_COUNT_PATCH_FLAG]) return;
  const originalApplyPendingSorted = sorter.applyPendingSorted?.bind(sorter);
  if (typeof originalApplyPendingSorted !== 'function') return;

  sorter.applyPendingSorted = () => {
    const sortedCount = originalApplyPendingSorted();
    if (sortedCount < 0) return sortedCount;
    const fullCount = getSplatCount(instance, resource);
    return fullCount > 0 ? fullCount : sortedCount;
  };
  sorter[FULL_COUNT_PATCH_FLAG] = true;
};

const stabilizeAabb = (gsplatComponent: any, instance: any, resource: any): void => {
  const sourceAabb = resource?.aabb;
  const aabb = sourceAabb?.clone?.();
  if (!aabb?.halfExtents) return;

  const half = aabb.halfExtents;
  const maxExtent = Math.max(Math.abs(half.x), Math.abs(half.y), Math.abs(half.z), 1);
  const padding = Math.max(0.25, maxExtent * 0.03);
  half.x += padding;
  half.y += padding;
  half.z += padding;

  if (gsplatComponent) {
    gsplatComponent.customAabb = aabb;
  } else {
    instance?.meshInstance?.setCustomAabb?.(aabb);
  }
};

export const stabilizeGsplatRendering = (entity: any): void => {
  const gsplatComponent = entity?.gsplat;
  const instance = gsplatComponent?.instance;
  const resource = instance?.resource ?? gsplatComponent?.resource;
  if (!instance || !resource) return;

  stabilizeSorterCount(instance, resource);
  stabilizeAabb(gsplatComponent, instance, resource);
};
