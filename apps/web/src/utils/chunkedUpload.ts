import { env } from "next-runtime-env";

/**
 * cachly: Client half of the chunked upload (see pages/api/upload/*).
 *
 * Data is pushed to storage part by part *during* the recording. Two things
 * follow from that: a recording is no longer capped at what fits into one
 * request, and a crash at minute 19 costs the last few seconds instead of
 * everything.
 */

// S3 wants >= 5MB for every part except the last one.
const PART_SIZE = 6 * 1024 * 1024;
const PART_RETRIES = 3;

export interface UploadTargetRef {
  cardPublicId?: string;
  boardPublicId?: string;
}

interface StartResponse {
  key: string;
  uploadId: string;
  filename: string;
  originalFilename: string;
  contentType: string;
}

export interface FinishResult {
  key: string;
  draft?: boolean;
  originalFilename?: string;
  contentType?: string;
  size?: number;
}

const baseUrl = () => env("NEXT_PUBLIC_BASE_URL") ?? "";

const targetQuery = (target: UploadTargetRef) => {
  const params = new URLSearchParams();
  if (target.cardPublicId) params.set("cardPublicId", target.cardPublicId);
  if (target.boardPublicId) params.set("boardPublicId", target.boardPublicId);
  return params;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ChunkedUpload {
  private started: StartResponse | null = null;
  private pending: Blob[] = [];
  private pendingBytes = 0;
  private parts: { partNumber: number; etag: string }[] = [];
  private nextPartNumber = 1;
  private totalBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(
    private readonly target: UploadTargetRef,
    private readonly filename: string,
    private readonly contentType: string,
  ) {}

  get uploadedBytes() {
    return this.totalBytes - this.pendingBytes;
  }

  get hasFailed() {
    return this.failed;
  }

  /**
   * Queues a chunk. Returns immediately — the network work is serialised
   * behind a promise chain so the recorder never blocks on the upload.
   */
  add(blob: Blob) {
    if (blob.size === 0) return;
    this.pending.push(blob);
    this.pendingBytes += blob.size;
    this.totalBytes += blob.size;

    if (this.pendingBytes >= PART_SIZE) {
      this.queue = this.queue
        .then(() => this.flush(false))
        .catch(() => {
          this.failed = true;
        });
    }
  }

  private async ensureStarted() {
    if (this.started) return this.started;

    const response = await fetch(`${baseUrl()}/api/upload/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: this.filename,
        contentType: this.contentType,
        ...this.target,
      }),
    });
    if (!response.ok) throw new Error(`start failed: ${response.status}`);

    this.started = (await response.json()) as StartResponse;
    return this.started;
  }

  private async flush(final: boolean) {
    if (this.pendingBytes === 0) return;
    if (!final && this.pendingBytes < PART_SIZE) return;

    const started = await this.ensureStarted();
    const blob = new Blob(this.pending, { type: this.contentType });
    this.pending = [];
    this.pendingBytes = 0;

    const partNumber = this.nextPartNumber++;
    const params = targetQuery(this.target);
    params.set("key", started.key);
    params.set("uploadId", started.uploadId);
    params.set("partNumber", String(partNumber));

    let lastError: Error = new Error("part upload failed");
    for (let attempt = 0; attempt < PART_RETRIES; attempt++) {
      try {
        const response = await fetch(
          `${baseUrl()}/api/upload/part?${params.toString()}`,
          { method: "PUT", body: blob },
        );
        if (!response.ok) throw new Error(`part failed: ${response.status}`);
        const result = (await response.json()) as { etag?: string };
        if (!result.etag) throw new Error("part returned no etag");
        this.parts.push({ partNumber, etag: result.etag });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await sleep(500 * (attempt + 1));
      }
    }
    throw lastError;
  }

  /** Waits for queued parts, uploads the tail and seals the object. */
  async finish(): Promise<FinishResult> {
    await this.queue;
    await this.flush(true);

    if (this.parts.length === 0) throw new Error("nothing was uploaded");

    const started = await this.ensureStarted();
    const response = await fetch(`${baseUrl()}/api/upload/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: started.key,
        uploadId: started.uploadId,
        parts: this.parts,
        size: this.totalBytes,
        contentType: this.contentType,
        originalFilename: this.filename,
        ...this.target,
      }),
    });
    if (!response.ok) throw new Error(`finish failed: ${response.status}`);
    return (await response.json()) as FinishResult;
  }

  async abort() {
    if (!this.started) return;
    try {
      await fetch(`${baseUrl()}/api/upload/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: this.started.key,
          uploadId: this.started.uploadId,
          ...this.target,
        }),
      });
    } catch {
      // Storage cleans up abandoned multipart uploads on its own; a failed
      // abort must never surface as an error to the person recording.
    }
  }
}

/** Uploads a small file in one chunked round trip (used for poster frames). */
export const uploadSmallFile = async (
  target: UploadTargetRef,
  file: Blob,
  filename: string,
  contentType: string,
): Promise<FinishResult> => {
  const upload = new ChunkedUpload(target, filename, contentType);
  upload.add(file);
  return upload.finish();
};

export const attachDraft = async (
  cardPublicId: string,
  key: string,
  originalFilename: string,
  contentType: string,
) => {
  const response = await fetch(`${baseUrl()}/api/upload/attach-draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardPublicId, key, originalFilename, contentType }),
  });
  if (!response.ok) throw new Error(`attach-draft failed: ${response.status}`);
  return response.json() as Promise<{ attachment: { publicId: string } }>;
};
