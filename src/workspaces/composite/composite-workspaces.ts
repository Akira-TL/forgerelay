import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CompositeWorkspaceMember {
  name: string;
  purpose: string;
  workspaceId: string;
}

export type CompositeWorkspaceStatus = "active" | "closed";

export interface CompositeWorkspaceRecord {
  id: string;
  kind: "composite";
  name: string;
  status: CompositeWorkspaceStatus;
  members: CompositeWorkspaceMember[];
  createdAt: string;
  lastUsedAt: string;
}

interface PersistedCompositeWorkspaceRecord extends Omit<CompositeWorkspaceRecord, "status"> {
  status?: CompositeWorkspaceStatus;
}

interface CompositeWorkspaceState {
  version: 1 | 2;
  workspaces: PersistedCompositeWorkspaceRecord[];
}

export class CompositeWorkspaceRegistry {
  private readonly statePath: string;
  private readonly records = new Map<string, CompositeWorkspaceRecord>();

  constructor(private readonly stateDir: string) {
    this.statePath = join(stateDir, "composite-workspaces.json");
    this.load();
  }

  has(workspaceId: string): boolean {
    return this.records.has(workspaceId);
  }

  isActive(workspaceId: string): boolean {
    return this.records.get(workspaceId)?.status === "active";
  }

  create(name: string): CompositeWorkspaceRecord {
    const normalized = normalizeName(name);
    const existing = [...this.records.values()].find((record) => record.name === normalized);
    if (existing) return this.open(existing.id);
    const now = new Date().toISOString();
    const record: CompositeWorkspaceRecord = {
      id: `cws_${randomBytes(5).toString("hex")}`,
      kind: "composite",
      name: normalized,
      status: "active",
      members: [],
      createdAt: now,
      lastUsedAt: now,
    };
    this.records.set(record.id, record);
    this.persist();
    return cloneRecord(record);
  }

  get(workspaceId: string): CompositeWorkspaceRecord {
    const record = this.records.get(workspaceId);
    if (!record) throw new Error(`Unknown Composite Workspace ${workspaceId}.`);
    return cloneRecord(record);
  }

  open(workspaceId: string): CompositeWorkspaceRecord {
    const record = this.requireRecord(workspaceId);
    record.status = "active";
    return this.touchRecord(record);
  }

  close(workspaceId: string): CompositeWorkspaceRecord {
    const record = this.requireActive(workspaceId);
    record.status = "closed";
    return this.touchRecord(record);
  }

  touchActive(workspaceId: string): CompositeWorkspaceRecord {
    return this.touchRecord(this.requireActive(workspaceId));
  }

  list(): CompositeWorkspaceRecord[] {
    return [...this.records.values()]
      .map(cloneRecord)
      .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
  }

  addMember(
    workspaceId: string,
    input: CompositeWorkspaceMember,
  ): CompositeWorkspaceRecord {
    const record = this.requireActive(workspaceId);
    const name = normalizeMemberName(input.name);
    const purpose = input.purpose.trim();
    if (!purpose) throw new Error("Composite Workspace member purpose must not be empty.");
    const existing = record.members.find((member) => member.name === name);
    if (existing) {
      if (existing.purpose === purpose && existing.workspaceId === input.workspaceId) {
        return cloneRecord(record);
      }
      throw new Error(`Composite Workspace ${workspaceId} already has member ${name} with a different definition.`);
    }
    record.members.push({ name, purpose, workspaceId: input.workspaceId });
    record.lastUsedAt = new Date().toISOString();
    this.persist();
    return cloneRecord(record);
  }

