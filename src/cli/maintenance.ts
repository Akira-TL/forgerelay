import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expandHomePath } from "../mcp/filesystem/roots.js";
import { databasePath } from "../runtime/state/db/client.js";
import {
  bashBytesExpression,
  columnExists,
  eligibleActivityCte,
  tableExists,
} from "./maintenance-retention.js";
import {
  printMaintenancePruneReport,
  pruneMaintenanceState,
} from "./maintenance-prune.js";
import {
  forgerelayConfigPath,
  type ForgeRelayRetentionConfig,
  type ForgeRelayUserConfig,
} from "../runtime/config/user-config.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RETENTION_DAYS = 36_500;
const MAX_CHECKPOINT_STATE_BYTES = 1024 * 1024;
const MAX_TASK_STATE_BYTES = 2 * 1024 * 1024;
const WORKSPACE_ID = /^(?:ws|rws|cws)_[a-z0-9]+$/i;
const REVIEW_REF = /^refs\/forgerelay\/review\/([^/]+)\/(?:open|baseline)$/;

export interface MaintenanceRetentionPolicy {
  historyDays: number | null;
  orphanedAdministrativeState: boolean;
}

interface AgeSummary {
  oldestAt: string | null;
  newestAt: string | null;
  oldestAgeDays: number | null;
  newestAgeDays: number | null;
}

export interface MaintenanceInspectReport {
  stateDir: string;
  database: "present" | "absent";
  policy: MaintenanceRetentionPolicy & {
    durableHistory: "unlimited" | string;
    namedCheckpoints: "protected-explicit-delete-only";
  };
  activityAudit: AgeSummary & {
    events: number;
    activities: number;
    payloadBytes: number;
    reclaimableEvents: number;
    reclaimableActivities: number;
    reclaimablePayloadBytes: number;
  };
  durableBashOutput: AgeSummary & {
    streams: number;
    runningStreams: number;
    payloadBytes: number;
    reclaimableStreams: number;
    reclaimablePayloadBytes: number;
  };
  hostTurns: AgeSummary & {
    turns: number;
    reclaimableTurns: number;
  };
  workspaceState: {
    sessions: number;
    activeSessions: number;
    closedSessions: number;
    managedSessions: number;
    missingManagedBacking: number;
    recoverableManagedBackingCandidates: number;
    manualInterventionManagedBackingCandidates: number;
    conversationBindings: number;
    contextDeliveries: number;
    loadedInstructionFiles: number;
  };
  namedCheckpoints: AgeSummary & {
    workspaces: number;
    checkpoints: number;
    stateBytes: number;
    invalidStateFiles: number;
    protected: true;
    reclaimableCheckpoints: 0;
  };
  workspaceTasks: {
    workspaces: number;
    lists: number;
    tasks: number;
    unfinishedTasks: number;
    stateBytes: number;
    invalidStateFiles: number;
    protected: true;
  };
  reviewRefs: {
    repositories: number;
    refs: number;
    orphanedRefs: number;
    reclaimableRefs: number;
    unavailableRepositories: number;
  };
  administrativeState: {
    orphanWorkspaceStateDirectories: number;
    protectedOrphanWorkspaceStateDirectories: number;
    reclaimableOrphanWorkspaceStateDirectories: number;
  };
}

interface WorkspaceRow {
  id: string;
  root: string;
  status: string;
  mode: string;
  source_root: string | null;
  branch: string | null;
  managed: string;
}

interface AggregateRow {
  count: number;
  oldest: string | null;
  newest: string | null;
}

interface ActivityAggregateRow extends AggregateRow {
  activities: number;
  bytes: number;
}

interface BashAggregateRow extends AggregateRow {
  running: number;
  bytes: number;
}

