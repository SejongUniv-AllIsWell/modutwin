import type { GaussianScene } from './types';

export function serializePly(
  scene: GaussianScene,
  opts: { comments?: string[] } = {},
): ArrayBuffer {
  const props = scene.propertyOrder;
  const comments = opts.comments ?? [];

  const headerLines = [
    'ply',
    'format binary_little_endian 1.0',
    ...comments.map(c => `comment ${c}`),
    `element vertex ${scene.numSplats}`,
    ...props.map(p => `property float ${p}`),
    'end_header',
    '',
  ];
  const headerBytes = new TextEncoder().encode(headerLines.join('\n'));

  const numProps = props.length;
  const bodyFloats = scene.numSplats * numProps;

  // body는 자체 버퍼에서 생성 후 헤더와 이어붙인다 (정렬 문제 회피).
  const body = new Float32Array(bodyFloats);

  const arrays = props.map(p => {
    const a = scene.attrs.get(p);
    if (!a) throw new Error(`serializePly: missing attribute "${p}"`);
    if (a.length !== scene.numSplats) {
      throw new Error(`serializePly: attribute "${p}" length mismatch`);
    }
    return a;
  });

  for (let i = 0; i < scene.numSplats; i++) {
    const base = i * numProps;
    for (let j = 0; j < numProps; j++) body[base + j] = arrays[j][i];
  }

  const bodyBytes = new Uint8Array(body.buffer);
  const out = new Uint8Array(headerBytes.length + bodyBytes.length);
  out.set(headerBytes, 0);
  out.set(bodyBytes, headerBytes.length);

  return out.buffer;
}

export function serializeFilteredPly(
  scene: GaussianScene,
  keep: Uint8Array | boolean[],
  opts: {
    comments?: string[];
    overrides?: Map<number, Partial<Record<string, number>>>;
    valueAt?: (prop: string, srcIndex: number, current: number) => number;
  } = {},
): ArrayBuffer {
  let keepCount = 0;
  for (let i = 0; i < scene.numSplats; i++) if (keep[i]) keepCount++;

  const props = scene.propertyOrder;
  const comments = opts.comments ?? [];
  const headerLines = [
    'ply',
    'format binary_little_endian 1.0',
    ...comments.map(c => `comment ${c}`),
    `element vertex ${keepCount}`,
    ...props.map(p => `property float ${p}`),
    'end_header',
    '',
  ];
  const headerBytes = new TextEncoder().encode(headerLines.join('\n'));
  const rowBytes = props.length * 4;
  const out = new Uint8Array(headerBytes.length + keepCount * rowBytes);
  out.set(headerBytes, 0);

  const view = new DataView(out.buffer, headerBytes.length);
  const arrays = props.map(p => {
    const a = scene.attrs.get(p);
    if (!a) throw new Error(`serializeFilteredPly: missing attribute "${p}"`);
    if (a.length !== scene.numSplats) {
      throw new Error(`serializeFilteredPly: attribute "${p}" length mismatch`);
    }
    return a;
  });

  let row = 0;
  for (let i = 0; i < scene.numSplats; i++) {
    if (!keep[i]) continue;
    const base = row * rowBytes;
    const rowOverrides = opts.overrides?.get(i);
    for (let j = 0; j < props.length; j++) {
      const current = arrays[j][i];
      const overridden = rowOverrides?.[props[j]];
      const value = overridden !== undefined
        ? overridden
        : (opts.valueAt ? opts.valueAt(props[j], i, current) : current);
      view.setFloat32(base + j * 4, value, true);
    }
    row++;
  }

  return out.buffer;
}

export function cloneScene(scene: GaussianScene): GaussianScene {
  const attrs = new Map<string, Float32Array>();
  scene.attrs.forEach((v, k) => { attrs.set(k, new Float32Array(v)); });
  return { numSplats: scene.numSplats, attrs, propertyOrder: [...scene.propertyOrder] };
}

export function filterScene(scene: GaussianScene, keep: Uint8Array | boolean[]): GaussianScene {
  let keepCount = 0;
  for (let i = 0; i < scene.numSplats; i++) if (keep[i]) keepCount++;

  const attrs = new Map<string, Float32Array>();
  for (const p of scene.propertyOrder) {
    const src = scene.attrs.get(p)!;
    const dst = new Float32Array(keepCount);
    let w = 0;
    for (let i = 0; i < scene.numSplats; i++) if (keep[i]) dst[w++] = src[i];
    attrs.set(p, dst);
  }

  return { numSplats: keepCount, attrs, propertyOrder: [...scene.propertyOrder] };
}

export function concatScenes(a: GaussianScene, b: GaussianScene): GaussianScene {
  if (a.propertyOrder.length !== b.propertyOrder.length
    || a.propertyOrder.some((p, i) => p !== b.propertyOrder[i])) {
    throw new Error('concatScenes: property order mismatch');
  }
  const N = a.numSplats + b.numSplats;
  const attrs = new Map<string, Float32Array>();
  for (const p of a.propertyOrder) {
    const out = new Float32Array(N);
    out.set(a.attrs.get(p)!, 0);
    out.set(b.attrs.get(p)!, a.numSplats);
    attrs.set(p, out);
  }
  return { numSplats: N, attrs, propertyOrder: [...a.propertyOrder] };
}
