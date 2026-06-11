export const MULTIPART_UPLOAD_CONCURRENCY = 3;

export interface MultipartUploadedPart {
  part_number: number;
  etag: string;
}

type MultipartChunk = BodyInit | Uint8Array;

export async function uploadMultipartParts(params: {
  presignedUrls: string[];
  partSize: number;
  totalSize: number;
  getChunk: (start: number, end: number) => MultipartChunk;
  concurrency?: number;
  errorLabel?: string;
  signal?: AbortSignal;
  onPartUploaded?: (completed: number, total: number) => void;
}): Promise<MultipartUploadedPart[]> {
  const {
    presignedUrls,
    partSize,
    totalSize,
    getChunk,
    concurrency = MULTIPART_UPLOAD_CONCURRENCY,
    errorLabel = 'part',
    signal,
    onPartUploaded,
  } = params;

  if (presignedUrls.length === 0) return [];

  const parts = new Array<MultipartUploadedPart>(presignedUrls.length);
  const workerCount = Math.max(1, Math.min(concurrency, presignedUrls.length));
  let nextIndex = 0;
  let completed = 0;

  async function uploadNextPart() {
    while (nextIndex < presignedUrls.length) {
      if (signal?.aborted) {
        throw new Error('upload aborted');
      }

      const index = nextIndex;
      nextIndex += 1;

      const start = index * partSize;
      const end = Math.min(start + partSize, totalSize);
      const response = await fetch(presignedUrls[index], {
        method: 'PUT',
        body: getChunk(start, end) as BodyInit,
        signal,
      });
      if (!response.ok) {
        throw new Error(`${errorLabel} ${index + 1} upload failed: ${response.status}`);
      }

      parts[index] = {
        part_number: index + 1,
        etag: response.headers.get('etag')?.replace(/"/g, '') ?? '',
      };
      completed += 1;
      onPartUploaded?.(completed, presignedUrls.length);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, uploadNextPart));
  return parts;
}
