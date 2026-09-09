export const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type SupportedImageMimeType = typeof SUPPORTED_IMAGE_MIME_TYPES[number];

export interface MediaContentMetadata {
  type: "image";
  mimeType: string;
  bytes: number;
}

export interface MediaBudget {
  readonly maxBytes: number;
  remainingBytes: number;
}

export function createMediaBudget(maxBytes: number): MediaBudget {
  return { maxBytes, remainingBytes: maxBytes };
}

export function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

export function strictBase64ByteLength(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined;
  }
  return Buffer.byteLength(value, "base64");
}

export function claimMediaBytes(budget: MediaBudget, bytes: number): void {
  if (bytes > budget.remainingBytes) {
    throw new Error(
      `Media content exceeds the configured per-result limit of ${budget.maxBytes} bytes ` +
      `(${bytes} bytes requested, ${budget.remainingBytes} bytes remaining).`,
    );
  }
  budget.remainingBytes -= bytes;
}
