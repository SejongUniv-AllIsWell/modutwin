export interface GsplatAssetHint {
  filename: string;
  extension?: string;
}

const DEFAULT_GSPLAT_FILENAME = 'splat.ply';
const SUPPORTED_GSPLAT_EXTENSIONS = new Set(['ply', 'splat', 'sog', 'spz', 'json']);

function getFilenameExtension(filename: string | null | undefined): string | undefined {
  if (!filename) return undefined;
  const clean = filename.split(/[?#]/, 1)[0];
  const lastSegment = clean.split('/').pop() ?? clean;
  let decoded = lastSegment;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {}

  const dot = decoded.lastIndexOf('.');
  if (dot < 0 || dot === decoded.length - 1) return undefined;
  const ext = decoded.slice(dot + 1).toLowerCase();
  return SUPPORTED_GSPLAT_EXTENSIONS.has(ext) ? ext : undefined;
}

export function getGsplatUrlExtension(url: string): string | undefined {
  return getFilenameExtension(url);
}

export function getPlayCanvasGsplatAssetHint(url: string, filenameHint?: string | null): GsplatAssetHint {
  const urlExtension = getGsplatUrlExtension(url);
  const hintedExtension = getFilenameExtension(filenameHint);
  const extension = url.startsWith('blob:') ? hintedExtension : (urlExtension ?? hintedExtension);

  if (extension) {
    return {
      filename: `splat.${extension}`,
      extension,
    };
  }

  if (url.startsWith('blob:')) {
    return { filename: DEFAULT_GSPLAT_FILENAME };
  }

  // PlayCanvas chooses the gsplat parser from file.filename's extension.
  return { filename: DEFAULT_GSPLAT_FILENAME };
}
