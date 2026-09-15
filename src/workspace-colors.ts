export const WORKSPACE_COLOR_SLOTS = [
  "cyan",
  "green",
  "yellow",
  "magenta",
  "blue",
  "white",
] as const;

export type WorkspaceColorSlot = (typeof WORKSPACE_COLOR_SLOTS)[number];

export class WorkspaceColorAllocator {
  private readonly assignments = new Map<string, WorkspaceColorSlot>();
  private readonly uniqueOwners = new Map<WorkspaceColorSlot, string>();

  colorFor(value: string): WorkspaceColorSlot {
    const existing = this.assignments.get(value);
    if (existing) return existing;

    const preferredIndex = stableWorkspaceColorIndex(value);
    for (let offset = 0; offset < WORKSPACE_COLOR_SLOTS.length; offset += 1) {
      const slot = WORKSPACE_COLOR_SLOTS[(preferredIndex + offset) % WORKSPACE_COLOR_SLOTS.length];
      if (!slot || this.uniqueOwners.has(slot)) continue;
      this.uniqueOwners.set(slot, value);
      this.assignments.set(value, slot);
      return slot;
    }

    const fallback = WORKSPACE_COLOR_SLOTS[preferredIndex] ?? WORKSPACE_COLOR_SLOTS[0];
    this.assignments.set(value, fallback);
    return fallback;
  }
}

const defaultWorkspaceColorAllocator = new WorkspaceColorAllocator();

export function workspaceColorFor(value: string): WorkspaceColorSlot {
  return defaultWorkspaceColorAllocator.colorFor(value);
}

export function stableWorkspaceColorIndex(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % WORKSPACE_COLOR_SLOTS.length;
}