  updateMember(
    workspaceId: string,
    memberName: string,
    input: {
      name?: string;
      purpose?: string;
      workspaceId?: string;
    },
  ): CompositeWorkspaceRecord {
    const record = this.requireActive(workspaceId);
    const currentName = normalizeMemberName(memberName);
    const index = record.members.findIndex((member) => member.name === currentName);
    if (index < 0) throw new Error(`Composite Workspace ${workspaceId} has no member ${currentName}.`);
    const current = record.members[index]!;
    const nextName = input.name === undefined ? current.name : normalizeMemberName(input.name);
    const nextPurpose = input.purpose === undefined ? current.purpose : input.purpose.trim();
    if (!nextPurpose) throw new Error("Composite Workspace member purpose must not be empty.");
    const nextWorkspaceId = input.workspaceId ?? current.workspaceId;
    if (
      nextName !== current.name &&
      record.members.some((member, memberIndex) => memberIndex !== index && member.name === nextName)
    ) {
      throw new Error(`Composite Workspace ${workspaceId} already has member ${nextName}.`);
    }
    if (
      nextName === current.name &&
      nextPurpose === current.purpose &&
      nextWorkspaceId === current.workspaceId
    ) {
      return cloneRecord(record);
    }
    record.members[index] = {
      name: nextName,
      purpose: nextPurpose,
      workspaceId: nextWorkspaceId,
    };
    record.lastUsedAt = new Date().toISOString();
    this.persist();
    return cloneRecord(record);
  }

  removeMember(workspaceId: string, memberName: string): CompositeWorkspaceRecord {
    const record = this.requireActive(workspaceId);
    const name = normalizeMemberName(memberName);
    const index = record.members.findIndex((member) => member.name === name);
    if (index < 0) throw new Error(`Composite Workspace ${workspaceId} has no member ${name}.`);
    record.members.splice(index, 1);
    record.lastUsedAt = new Date().toISOString();
    this.persist();
    return cloneRecord(record);
  }

  member(workspaceId: string, memberName: string): CompositeWorkspaceMember {
    const record = this.requireActive(workspaceId);
    const name = normalizeMemberName(memberName);
    const member = record.members.find((entry) => entry.name === name);
    if (!member) throw new Error(`Composite Workspace ${workspaceId} has no member ${name}.`);
    return { ...member };
  }

  dissolve(workspaceId: string): CompositeWorkspaceRecord {
    const record = this.requireRecord(workspaceId);
    this.records.delete(workspaceId);
    this.persist();
    return cloneRecord(record);
  }

  private touchRecord(record: CompositeWorkspaceRecord): CompositeWorkspaceRecord {
    record.lastUsedAt = new Date().toISOString();
    this.persist();
    return cloneRecord(record);
  }

  private requireActive(workspaceId: string): CompositeWorkspaceRecord {
    const record = this.requireRecord(workspaceId);
    if (record.status !== "active") {
      throw new Error(`Composite Workspace ${workspaceId} is closed. Reopen it with open_workspace before use.`);
    }
    return record;
  }

  private requireRecord(workspaceId: string): CompositeWorkspaceRecord {
    const record = this.records.get(workspaceId);
    if (!record) throw new Error(`Unknown Composite Workspace ${workspaceId}.`);
    return record;
  }

  private load(): void {
    let parsed: CompositeWorkspaceState | undefined;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as CompositeWorkspaceState;
    } catch (error) {
      if (isMissingFile(error)) return;
      throw new Error(`Failed to load Composite Workspace state: ${errorMessage(error)}`);
    }
    if ((parsed?.version !== 1 && parsed?.version !== 2) || !Array.isArray(parsed.workspaces)) {
      throw new Error("Composite Workspace state has an unsupported format.");
    }
    for (const record of parsed.workspaces) {
      if (!record?.id?.startsWith("cws_") || record.kind !== "composite") continue;
      this.records.set(record.id, {
        ...record,
        status: record.status === "closed" ? "closed" : "active",
        members: Array.isArray(record.members) ? record.members.map((member) => ({ ...member })) : [],
      });
    }
  }

  private persist(): void {
    mkdirSync(this.stateDir, { recursive: true });
    const state: CompositeWorkspaceState = {
      version: 2,
      workspaces: [...this.records.values()].map(cloneRecord),
    };
    const tempPath = `${this.statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(tempPath, this.statePath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
}

function normalizeName(name: string): string {
  const value = name.trim();
  if (!value) throw new Error("Composite Workspace name must not be empty.");
  if (value.length > 120) throw new Error("Composite Workspace name must be at most 120 characters.");
  return value;
}

function normalizeMemberName(name: string): string {
  const value = name.trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new Error("Composite Workspace member name must match /^[a-z][a-z0-9_-]{0,31}$/.");
  }
  return value;
}

function cloneRecord(record: CompositeWorkspaceRecord): CompositeWorkspaceRecord {
  return {
    ...record,
    members: record.members.map((member) => ({ ...member })),
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