export function runMaintenanceCommand(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || ["help", "--help", "-h"].includes(subcommand)) {
    printMaintenanceHelp();
    return;
  }
  if (subcommand !== "inspect" && subcommand !== "prune") {
    throw new Error(`Unknown maintenance command: ${subcommand}`);
  }
  const json = rest.includes("--json");
  const unknown = rest.filter((value) => value !== "--json");
  if (unknown.length > 0) throw new Error(`Unknown maintenance ${subcommand} option: ${unknown[0]}`);

  const inspection = inspectMaintenanceState(env);
  if (subcommand === "inspect") {
    if (json) {
      console.log(JSON.stringify(inspection, null, 2));
      return;
    }
    printMaintenanceReport(inspection);
    return;
  }

  const report = pruneMaintenanceState(inspection.stateDir, inspection.policy);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printMaintenancePruneReport(report);
}

export function inspectMaintenanceState(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): MaintenanceInspectReport {
  const config = readMaintenanceConfig(env);
  const stateDir = resolveMaintenanceStateDir(config, env);
  const policy = resolveMaintenanceRetentionPolicy(config.retention, env);
  const cutoff = policy.historyDays === null
    ? null
    : new Date(now.getTime() - policy.historyDays * DAY_MS).toISOString();
  const databaseSnapshot = openReadOnlyDatabaseSnapshot(stateDir);
  const sqlite = databaseSnapshot?.sqlite;

  try {
    const workspaces = sqlite && tableExists(sqlite, "workspace_sessions")
      ? sqlite.prepare(
        "select id, root, status, mode, source_root, branch, managed from workspace_sessions order by id",
      ).all() as WorkspaceRow[]
      : [];
    const workspaceIds = new Set(workspaces.map((row) => row.id));
    if (sqlite && tableExists(sqlite, "workspace_session_aliases")) {
      const aliases = sqlite.prepare("select alias_id from workspace_session_aliases").all() as Array<{ alias_id: string }>;
      for (const alias of aliases) workspaceIds.add(alias.alias_id);
    }
    const protectedReviewWorkspaceIds = reviewProtectedWorkspaceIds(stateDir, workspaceIds);
    const activity = inspectActivity(sqlite, cutoff, now);
    const bash = inspectBash(sqlite, cutoff, now);
    const hostTurns = inspectHostTurns(sqlite, cutoff, now);
    const workspaceState = inspectWorkspaceState(sqlite, workspaces);
    const privateState = inspectPrivateWorkspaceState(stateDir, workspaceIds, now, policy);
    const reviewRefs = inspectReviewRefs(workspaces, protectedReviewWorkspaceIds, policy);

    return {
      stateDir,
      database: sqlite ? "present" : "absent",
      policy: {
        ...policy,
        durableHistory: policy.historyDays === null ? "unlimited" : `${policy.historyDays} days`,
        namedCheckpoints: "protected-explicit-delete-only",
      },
      activityAudit: activity,
      durableBashOutput: bash,
      hostTurns,
      workspaceState,
      namedCheckpoints: privateState.checkpoints,
      workspaceTasks: privateState.tasks,
      reviewRefs,
      administrativeState: privateState.administrative,
    };
  } finally {
    databaseSnapshot?.close();
  }
}

export function resolveMaintenanceRetentionPolicy(
  config: ForgeRelayRetentionConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MaintenanceRetentionPolicy {
  const configuredDays = env.FORGERELAY_RETENTION_HISTORY_DAYS ?? config?.historyDays;
  const historyDays = configuredDays === undefined || configuredDays === null || configuredDays === ""
    ? null
    : parseRetentionDays(configuredDays);
  const configuredOrphans = env.FORGERELAY_RETENTION_ORPHANED_ADMIN ?? config?.orphanedAdministrativeState;
  return {
    historyDays,
    orphanedAdministrativeState: parseOptionalBoolean(configuredOrphans) ?? false,
  };
}

function readMaintenanceConfig(env: NodeJS.ProcessEnv): ForgeRelayUserConfig {
  const path = forgerelayConfigPath(env);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ForgeRelayUserConfig;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    throw new Error(`Unable to read ForgeRelay maintenance config ${path}: ${errorMessage(error)}`);
  }
}

