import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";

export interface FileLockOptions {
  retryMs?: number;
  timeoutMs?: number;
  staleMs?: number;
  mode?: number;
}

interface LockOwner {
  pid: number;
  token: string;
}

const DEFAULT_RETRY_MS = 10;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;

/**
 * Cross-process lock acquisition must yield the event loop: these locks guard
 * tiny JSON state updates, but a contended lock can otherwise freeze every MCP
 * request handled by the same Node process. The owner token also prevents a
 * process that lost an abandoned lock from deleting a later owner's lock when
 * it eventually reaches cleanup.
 */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const retryMs = positiveInteger(options.retryMs, DEFAULT_RETRY_MS, "retryMs");
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const staleMs = positiveInteger(options.staleMs, DEFAULT_STALE_MS, "staleMs");
  const mode = options.mode ?? 0o600;
  const owner: LockOwner = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
  };
  const serializedOwner = `${JSON.stringify(owner)}\n`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", mode);
      try {
        await handle.writeFile(serializedOwner, "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (await reclaimAbandonedLock(lockPath, staleMs)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for file lock: ${lockPath}`);
    }
    await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  }

  try {
    return await operation();
  } finally {
    await releaseOwnedLock(lockPath, owner);
  }
}

async function reclaimAbandonedLock(lockPath: string, staleMs: number): Promise<boolean> {
  let owner: LockOwner | undefined;
  let ageMs: number;
  try {
    const [contents, info] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath),
    ]);
    owner = parseOwner(contents);
    ageMs = Date.now() - info.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }

  // A valid live PID is stronger evidence than mtime. This avoids declaring a
  // long but healthy operation stale merely because the event loop was paused.
  if (owner && processIsAlive(owner.pid)) return false;
  if (!owner && ageMs <= staleMs) return false;

  const stalePath = `${lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.stale`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(stalePath, { force: true });
  return true;
}

async function releaseOwnedLock(lockPath: string, owner: LockOwner): Promise<void> {
  let current: LockOwner | undefined;
  try {
    current = parseOwner(await readFile(lockPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return;
  await rm(lockPath, { force: true });
}

function parseOwner(contents: string): LockOwner | undefined {
  try {
    const value = JSON.parse(contents) as Partial<LockOwner>;
    return Number.isSafeInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.token === "string" && value.token
      ? { pid: value.pid as number, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`File lock ${name} must be a positive integer.`);
  }
  return resolved;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
