import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface RuntimeLeaseRecord {
  pid: number;
  token: string;
  startedAt: string;
}

export interface RuntimeLeaseInspection {
  path: string;
  active: boolean;
  stale: boolean;
  pid?: number;
  malformed: boolean;
}

export interface RuntimeLease {
  path: string;
  pid: number;
  release(): void;
}

const RUNTIME_LEASE_FILE = "forgerelay-runtime.lock";

export function runtimeLeasePath(stateDir: string): string {
  return join(stateDir, RUNTIME_LEASE_FILE);
}

export function acquireRuntimeLease(stateDir: string): RuntimeLease {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = runtimeLeasePath(stateDir);
  const record: RuntimeLeaseRecord = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    startedAt: new Date().toISOString(),
  };
  const serialized = `${JSON.stringify(record)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      writeFileSync(fd, serialized, "utf8");
      closeSync(fd);
      fd = undefined;
      return {
        path,
        pid: record.pid,
        release: () => releaseRuntimeLease(path, record),
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (!isErrno(error, "EEXIST")) throw error;
      const inspection = inspectRuntimeLease(stateDir);
      if (inspection.active || inspection.malformed) {
        const owner = inspection.pid === undefined ? "an unknown process" : `PID ${inspection.pid}`;
        throw new Error(`ForgeRelay state is already in use by ${owner}: ${path}`);
      }
      rmSync(path, { force: true });
    }
  }

  throw new Error(`Unable to acquire ForgeRelay runtime lease: ${path}`);
}

export function inspectRuntimeLease(stateDir: string): RuntimeLeaseInspection {
  const path = runtimeLeasePath(stateDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { path, active: false, stale: false, malformed: false };
    }
    throw error;
  }

  const record = parseRecord(raw);
  if (!record) return { path, active: true, stale: false, malformed: true };
  const active = processIsAlive(record.pid);
  return {
    path,
    active,
    stale: !active,
    pid: record.pid,
    malformed: false,
  };
}

function releaseRuntimeLease(path: string, expected: RuntimeLeaseRecord): void {
  let current: RuntimeLeaseRecord | undefined;
  try {
    current = parseRecord(readFileSync(path, "utf8"));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (!current || current.pid !== expected.pid || current.token !== expected.token) return;
  rmSync(path, { force: true });
}

function parseRecord(raw: string): RuntimeLeaseRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<RuntimeLeaseRecord>;
    if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0) return undefined;
    if (typeof value.token !== "string" || value.token.length < 16) return undefined;
    if (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) return undefined;
    return { pid: value.pid as number, token: value.token, startedAt: value.startedAt };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
