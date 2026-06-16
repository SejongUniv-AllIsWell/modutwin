export const TEXTURE_WEBP_QUALITY = 0.88;

const WEBP_MIME = 'image/webp';
const PNG_MIME = 'image/png';

export interface EncodedTextureBlob {
  blob: Blob;
  filename: string;
  contentType: string;
  extension: 'webp' | 'png';
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

export function textureExtensionForContentType(contentType?: string | null): 'webp' | 'png' {
  return contentType?.toLowerCase().startsWith(WEBP_MIME) ? 'webp' : 'png';
}

export function textureUploadFilename(stem: string, blob: Blob): string {
  return `${stem}.${textureExtensionForContentType(blob.type)}`;
}

export async function encodeRgbaTexture(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  filenameStem: string,
  quality = TEXTURE_WEBP_QUALITY,
): Promise<EncodedTextureBlob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d ctx failed');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);

  const webp = await canvasToBlob(canvas, WEBP_MIME, quality);
  if (webp) {
    return {
      blob: webp,
      filename: `${filenameStem}.webp`,
      contentType: WEBP_MIME,
      extension: 'webp',
    };
  }

  const png = await canvasToBlob(canvas, PNG_MIME);
  if (!png) throw new Error('texture encode failed');
  return {
    blob: png,
    filename: `${filenameStem}.png`,
    contentType: PNG_MIME,
    extension: 'png',
  };
}
