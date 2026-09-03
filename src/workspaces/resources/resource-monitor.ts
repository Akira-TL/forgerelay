import { readFileSync, realpathSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
import { skillSummaryFromContent } from "./skills.js";

const WATCH_INTERVAL_MS = 750;
const MAX_HISTORY = 128;
const MAX_DELIVERY_CHARACTERS = 32 * 1024;
const MAX_PATCH_CHARACTERS = 8 * 1024;

export type WorkspaceResourceKind = "instruction-loaded" | "instruction-available" | "skill";

export interface WorkspaceResourceSkillInput {
  name: string;
  filePath: string;
  baseDir: string;
  activated: boolean;
}

export interface TrackWorkspaceResourcesInput {
  workspaceId: string;
  root: string;
  loadedInstructions: string[];
  availableInstructions: string[];
  skills: WorkspaceResourceSkillInput[];
}

export interface WorkspaceResourceUpdate {
  text: string;
  coveredComponents: Array<"agentsFiles" | "skills">;
  revision: number;
}

interface ResourceSubscription {
  kind: WorkspaceResourceKind;
  displayPath: string;
  skillName?: string;
  exposeSkillBody: boolean;
}

interface ResourceChange extends ResourceSubscription {
  revision: number;
  watchKey: string;
  oldContent: string | undefined;
  newContent: string | undefined;
}

interface WorkspaceWatchState {
  root: string;
  revision: number;
  tracked: Map<string, () => void>;
  subscriptions: Map<string, ResourceSubscription>;
  changes: ResourceChange[];
  deliveredRevisionByScope: Map<string, number>;
}

interface SharedWatchEntry {
  key: string;
  watchPath: string;
  content: string | undefined;
  subscribers: Map<string, (oldContent: string | undefined, newContent: string | undefined) => void>;
  listener: (current: Stats, previous: Stats) => void;
}

const sharedWatches = new Map<string, SharedWatchEntry>();
let monitorSequence = 0;

/**
 * Tracks already-advertised Workspace instruction and Skill files. The OS-level
 * stat watcher is process-global and canonical-path keyed, so two Workspaces or
 * conversations that refer to the same physical file still create only one
 * underlying watcher. Resource changes are delivered as bounded deltas.
 */
export class WorkspaceResourceMonitor {
  private readonly id = `monitor-${++monitorSequence}`;
  private readonly states = new Map<string, WorkspaceWatchState>();

  trackWorkspace(input: TrackWorkspaceResourcesInput): void {
    const state = this.states.get(input.workspaceId) ?? {
      root: input.root,
      revision: 0,
      tracked: new Map(),
      subscriptions: new Map(),
      changes: [],
      deliveredRevisionByScope: new Map(),
    };
    state.root = input.root;
    this.states.set(input.workspaceId, state);

    const desired = new Map<string, { path: string; subscription: ResourceSubscription }>();
    for (const path of input.availableInstructions) {
      this.addDesired(desired, path, {
        kind: "instruction-available",
        displayPath: displayWorkspacePath(path, input.root),
        exposeSkillBody: false,
      });
    }
    for (const path of input.loadedInstructions) {
      this.addDesired(desired, path, {
        kind: "instruction-loaded",
        displayPath: displayWorkspacePath(path, input.root),
        exposeSkillBody: false,
      });
    }
    for (const skill of input.skills) {
      this.addDesired(desired, skill.filePath, {
        kind: "skill",
        displayPath: `skills://${encodeURIComponent(skill.name)}`,
        skillName: skill.name,
        exposeSkillBody: skill.activated,
      });
    }

    for (const [key, stop] of state.tracked) {
      if (desired.has(key)) continue;
      stop();
      state.tracked.delete(key);
      state.subscriptions.delete(key);
    }

    for (const [key, item] of desired) {
      state.subscriptions.set(key, item.subscription);
      if (state.tracked.has(key)) {
        synchronizeSharedWatch(key);
        continue;
      }
      const subscriberId = `${this.id}:${input.workspaceId}:${key}`;
      const stop = subscribeSharedWatch(item.path, subscriberId, (oldContent, newContent) => {
        this.recordChange(input.workspaceId, key, oldContent, newContent);
      });
      state.tracked.set(key, stop);
    }
  }

  trackLoadedInstruction(workspaceId: string, root: string, path: string): void {
    const state = this.states.get(workspaceId);
    if (!state) return;
    const key = canonicalWatchKey(path);
    state.subscriptions.set(key, {
      kind: "instruction-loaded",
      displayPath: displayWorkspacePath(path, root),
      exposeSkillBody: false,
    });
    if (state.tracked.has(key)) return;
    const subscriberId = `${this.id}:${workspaceId}:${key}`;
    state.tracked.set(key, subscribeSharedWatch(path, subscriberId, (oldContent, newContent) => {
      this.recordChange(workspaceId, key, oldContent, newContent);
    }));
  }

  markSkillActivated(workspaceId: string, skillPath: string): void {
    const state = this.states.get(workspaceId);
    if (!state) return;
    const subscription = state.subscriptions.get(canonicalWatchKey(skillPath));
    if (subscription?.kind === "skill") subscription.exposeSkillBody = true;
  }

  acknowledge(workspaceId: string, conversationScopeId: string | undefined): void {
    if (!conversationScopeId) return;
    const state = this.states.get(workspaceId);
    if (!state) return;
    state.deliveredRevisionByScope.set(conversationScopeId, state.revision);
    this.pruneDeliveredHistory(state);
  }

  claim(workspaceId: string, conversationScopeId: string | undefined): WorkspaceResourceUpdate | undefined {
    if (!conversationScopeId) return undefined;
    const state = this.states.get(workspaceId);
    if (!state) return undefined;
    // File watcher delivery is advisory and can lag behind a tool call. Refresh
    // tracked files synchronously before deciding whether this conversation has
    // new context so rapid consecutive writes cannot be skipped.
    for (const key of state.tracked.keys()) synchronizeSharedWatch(key);
    const deliveredRevision = state.deliveredRevisionByScope.get(conversationScopeId) ?? state.revision;
    const changes = state.changes.filter((change) => change.revision > deliveredRevision);
    state.deliveredRevisionByScope.set(conversationScopeId, state.revision);
    if (changes.length === 0) return undefined;

    const grouped = coalesceChanges(changes);
    const sections: string[] = [];
    const coveredComponents = new Set<"agentsFiles" | "skills">();
    for (const change of grouped) {
      const formatted = formatResourceChange(change);
      if (!formatted) continue;
      sections.push(formatted.text);
      for (const component of formatted.coveredComponents) coveredComponents.add(component);
    }
    this.pruneDeliveredHistory(state);
    if (sections.length === 0) return undefined;

    const header = "Workspace context changed after this Workspace was opened. Apply only these deltas; unchanged instructions and Skill metadata remain active:";
    const joined = [header, ...sections].join("\n\n");
    const text = joined.length <= MAX_DELIVERY_CHARACTERS
      ? joined
      : `${joined.slice(0, MAX_DELIVERY_CHARACTERS)}\n\n[Additional Workspace context deltas were truncated; reopen with context=\"auto\" to refresh metadata.]`;
    return {
      text,
      coveredComponents: [...coveredComponents],
      revision: state.revision,
    };
  }

  isCurrentForScope(workspaceId: string, conversationScopeId: string | undefined): boolean {
    if (!conversationScopeId) return false;
    const state = this.states.get(workspaceId);
    if (!state) return false;
    return state.deliveredRevisionByScope.get(conversationScopeId) === state.revision;
  }

  forgetWorkspace(workspaceId: string): void {
    const state = this.states.get(workspaceId);
    if (!state) return;
    for (const stop of state.tracked.values()) stop();
    this.states.delete(workspaceId);
  }

  pruneWorkspaces(activeWorkspaceIds: Iterable<string>): void {
    const active = new Set(activeWorkspaceIds);
    for (const workspaceId of this.states.keys()) {
      if (!active.has(workspaceId)) this.forgetWorkspace(workspaceId);
    }
  }

  get watchedPhysicalFiles(): number {
    return sharedWatches.size;
  }

  private addDesired(
    desired: Map<string, { path: string; subscription: ResourceSubscription }>,
    path: string,
    subscription: ResourceSubscription,
  ): void {
    const key = canonicalWatchKey(path);
    const current = desired.get(key);
    if (current?.subscription.kind === "instruction-loaded") return;
    desired.set(key, { path, subscription });
  }

  private recordChange(
    workspaceId: string,
    key: string,
    oldContent: string | undefined,
    newContent: string | undefined,
  ): void {
    if (oldContent === newContent) return;
    const state = this.states.get(workspaceId);
    const subscription = state?.subscriptions.get(key);
    if (!state || !subscription) return;
    state.revision += 1;
    state.changes.push({
      ...subscription,
      revision: state.revision,
      watchKey: key,
      oldContent,
      newContent,
    });
    if (state.changes.length > MAX_HISTORY) {
      state.changes.splice(0, state.changes.length - MAX_HISTORY);
    }
  }

  private pruneDeliveredHistory(state: WorkspaceWatchState): void {
    if (state.changes.length === 0 || state.deliveredRevisionByScope.size === 0) return;
    const floor = Math.min(...state.deliveredRevisionByScope.values());
    while (state.changes[0] && state.changes[0].revision <= floor) state.changes.shift();
  }
}

function subscribeSharedWatch(
  inputPath: string,
  subscriberId: string,
  subscriber: (oldContent: string | undefined, newContent: string | undefined) => void,
): () => void {
  const key = canonicalWatchKey(inputPath);
  let entry = sharedWatches.get(key);
  if (!entry) {
    const watchPath = resolve(inputPath);
    const listener = () => synchronizeSharedWatch(key);
    entry = {
      key,
      watchPath,
      content: readOptionalFile(watchPath),
      subscribers: new Map(),
      listener,
    };
    sharedWatches.set(key, entry);
    watchFile(watchPath, { interval: WATCH_INTERVAL_MS, persistent: false }, listener);
  } else {
    synchronizeSharedWatch(key);
  }
  entry.subscribers.set(subscriberId, subscriber);

  return () => {
    const current = sharedWatches.get(key);
    if (!current) return;
    current.subscribers.delete(subscriberId);
    if (current.subscribers.size > 0) return;
    unwatchFile(current.watchPath, current.listener);
    sharedWatches.delete(key);
  };
}

function synchronizeSharedWatch(key: string): void {
  const entry = sharedWatches.get(key);
  if (!entry) return;
  const next = readOptionalFile(entry.watchPath);
  if (next === entry.content) return;
  const previous = entry.content;
  entry.content = next;
  for (const subscriber of entry.subscribers.values()) subscriber(previous, next);
}

function canonicalWatchKey(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
}

function displayWorkspacePath(path: string, workspaceRoot: string): string {
  const relationship = relative(workspaceRoot, path);
  if (!relationship || relationship === ".." || relationship.startsWith(`..${sep}`)) return resolve(path);
  return relationship.split(sep).join("/");
}

function coalesceChanges(changes: ResourceChange[]): ResourceChange[] {
  const grouped = new Map<string, ResourceChange>();
  for (const change of changes) {
    const existing = grouped.get(change.watchKey);
    if (!existing) {
      grouped.set(change.watchKey, { ...change });
      continue;
    }
    grouped.set(change.watchKey, {
      ...change,
      oldContent: existing.oldContent,
    });
  }
  return [...grouped.values()].sort((left, right) => left.revision - right.revision);
}

function formatResourceChange(change: ResourceChange): {
  text: string;
  coveredComponents: Array<"agentsFiles" | "skills">;
} | undefined {
  if (change.oldContent === change.newContent) return undefined;
  if (change.kind === "instruction-available") {
    return {
      text: `Nested Workspace instruction changed: ${change.displayPath}. Its body remains lazy; read it before working under that directory.`,
      coveredComponents: [],
    };
  }
  if (change.kind === "instruction-loaded") {
    return {
      text: [
        `Workspace instruction delta: ${change.displayPath}`,
        boundedPatch(change.displayPath, change.oldContent, change.newContent),
      ].join("\n"),
      coveredComponents: ["agentsFiles"],
    };
  }

  if (change.exposeSkillBody) {
    return {
      text: [
        `Active Skill delta: ${change.displayPath}`,
        boundedPatch(change.displayPath, change.oldContent, change.newContent),
      ].join("\n"),
      coveredComponents: skillMetadataChanged(change) ? ["skills"] : [],
    };
  }

  const metadata = formatSkillMetadataDelta(change);
  return {
    text: metadata ?? `Skill content changed: ${change.displayPath}. The Skill body was not injected because it was not active when it changed; reload it before next use.`,
    coveredComponents: metadata ? ["skills"] : [],
  };
}

function skillMetadataChanged(change: ResourceChange): boolean {
  try {
    const oldSummary = change.oldContent === undefined
      ? undefined
      : skillSummaryFromContent(change.oldContent, change.watchKey);
    const newSummary = change.newContent === undefined
      ? undefined
      : skillSummaryFromContent(change.newContent, change.watchKey);
    return JSON.stringify(oldSummary) !== JSON.stringify(newSummary);
  } catch {
    return true;
  }
}

function formatSkillMetadataDelta(change: ResourceChange): string | undefined {
  try {
    const oldSummary = change.oldContent === undefined
      ? undefined
      : skillSummaryFromContent(change.oldContent, change.watchKey);
    const newSummary = change.newContent === undefined
      ? undefined
      : skillSummaryFromContent(change.newContent, change.watchKey);
    if (JSON.stringify(oldSummary) === JSON.stringify(newSummary)) return undefined;
    if (!oldSummary) {
      return `Skill metadata added: ${change.displayPath}\n+ name: ${newSummary?.name ?? change.skillName ?? "unknown"}\n+ description: ${newSummary?.description ?? ""}\n+ disable-model-invocation: ${newSummary?.disableModelInvocation === true}`;
    }
    if (!newSummary) return `Skill removed: ${change.displayPath}`;
    const lines = [`Skill metadata delta: ${change.displayPath}`];
    for (const field of ["name", "description", "disableModelInvocation"] as const) {
      if (oldSummary[field] === newSummary[field]) continue;
      const label = field === "disableModelInvocation" ? "disable-model-invocation" : field;
      lines.push(`- ${label}: ${String(oldSummary[field])}`);
      lines.push(`+ ${label}: ${String(newSummary[field])}`);
    }
    return lines.join("\n");
  } catch {
    return `Skill metadata became unreadable or changed format: ${change.displayPath}. Reload it before next use.`;
  }
}

function boundedPatch(path: string, oldContent: string | undefined, newContent: string | undefined): string {
  const patch = createTwoFilesPatch(
    path,
    path,
    oldContent ?? "",
    newContent ?? "",
    oldContent === undefined ? "missing" : "before",
    newContent === undefined ? "missing" : "after",
    { context: 1 },
  );
  const lines = patch.split("\n");
  const hunk = lines.slice(Math.max(0, lines.findIndex((line) => line.startsWith("@@"))));
  const compact = hunk.join("\n").trimEnd();
  if (compact.length <= MAX_PATCH_CHARACTERS) return compact;
  return `${compact.slice(0, MAX_PATCH_CHARACTERS)}\n[delta truncated]`;
}
