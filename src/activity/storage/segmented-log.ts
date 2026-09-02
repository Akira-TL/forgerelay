import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureParentPrivate, resolveStateRelativePath, stateRelativePath } from "./paths.js";

/**
 * Segment files are deliberately small enough to inspect, copy, prune, and
 * recover independently. The logical stream may be arbitrarily large; no
 * individual on-disk activity/output file should grow without bound.
 */
export const ACTIVITY_LOG_SEGMENT_BYTES = 8 * 1024 * 1024;

export interface SegmentedLogReference {
  prefix: string;
  offset: number;
  length: number;
}

export class SegmentedLogStore {
  private readonly appendOffsets = new Map<string, number>();

  constructor(
    private readonly stateDir: string,
    private readonly segmentBytes = ACTIVITY_LOG_SEGMENT_BYTES,
  ) {}

  append(prefixPath: string, data: Uint8Array): SegmentedLogReference {
    const prefix = stateRelativePath(this.stateDir, prefixPath);
    const currentOffset = this.appendOffsets.get(prefix) ?? this.discoverLength(prefixPath);
    this.writeAt(prefixPath, currentOffset, data);
    this.appendOffsets.set(prefix, currentOffset + data.byteLength);
    return { prefix, offset: currentOffset, length: data.byteLength };
  }

  appendAt(prefix: string, logicalOffset: number, data: Uint8Array): void {
    const prefixPath = resolveStateRelativePath(this.stateDir, prefix);
    this.writeAt(prefixPath, logicalOffset, data);
    const next = logicalOffset + data.byteLength;
    const known = this.appendOffsets.get(prefix);
    if (known === undefined || next > known) this.appendOffsets.set(prefix, next);
  }

  read(reference: SegmentedLogReference): Buffer {
    return this.readRange(reference.prefix, reference.offset, reference.offset + reference.length);
  }

  readRange(prefix: string, start: number, end: number): Buffer {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start) {
      throw new Error(`Invalid segmented log range: ${start}..${end}.`);
    }
    if (start === end) return Buffer.alloc(0);

    const prefixPath = resolveStateRelativePath(this.stateDir, prefix);
    const result = Buffer.allocUnsafe(end - start);
    let logicalOffset = start;
    let resultOffset = 0;

    while (logicalOffset < end) {
      const segmentIndex = Math.floor(logicalOffset / this.segmentBytes);
      const segmentOffset = logicalOffset % this.segmentBytes;
      const available = Math.min(end - logicalOffset, this.segmentBytes - segmentOffset);
      const path = segmentPath(prefixPath, segmentIndex);
      const fd = openSync(path, fsConstants.O_RDONLY);
      try {
        const bytesRead = readSync(fd, result, resultOffset, available, segmentOffset);
        if (bytesRead !== available) {
          throw new Error(`Segmented log ${path} ended before logical offset ${logicalOffset + available}.`);
        }
      } finally {
        closeSync(fd);
      }
      logicalOffset += available;
      resultOffset += available;
    }
    return result;
  }

  logicalLength(prefix: string): number {
    const known = this.appendOffsets.get(prefix);
    if (known !== undefined) return known;
    const prefixPath = resolveStateRelativePath(this.stateDir, prefix);
    const length = this.discoverLength(prefixPath);
    this.appendOffsets.set(prefix, length);
    return length;
  }

  private writeAt(prefixPath: string, logicalOffset: number, data: Uint8Array): void {
    if (!Number.isSafeInteger(logicalOffset) || logicalOffset < 0) {
      throw new Error(`Invalid segmented log offset: ${logicalOffset}.`);
    }
    if (data.byteLength === 0) return;

    ensureParentPrivate(prefixPath);
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let sourceOffset = 0;
    let current = logicalOffset;

    while (sourceOffset < bytes.length) {
      const segmentIndex = Math.floor(current / this.segmentBytes);
      const segmentOffset = current % this.segmentBytes;
      const writable = Math.min(bytes.length - sourceOffset, this.segmentBytes - segmentOffset);
      const path = segmentPath(prefixPath, segmentIndex);
      const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_WRONLY, 0o600);
      try {
        const stats = fstatSync(fd);
        if (stats.size !== segmentOffset) {
          throw new Error(
            `Segmented log append position mismatch for ${path}: expected ${segmentOffset}, found ${stats.size}.`,
          );
        }
        const written = writeSync(fd, bytes, sourceOffset, writable, segmentOffset);
        if (written !== writable) {
          throw new Error(`Short write while appending segmented log ${path}.`);
        }
      } finally {
        closeSync(fd);
      }
      sourceOffset += writable;
      current += writable;
    }
  }

  private discoverLength(prefixPath: string): number {
    const directory = dirname(prefixPath);
    const stem = basename(prefixPath);
    let files: string[];
    try {
      files = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }

    const pattern = new RegExp(`^${escapeRegExp(stem)}\\.(\\d{6})\\.log$`);
    let maxIndex = -1;
    let maxSize = 0;
    for (const file of files) {
      const match = pattern.exec(file);
      if (!match) continue;
      const index = Number(match[1]);
      const size = statSync(join(directory, file)).size;
      if (size > this.segmentBytes) {
        throw new Error(`Segmented log shard exceeds ${this.segmentBytes} bytes: ${join(directory, file)}.`);
      }
      if (index > maxIndex) {
        maxIndex = index;
        maxSize = size;
      }
    }
    if (maxIndex < 0) return 0;
    if (maxSize < this.segmentBytes) return maxIndex * this.segmentBytes + maxSize;
    return (maxIndex + 1) * this.segmentBytes;
  }
}

export function segmentPath(prefixPath: string, index: number): string {
  return `${prefixPath}.${String(index).padStart(6, "0")}.log`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
