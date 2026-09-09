export const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

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

export function claimMediaBytes(budget: MediaBudget, bytes: number): void {
  if (bytes > budget.remainingBytes) {
    throw new Error(
      `Media content exceeds the configured per-result limit of ${budget.maxBytes} bytes ` +
      `(${bytes} bytes requested, ${budget.remainingBytes} bytes remaining).`,
    );
  }
  budget.remainingBytes -= bytes;
}
