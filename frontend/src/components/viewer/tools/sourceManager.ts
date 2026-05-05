export const SCENE_3D_EXTS = ['ply', 'splat', 'sog'];

export const splitSceneFileExtension = (filename: string): string | undefined => {
  return filename.split('.').pop()?.toLowerCase();
};

export const splitSceneFilesByExtension = (files: File[]): { valid: File[]; rejected: string[] } => {
  const valid: File[] = [];
  const rejected: string[] = [];

  for (const file of files) {
    const ext = splitSceneFileExtension(file.name);
    if (ext && SCENE_3D_EXTS.includes(ext)) {
      valid.push(file);
    } else {
      rejected.push(file.name);
    }
  }

  return { valid, rejected };
};

type TreeNode = {
  children?: TreeNode[];
  destroy?: () => void;
  name?: string;
};

export const destroyMainDerivedMeshes = (root: TreeNode | null | undefined): void => {
  if (!root) return;

  const toDestroy: TreeNode[] = [];
  const collect = (node: TreeNode) => {
    for (const child of [...(node.children || [])]) {
      const name = child.name;
      if (name?.startsWith('wallMesh_') || name?.startsWith('doorMesh_')) {
        toDestroy.push(child);
      } else {
        collect(child);
      }
    }
  };

  collect(root);
  for (const entity of toDestroy) {
    try {
      entity.destroy?.();
    } catch {}
  }
};
