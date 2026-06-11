export const MULTIPART_UPLOAD_CONCURRENCY = 3;
const DEFAULT_PART_UPLOAD_TIMEOUT_MS = 180_000;
const DEFAULT_PART_UPLOAD_MAX_RETRIES = 2;
const PART_UPLOAD_RETRY_BASE_DELAY_MS = 750;
const PART_UPLOAD_RETRY_MAX_DELAY_MS = 5_000;

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
  partTimeoutMs?: number;
  maxRetries?: number;
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
    partTimeoutMs = DEFAULT_PART_UPLOAD_TIMEOUT_MS,
    maxRetries = DEFAULT_PART_UPLOAD_MAX_RETRIES,
    signal,
    onPartUploaded,
  } = params;

  if (presignedUrls.length === 0) return [];

  const parts = new Array<MultipartUploadedPart>(presignedUrls.length);
  const workerCount = Math.max(1, Math.min(concurrency, presignedUrls.length));
  let nextIndex = 0;
  let completed = 0;

  function waitForRetry(delayMs: number): Promise<void> {
    if (signal?.aborted) {
      throw new Error('upload aborted');
    }

    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        signal?.removeEventListener('abort', handleAbort);
      };
      const handleAbort = () => {
        cleanup();
        reject(new Error('upload aborted'));
      };

      timeoutId = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      signal?.addEventListener('abort', handleAbort, { once: true });
    });
  }

  async function uploadPartWithRetry(index: number): Promise<MultipartUploadedPart> {
    const start = index * partSize;
    const end = Math.min(start + partSize, totalSize);
    const attempts = Math.max(1, maxRetries + 1);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) {
        throw new Error('upload aborted');
      }

      const controller = new AbortController();
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, partTimeoutMs);
      const handleAbort = () => controller.abort();
      signal?.addEventListener('abort', handleAbort, { once: true });

      try {
        const response = await fetch(presignedUrls[index], {
          method: 'PUT',
          body: getChunk(start, end) as BodyInit,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`${errorLabel} ${index + 1} upload failed: ${response.status}`);
        }

        return {
          part_number: index + 1,
          etag: response.headers.get('etag')?.replace(/"/g, '') ?? '',
        };
      } catch (error) {
        if (signal?.aborted) {
          throw new Error('upload aborted');
        }

        const errorMessage = timedOut
          ? `${errorLabel} ${index + 1} upload timed out after ${partTimeoutMs}ms`
          : error instanceof Error
            ? error.message
            : `${errorLabel} ${index + 1} upload failed`;
        lastError = new Error(errorMessage);

        if (attempt >= attempts) {
          throw lastError;
        }

        console.warn(
          `[multipart] ${errorMessage}; retrying (${attempt}/${attempts - 1})`,
        );
        const retryDelay = Math.min(
          PART_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          PART_UPLOAD_RETRY_MAX_DELAY_MS,
        );
        await waitForRetry(retryDelay);
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', handleAbort);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`${errorLabel} ${index + 1} upload failed`);
  }

  async function uploadNextPart() {
    while (nextIndex < presignedUrls.length) {
      if (signal?.aborted) {
        throw new Error('upload aborted');
      }

      const index = nextIndex;
      nextIndex += 1;

      parts[index] = await uploadPartWithRetry(index);
      completed += 1;
      onPartUploaded?.(completed, presignedUrls.length);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, uploadNextPart));
  return parts;
}