function resolveMaintenanceStateDir(config: ForgeRelayUserConfig, env: NodeJS.ProcessEnv): string {
  const configured = env.FORGERELAY_STATE_DIR ?? config.stateDir ?? join(homedir(), ".local", "share", "forgerelay");
  return resolve(expandHomePath(String(configured)));
}

interface ReadOnlyDatabaseSnapshot {
  sqlite: Database.Database;
  close(): void;
}

function openReadOnlyDatabaseSnapshot(stateDir: string): ReadOnlyDatabaseSnapshot | undefined {
  const source = databasePath(stateDir);
  if (!existsSync(source)) return undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = sqliteSourceFingerprint(source);
    const directory = mkdtempSync(join(tmpdir(), "forgerelay-maintenance-db-"));
    const snapshot = join(directory, "forgerelay.sqlite");
    try {
      copyFileSync(source, snapshot);
      const sourceWal = `${source}-wal`;
      if (existsSync(sourceWal)) copyFileSync(sourceWal, `${snapshot}-wal`);
      const after = sqliteSourceFingerprint(source);
      if (before !== after) {
        rmSync(directory, { recursive: true, force: true });
        continue;
      }
      const sqlite = new Database(snapshot, { readonly: true, fileMustExist: true });
      sqlite.pragma("query_only = ON");
      return {
        sqlite,
        close() {
          sqlite.close();
          rmSync(directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  throw new Error("ForgeRelay state changed repeatedly while creating a read-only maintenance snapshot; retry inspection.");
}

function sqliteSourceFingerprint(path: string): string {
  return [path, `${path}-wal`].map((candidate) => {
    try {
      const stats = statSync(candidate);
      return `${candidate}:${stats.size}:${stats.mtimeMs}`;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return `${candidate}:missing`;
      throw error;
    }
  }).join("|");
}

function inspectActivity(
  sqlite: Database.Database | undefined,
  cutoff: string | null,
  now: Date,
): MaintenanceInspectReport["activityAudit"] {
  if (!sqlite || !tableExists(sqlite, "activity_audit_events")) {
    return { ...emptyAge(), events: 0, activities: 0, payloadBytes: 0, reclaimableEvents: 0, reclaimableActivities: 0, reclaimablePayloadBytes: 0 };
  }
  const payload = columnExists(sqlite, "activity_audit_events", "payload_length")
    ? "coalesce(sum(payload_length), 0)"
    : "0";
  const row = sqlite.prepare(
    `select count(*) as count, count(distinct activity_id) as activities,
            ${payload} as bytes, min(created_at) as oldest, max(created_at) as newest
       from activity_audit_events`,
  ).get() as ActivityAggregateRow;
  if (cutoff === null) {
    return {
      ...ages(row.oldest, row.newest, now),
      events: row.count,
      activities: row.activities,
      payloadBytes: row.bytes,
      reclaimableEvents: 0,
      reclaimableActivities: 0,
      reclaimablePayloadBytes: 0,
    };
  }
  const eligible = eligibleActivityCte(sqlite);
  const reclaim = sqlite.prepare(
    `${eligible}
     select count(*) as count, count(distinct activity_id) as activities,
            ${payload} as bytes
       from activity_audit_events
      where activity_id in (select activity_id from eligible_activities)`,
  ).get(cutoff) as { count: number; activities: number; bytes: number };
  return {
    ...ages(row.oldest, row.newest, now),
    events: row.count,
    activities: row.activities,
    payloadBytes: row.bytes,
    reclaimableEvents: reclaim.count,
    reclaimableActivities: reclaim.activities,
    reclaimablePayloadBytes: reclaim.bytes,
  };
}

function inspectBash(
  sqlite: Database.Database | undefined,
  cutoff: string | null,
  now: Date,
): MaintenanceInspectReport["durableBashOutput"] {
  if (!sqlite || !tableExists(sqlite, "bash_output_streams")) {
    return { ...emptyAge(), streams: 0, runningStreams: 0, payloadBytes: 0, reclaimableStreams: 0, reclaimablePayloadBytes: 0 };
  }
  const bytesExpression = bashBytesExpression(sqlite);
  const row = sqlite.prepare(
    `select count(*) as count,
            coalesce(sum(case when status = 'running' then 1 else 0 end), 0) as running,
            coalesce(sum(${bytesExpression}), 0) as bytes,
            min(started_at) as oldest, max(started_at) as newest
       from bash_output_streams`,
  ).get() as BashAggregateRow;
  if (cutoff === null || !tableExists(sqlite, "activity_audit_events")) {
    return {
      ...ages(row.oldest, row.newest, now),
      streams: row.count,
      runningStreams: row.running,
      payloadBytes: row.bytes,
      reclaimableStreams: 0,
      reclaimablePayloadBytes: 0,
    };
  }
  const eligible = eligibleActivityCte(sqlite);
  const reclaim = sqlite.prepare(
    `${eligible}
     select count(*) as count, coalesce(sum(${bytesExpression}), 0) as bytes
       from bash_output_streams
      where status <> 'running'
        and activity_id in (select activity_id from eligible_activities)`,
  ).get(cutoff) as { count: number; bytes: number };
  return {
    ...ages(row.oldest, row.newest, now),
    streams: row.count,
    runningStreams: row.running,
    payloadBytes: row.bytes,
    reclaimableStreams: reclaim.count,
    reclaimablePayloadBytes: reclaim.bytes,
  };
}

function inspectHostTurns(
  sqlite: Database.Database | undefined,
  cutoff: string | null,
  now: Date,
): MaintenanceInspectReport["hostTurns"] {
  if (!sqlite || !tableExists(sqlite, "activity_host_turns")) {
    return { ...emptyAge(), turns: 0, reclaimableTurns: 0 };
  }
  const row = sqlite.prepare(
    "select count(*) as count, min(created_at) as oldest, max(created_at) as newest from activity_host_turns",
  ).get() as AggregateRow;
  let reclaimableTurns = 0;
  if (cutoff !== null) {
    if (tableExists(sqlite, "activity_audit_events")) {
      const eligible = eligibleActivityCte(sqlite);
      reclaimableTurns = Number((sqlite.prepare(
        `${eligible}
         select count(*) as count from eligible_turns`,
      ).get(cutoff) as { count: number }).count);
    } else {
      reclaimableTurns = Number((sqlite.prepare(
        "select count(*) as count from activity_host_turns where created_at < ?",
      ).get(cutoff) as { count: number }).count);
    }
  }
  return { ...ages(row.oldest, row.newest, now), turns: row.count, reclaimableTurns };
}

function inspectWorkspaceState(
  sqlite: Database.Database | undefined,
  workspaces: WorkspaceRow[],
): MaintenanceInspectReport["workspaceState"] {
  let missingManagedBacking = 0;
  let recoverableManagedBackingCandidates = 0;
  let manualInterventionManagedBackingCandidates = 0;
  for (const workspace of workspaces) {
    if (workspace.managed !== "true" || workspace.mode !== "worktree" || workspace.status !== "active") continue;
    if (existsSync(workspace.root)) continue;
    missingManagedBacking += 1;
    const source = workspace.source_root;
    const branch = workspace.branch;
    if (source && branch && existsSync(source) && gitRefExists(source, `refs/heads/${branch}`)) {
      recoverableManagedBackingCandidates += 1;
    } else {
      manualInterventionManagedBackingCandidates += 1;
    }
  }
  return {
    sessions: workspaces.length,
    activeSessions: workspaces.filter((row) => row.status === "active").length,
    closedSessions: workspaces.filter((row) => row.status !== "active").length,
    managedSessions: workspaces.filter((row) => row.managed === "true").length,
    missingManagedBacking,
    recoverableManagedBackingCandidates,
    manualInterventionManagedBackingCandidates,
    conversationBindings: tableCount(sqlite, "workspace_conversation_bindings"),
    contextDeliveries: tableCount(sqlite, "workspace_context_deliveries"),
    loadedInstructionFiles: tableCount(sqlite, "loaded_agent_files"),
  };
}

function inspectPrivateWorkspaceState(
  stateDir: string,
  workspaceIds: Set<string>,
  now: Date,
  policy: MaintenanceRetentionPolicy,
): {
  checkpoints: MaintenanceInspectReport["namedCheckpoints"];
  tasks: MaintenanceInspectReport["workspaceTasks"];
  administrative: MaintenanceInspectReport["administrativeState"];
} {
  const workspacesDir = join(stateDir, "workspaces");
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(workspacesDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return {
        checkpoints: { ...emptyAge(), workspaces: 0, checkpoints: 0, stateBytes: 0, invalidStateFiles: 0, protected: true, reclaimableCheckpoints: 0 },
        tasks: { workspaces: 0, lists: 0, tasks: 0, unfinishedTasks: 0, stateBytes: 0, invalidStateFiles: 0, protected: true },
        administrative: { orphanWorkspaceStateDirectories: 0, protectedOrphanWorkspaceStateDirectories: 0, reclaimableOrphanWorkspaceStateDirectories: 0 },
      };
    }
    throw error;
  }

  let checkpointWorkspaces = 0;
  let checkpoints = 0;
  let checkpointBytes = 0;
  let invalidCheckpointFiles = 0;
  let checkpointOldest: string | null = null;
  let checkpointNewest: string | null = null;
  let taskWorkspaces = 0;
  let taskLists = 0;
  let tasks = 0;
  let unfinishedTasks = 0;
  let taskBytes = 0;
  let invalidTaskFiles = 0;
  let orphanDirs = 0;
  let protectedOrphanDirs = 0;
  let reclaimableOrphanDirs = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = join(workspacesDir, entry.name);
    const checkpointPath = join(workspaceDir, "checkpoints.json");
    const taskPath = join(workspaceDir, "tasks.json");
    const hasCheckpointState = existsSync(checkpointPath);
    const hasTaskState = existsSync(taskPath);
    const hasPrivateState = readdirSync(workspaceDir).length > 0;

    if (hasCheckpointState) {
      checkpointWorkspaces += 1;
      const inspected = readBoundedJson(checkpointPath, MAX_CHECKPOINT_STATE_BYTES);
      checkpointBytes += inspected.bytes;
      if (!inspected.value || !Array.isArray((inspected.value as Record<string, unknown>).checkpoints)) {
        invalidCheckpointFiles += 1;
      } else {
        const values = (inspected.value as { checkpoints: Array<Record<string, unknown>> }).checkpoints;
        checkpoints += values.length;
        for (const checkpoint of values) {
          const createdAt = typeof checkpoint.createdAt === "string" ? checkpoint.createdAt : null;
          if (!createdAt) continue;
          checkpointOldest = earlier(checkpointOldest, createdAt);
          checkpointNewest = later(checkpointNewest, createdAt);
        }
      }
    }

    if (hasTaskState) {
      taskWorkspaces += 1;
      const inspected = readBoundedJson(taskPath, MAX_TASK_STATE_BYTES);
      taskBytes += inspected.bytes;
      const lists = inspected.value && Array.isArray((inspected.value as Record<string, unknown>).lists)
        ? (inspected.value as { lists: Array<Record<string, unknown>> }).lists
        : undefined;
      if (!lists) {
        invalidTaskFiles += 1;
      } else {
        taskLists += lists.length;
        for (const list of lists) {
          const listTasks = Array.isArray(list.tasks) ? list.tasks as Array<Record<string, unknown>> : [];
          tasks += listTasks.length;
          unfinishedTasks += listTasks.filter((task) => task.status !== "completed").length;
        }
      }
    }

    if (WORKSPACE_ID.test(entry.name) && !workspaceIds.has(entry.name)) {
      orphanDirs += 1;
      if (hasPrivateState) {
        protectedOrphanDirs += 1;
      } else if (policy.orphanedAdministrativeState) {
        reclaimableOrphanDirs += 1;
      }
    }
  }

  return {
    checkpoints: {
      ...ages(checkpointOldest, checkpointNewest, now),
      workspaces: checkpointWorkspaces,
      checkpoints,
      stateBytes: checkpointBytes,
      invalidStateFiles: invalidCheckpointFiles,
      protected: true,
      reclaimableCheckpoints: 0,
    },
    tasks: {
      workspaces: taskWorkspaces,
      lists: taskLists,
      tasks,
      unfinishedTasks,
      stateBytes: taskBytes,
      invalidStateFiles: invalidTaskFiles,
      protected: true,
    },
    administrative: {
      orphanWorkspaceStateDirectories: orphanDirs,
      protectedOrphanWorkspaceStateDirectories: protectedOrphanDirs,
      reclaimableOrphanWorkspaceStateDirectories: reclaimableOrphanDirs,
    },
  };
}

function reviewProtectedWorkspaceIds(stateDir: string, workspaceIds: Set<string>): Set<string> {
  const protectedIds = new Set(workspaceIds);
  const workspacesDir = join(stateDir, "workspaces");
  let entries: Dirent[];
  try {
    entries = readdirSync(workspacesDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return protectedIds;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKSPACE_ID.test(entry.name)) continue;
    if (readdirSync(join(workspacesDir, entry.name)).length > 0) protectedIds.add(entry.name);
  }
  return protectedIds;
}

function inspectReviewRefs(
  workspaces: WorkspaceRow[],
  workspaceIds: Set<string>,
  policy: MaintenanceRetentionPolicy,
): MaintenanceInspectReport["reviewRefs"] {
  const roots = new Set<string>();
  for (const workspace of workspaces) {
    const candidate = workspace.source_root ?? workspace.root;
    if (candidate && existsSync(candidate)) roots.add(candidate);
  }
  const repositories = new Set<string>();
  const refs = new Set<string>();
  let unavailableRepositories = 0;
  for (const root of roots) {
    const gitRoot = gitOutput(root, ["rev-parse", "--show-toplevel"]);
    if (!gitRoot) {
      unavailableRepositories += 1;
      continue;
    }
    if (repositories.has(gitRoot)) continue;
    repositories.add(gitRoot);
    const listed = gitOutput(gitRoot, ["for-each-ref", "--format=%(refname)", "refs/forgerelay/review"]);
    if (listed === undefined) {
      unavailableRepositories += 1;
      continue;
    }
    for (const ref of listed.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      refs.add(`${gitRoot}\0${ref}`);
    }
  }
  let orphanedRefs = 0;
  for (const key of refs) {
    const ref = key.slice(key.indexOf("\0") + 1);
    const match = REVIEW_REF.exec(ref);
    if (match && !workspaceIds.has(match[1]!)) orphanedRefs += 1;
  }
  return {
    repositories: repositories.size,
    refs: refs.size,
    orphanedRefs,
    reclaimableRefs: policy.orphanedAdministrativeState ? orphanedRefs : 0,
    unavailableRepositories,
  };
}

function tableCount(sqlite: Database.Database | undefined, table: string): number {
  if (!sqlite || !tableExists(sqlite, table)) return 0;
  return Number((sqlite.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count);
}

function readBoundedJson(path: string, maxBytes: number): { value?: unknown; bytes: number } {
  try {
    const size = statSync(path).size;
    if (size > maxBytes) return { bytes: size };
    return { value: JSON.parse(readFileSync(path, "utf8")) as unknown, bytes: size };
  } catch {
    return { bytes: safeFileSize(path) };
  }
}

function gitRefExists(root: string, ref: string): boolean {
  const result = spawnSync("git", ["-C", root, "show-ref", "--verify", "--quiet", ref], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  return result.status === 0;
}

function gitOutput(root: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

function ages(oldestAt: string | null, newestAt: string | null, now: Date): AgeSummary {
  return {
    oldestAt,
    newestAt,
    oldestAgeDays: ageDays(oldestAt, now),
    newestAgeDays: ageDays(newestAt, now),
  };
}

function emptyAge(): AgeSummary {
  return { oldestAt: null, newestAt: null, oldestAgeDays: null, newestAgeDays: null };
}

function ageDays(value: string | null, now: Date): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / DAY_MS));
}

function earlier(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function later(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

function safeFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function parseRetentionDays(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RETENTION_DAYS) {
    throw new Error(`Retention historyDays must be an integer between 1 and ${MAX_RETENTION_DAYS}.`);
  }
  return parsed;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("Retention orphanedAdministrativeState must be a boolean.");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printMaintenanceReport(report: MaintenanceInspectReport): void {
  console.log(`ForgeRelay maintenance inspection`);
  console.log(`State directory: ${report.stateDir}`);
  console.log(`Database: ${report.database}`);
  console.log(`Retention: durable history ${report.policy.durableHistory}; orphaned administrative cleanup ${report.policy.orphanedAdministrativeState ? "enabled" : "disabled"}`);
  console.log(`Activity/Audit: ${report.activityAudit.activities} activities / ${report.activityAudit.events} events / ${formatBytes(report.activityAudit.payloadBytes)} payload; reclaimable ${report.activityAudit.reclaimableActivities} activities / ${formatBytes(report.activityAudit.reclaimablePayloadBytes)}`);
  console.log(`Durable Bash: ${report.durableBashOutput.streams} streams (${report.durableBashOutput.runningStreams} running) / ${formatBytes(report.durableBashOutput.payloadBytes)}; reclaimable ${report.durableBashOutput.reclaimableStreams} / ${formatBytes(report.durableBashOutput.reclaimablePayloadBytes)}`);
  console.log(`Host Turns: ${report.hostTurns.turns}; reclaimable ${report.hostTurns.reclaimableTurns}`);
  console.log(`Workspace state: ${report.workspaceState.sessions} sessions, ${report.workspaceState.conversationBindings} bindings, ${report.workspaceState.contextDeliveries} context deliveries; missing managed backing ${report.workspaceState.missingManagedBacking}`);
  console.log(`Named checkpoints: ${report.namedCheckpoints.checkpoints} across ${report.namedCheckpoints.workspaces} Workspaces — protected, explicit deletion only`);
  console.log(`Workspace Tasks: ${report.workspaceTasks.tasks} tasks across ${report.workspaceTasks.workspaces} Workspaces — protected`);
  console.log(`Review refs: ${report.reviewRefs.refs} across ${report.reviewRefs.repositories} repositories; orphaned ${report.reviewRefs.orphanedRefs}; reclaimable ${report.reviewRefs.reclaimableRefs}`);
  console.log(`Administrative state: ${report.administrativeState.orphanWorkspaceStateDirectories} orphan Workspace directories; reclaimable ${report.administrativeState.reclaimableOrphanWorkspaceStateDirectories}`);
  console.log(`Age range: activity ${formatAge(report.activityAudit)}; bash ${formatAge(report.durableBashOutput)}; turns ${formatAge(report.hostTurns)}; checkpoints ${formatAge(report.namedCheckpoints)}`);
}

function formatAge(value: AgeSummary): string {
  if (value.oldestAgeDays === null) return "none";
  return `${value.oldestAgeDays}d oldest / ${value.newestAgeDays ?? value.oldestAgeDays}d newest`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function printMaintenanceHelp(): void {
  console.log([
    "ForgeRelay maintenance",
    "",
    "Usage:",
    "  forgerelay maintenance inspect [--json]",
    "  forgerelay maintenance prune [--json]",
    "",
    "Inspection is read-only. Durable history is retained without an age limit unless retention.historyDays is explicitly configured.",
    "Prune is manual owner maintenance and removes only categories authorized by the configured retention policy.",
    "Named Workspace checkpoints and Workspace Tasks are protected from retention pruning.",
  ].join("\n"));
}
