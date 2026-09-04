import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { SegmentedLogStore } from "../activity/storage/segmented-log.js";
import { resolveStateRelativePath } from "../activity/storage/paths.js";
import { databasePath } from "../runtime/state/db/client.js";
import { acquireRuntimeLease } from "../runtime/state/runtime-lease.js";
import type { MaintenanceRetentionPolicy } from "./maintenance.js";
import {
  bashBytesExpression,
  columnExists,
  eligibleActivityCte,
  tableExists,
} from "./maintenance-retention.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WORKSPACE_ID = /^(?:ws|rws|cws)_[a-z0-9]+$/i;
const REVIEW_REF = /^refs\/forgerelay\/review\/([^/]+)\/(?:open|baseline)$/;

export interface MaintenancePruneReport {
  stateDir: string;
  cutoff: string | null;
  historicalAuthorized: boolean;
  administrativeAuthorized: boolean;
  protected: {
    persistentWorkspaceIdentity: true;
    workspaceTasks: true;
    namedCheckpoints: true;
    managedBranches: true;
    runningBashStreams: number;
    activeSubagentRuns: number;
  };
  removed: {
    activities: number;
    activityEvents: number;
    activityPayloadBytes: number;
    bashStreams: number;
    bashPayloadBytes: number;
    hostTurns: number;
    reviewRefs: number;
    orphanWorkspaceStateDirectories: number;
  };
  cleanup: {
    removedSegmentFiles: number;
    retainedActivityPayloadsRewritten: number;
  };
  result: "noop" | "pruned";
}

interface ActivityPayloadRow {
  id: string;
  payload_file: string;
  payload_offset: number;
  payload_length: number;
}

interface BashPayloadRow {
  id: string;
  log_file: string | null;
  command_file: string | null;
  error_file: string | null;
}

interface HistoricalPruneResult {
  activities: number;
  activityEvents: number;
  activityPayloadBytes: number;
  bashStreams: number;
  bashPayloadBytes: number;
  hostTurns: number;
  removedSegmentFiles: number;
  retainedActivityPayloadsRewritten: number;
}

export function pruneMaintenanceState(
  stateDir: string,
  policy: MaintenanceRetentionPolicy,
  now = new Date(),
): MaintenancePruneReport {
  const cutoff = policy.historyDays === null
    ? null
    : new Date(now.getTime() - policy.historyDays * DAY_MS).toISOString();
  const historicalAuthorized = cutoff !== null;
  const administrativeAuthorized = policy.orphanedAdministrativeState;
  const emptyRemoved = {
    activities: 0,
    activityEvents: 0,
    activityPayloadBytes: 0,
    bashStreams: 0,
    bashPayloadBytes: 0,
    hostTurns: 0,
    reviewRefs: 0,
    orphanWorkspaceStateDirectories: 0,
  };
  const emptyCleanup = { removedSegmentFiles: 0, retainedActivityPayloadsRewritten: 0 };

  if (!historicalAuthorized && !administrativeAuthorized) {
    return {
      stateDir,
      cutoff,
      historicalAuthorized,
      administrativeAuthorized,
      protected: emptyProtectedCounts(),
      removed: emptyRemoved,
      cleanup: emptyCleanup,
      result: "noop",
    };
  }
  if (!existsSync(stateDir)) {
    return {
      stateDir,
      cutoff,
      historicalAuthorized,
      administrativeAuthorized,
      protected: emptyProtectedCounts(),
      removed: emptyRemoved,
      cleanup: emptyCleanup,
      result: "noop",
    };
  }

  const lease = acquireRuntimeLease(stateDir);
  try {
    const protectedCounts = readProtectedCounts(stateDir);
    const historical = historicalAuthorized && cutoff
      ? pruneHistoricalState(stateDir, cutoff)
      : emptyHistoricalPruneResult();
    const administrative = administrativeAuthorized
      ? pruneAdministrativeState(stateDir)
      : { reviewRefs: 0, orphanWorkspaceStateDirectories: 0 };
    const removed = {
      activities: historical.activities,
      activityEvents: historical.activityEvents,
      activityPayloadBytes: historical.activityPayloadBytes,
      bashStreams: historical.bashStreams,
      bashPayloadBytes: historical.bashPayloadBytes,
      hostTurns: historical.hostTurns,
      reviewRefs: administrative.reviewRefs,
      orphanWorkspaceStateDirectories: administrative.orphanWorkspaceStateDirectories,
    };
    const removedTotal = Object.values(removed).reduce((total, value) => total + value, 0);
    return {
      stateDir,
      cutoff,
      historicalAuthorized,
      administrativeAuthorized,
      protected: protectedCounts,
      removed,
      cleanup: {
        removedSegmentFiles: historical.removedSegmentFiles,
        retainedActivityPayloadsRewritten: historical.retainedActivityPayloadsRewritten,
      },
      result: removedTotal > 0 ? "pruned" : "noop",
    };
  } finally {
    lease.release();
  }
}

export function printMaintenancePruneReport(report: MaintenancePruneReport): void {
  console.log("ForgeRelay maintenance prune");
  console.log(`State directory: ${report.stateDir}`);
  console.log(`Historical retention: ${report.historicalAuthorized ? `authorized before ${report.cutoff}` : "not authorized (unlimited)"}`);
  console.log(`Orphan administrative cleanup: ${report.administrativeAuthorized ? "authorized" : "not authorized"}`);
  console.log(`Removed Activity/Audit: ${report.removed.activities} activities / ${report.removed.activityEvents} events / ${formatBytes(report.removed.activityPayloadBytes)} payload`);
  console.log(`Removed durable Bash: ${report.removed.bashStreams} streams / ${formatBytes(report.removed.bashPayloadBytes)}`);
  console.log(`Removed Host Turns: ${report.removed.hostTurns}`);
  console.log(`Removed administrative state: ${report.removed.reviewRefs} review refs / ${report.removed.orphanWorkspaceStateDirectories} orphan Workspace directories`);
  console.log(`Protected active state: ${report.protected.runningBashStreams} running Bash streams / ${report.protected.activeSubagentRuns} active Subagent Runs`);
  console.log("Protected persistent state: Workspace identity, Task Lists, named checkpoints, and managed branches");
  if (report.result === "noop") console.log("No authorized eligible state was removed.");
}

function pruneHistoricalState(stateDir: string, cutoff: string): HistoricalPruneResult {
  const path = databasePath(stateDir);
  if (!existsSync(path)) return emptyHistoricalPruneResult();
  const sqlite = new Database(path, { fileMustExist: true });
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const newPrefixes = new Set<string>();
  const oldActivityPrefixes = new Set<string>();
  const oldBashPrefixes = new Set<string>();
  let result = emptyHistoricalPruneResult();

  try {
    requireHistoricalSchema(sqlite);
    const logs = new SegmentedLogStore(stateDir);
    const mutate = sqlite.transaction(() => {
      createEligibilityTables(sqlite, cutoff);
      result = historicalCounts(sqlite);
      if (result.activities === 0 && result.bashStreams === 0 && result.hostTurns === 0) return;

      const bashRows = sqlite.prepare(
        `select id, log_file, command_file, error_file
           from bash_output_streams
          where id in (select output_id from maintenance_eligible_bash)`,
      ).all() as BashPayloadRow[];
      for (const row of bashRows) {
        for (const prefix of [row.log_file, row.command_file, row.error_file]) {
          if (prefix) oldBashPrefixes.add(prefix);
        }
      }

      const affectedPrefixes = sqlite.prepare(
        `select distinct payload_file as prefix
           from activity_audit_events
          where activity_id in (select activity_id from maintenance_eligible_activities)
            and payload_file is not null`,
      ).all() as Array<{ prefix: string }>;
      for (const { prefix } of affectedPrefixes) {
        oldActivityPrefixes.add(prefix);
        const retained = sqlite.prepare(
          `select id, payload_file, payload_offset, payload_length
             from activity_audit_events
            where payload_file = ?
              and payload_offset is not null
              and payload_length is not null
              and activity_id not in (select activity_id from maintenance_eligible_activities)
            order by rowid asc`,
        ).all(prefix) as ActivityPayloadRow[];
        if (retained.length === 0) continue;

        const sourcePrefix = resolveStateRelativePath(stateDir, prefix);
        const compactPrefix = join(
          dirname(sourcePrefix),
          `${basename(sourcePrefix)}.retained-${randomBytes(6).toString("hex")}`,
        );
        for (const row of retained) {
          const bytes = logs.read({
            prefix: row.payload_file,
            offset: row.payload_offset,
            length: row.payload_length,
          });
          const next = logs.append(compactPrefix, bytes);
          newPrefixes.add(next.prefix);
          sqlite.prepare(
            `update activity_audit_events
                set payload_file = ?, payload_offset = ?, payload_length = ?
              where id = ?`,
          ).run(next.prefix, next.offset, next.length, row.id);
          result.retainedActivityPayloadsRewritten += 1;
        }
      }

      sqlite.prepare(
        "delete from bash_output_streams where id in (select output_id from maintenance_eligible_bash)",
      ).run();
      sqlite.prepare(
        "delete from activity_audit_events where activity_id in (select activity_id from maintenance_eligible_activities)",
      ).run();
      sqlite.prepare(
        "delete from activity_host_turns where turn_id in (select turn_id from maintenance_eligible_turns)",
      ).run();
    });

    try {
      mutate.immediate();
    } catch (error) {
      for (const prefix of newPrefixes) removeSegmentedPrefix(stateDir, prefix);
      throw error;
    }

    for (const prefix of oldActivityPrefixes) {
      if (activityPrefixReferenced(sqlite, prefix)) continue;
      result.removedSegmentFiles += removeSegmentedPrefix(stateDir, prefix);
    }
    for (const prefix of oldBashPrefixes) {
      if (bashPrefixReferenced(sqlite, prefix)) continue;
      result.removedSegmentFiles += removeSegmentedPrefix(stateDir, prefix);
    }
    return result;
  } finally {
    sqlite.close();
  }
}

function createEligibilityTables(sqlite: Database.Database, cutoff: string): void {
  sqlite.exec(`
    drop table if exists temp.maintenance_eligible_activities;
    drop table if exists temp.maintenance_eligible_turns;
    drop table if exists temp.maintenance_eligible_bash;
    create temp table maintenance_eligible_activities (activity_id text primary key);
    create temp table maintenance_eligible_turns (turn_id text primary key);
    create temp table maintenance_eligible_bash (output_id text primary key);
  `);
  const eligible = eligibleActivityCte(sqlite);
  sqlite.prepare(
    `${eligible}
     insert into maintenance_eligible_activities(activity_id)
     select activity_id from eligible_activities`,
  ).run(cutoff);
  sqlite.prepare(
    `${eligible}
     insert into maintenance_eligible_turns(turn_id)
     select turn_id from eligible_turns`,
  ).run(cutoff);
  sqlite.prepare(
    `insert into maintenance_eligible_bash(output_id)
     select id from bash_output_streams
      where status <> 'running'
        and activity_id in (select activity_id from maintenance_eligible_activities)`,
  ).run();
}

function historicalCounts(sqlite: Database.Database): HistoricalPruneResult {
  const activity = sqlite.prepare(
    `select count(*) as events,
            count(distinct activity_id) as activities,
            coalesce(sum(payload_length), 0) as bytes
       from activity_audit_events
      where activity_id in (select activity_id from maintenance_eligible_activities)`,
  ).get() as { events: number; activities: number; bytes: number };
  const bash = sqlite.prepare(
    `select count(*) as streams, coalesce(sum(${bashBytesExpression(sqlite)}), 0) as bytes
       from bash_output_streams
      where id in (select output_id from maintenance_eligible_bash)`,
  ).get() as { streams: number; bytes: number };
  const hostTurns = Number((sqlite.prepare(
    "select count(*) as count from maintenance_eligible_turns",
  ).get() as { count: number }).count);
  return {
    activities: activity.activities,
    activityEvents: activity.events,
    activityPayloadBytes: activity.bytes,
    bashStreams: bash.streams,
    bashPayloadBytes: bash.bytes,
    hostTurns,
    removedSegmentFiles: 0,
    retainedActivityPayloadsRewritten: 0,
  };
}

function requireHistoricalSchema(sqlite: Database.Database): void {
  for (const table of ["activity_audit_events", "activity_host_turns", "bash_output_streams"]) {
    if (!tableExists(sqlite, table)) {
      throw new Error(`ForgeRelay state is missing ${table}; start the current ForgeRelay once before pruning history.`);
    }
  }
  for (const column of ["payload_file", "payload_offset", "payload_length"]) {
    if (!columnExists(sqlite, "activity_audit_events", column)) {
      throw new Error(`ForgeRelay Activity state is missing ${column}; start the current ForgeRelay once before pruning history.`);
    }
  }
}

function readProtectedCounts(stateDir: string): MaintenancePruneReport["protected"] {
  const path = databasePath(stateDir);
  if (!existsSync(path)) return emptyProtectedCounts();
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  sqlite.pragma("query_only = ON");
  try {
    const runningBashStreams = tableExists(sqlite, "bash_output_streams")
      ? Number((sqlite.prepare(
        "select count(*) as count from bash_output_streams where status = 'running'",
      ).get() as { count: number }).count)
      : 0;
    const activeSubagentRuns = tableExists(sqlite, "local_agent_sessions")
      ? Number((sqlite.prepare(
        columnExists(sqlite, "local_agent_sessions", "active_run_id")
          ? "select count(*) as count from local_agent_sessions where status = 'running' or active_run_id is not null"
          : "select count(*) as count from local_agent_sessions where status = 'running'",
      ).get() as { count: number }).count)
      : 0;
    return {
      ...emptyProtectedCounts(),
      runningBashStreams,
      activeSubagentRuns,
    };
  } finally {
    sqlite.close();
  }
}

function emptyProtectedCounts(): MaintenancePruneReport["protected"] {
  return {
    persistentWorkspaceIdentity: true,
    workspaceTasks: true,
    namedCheckpoints: true,
    managedBranches: true,
    runningBashStreams: 0,
    activeSubagentRuns: 0,
  };
}

function pruneAdministrativeState(stateDir: string): {
  reviewRefs: number;
  orphanWorkspaceStateDirectories: number;
} {
  const protectedIds = protectedWorkspaceIds(stateDir);
  let reviewRefs = 0;
  for (const repository of workspaceRepositories(stateDir)) {
    const listed = gitOutput(repository, ["for-each-ref", "--format=%(refname)", "refs/forgerelay/review"]);
    if (listed === undefined) continue;
    for (const ref of listed.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const match = REVIEW_REF.exec(ref);
      if (!match || protectedIds.has(match[1]!)) continue;
      const removed = spawnSync("git", ["-C", repository, "update-ref", "-d", ref], {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
      });
      if (removed.error || removed.status !== 0) {
        throw new Error(`Unable to remove orphan ForgeRelay review ref ${ref}: ${removed.stderr.trim() || removed.error?.message || "git update-ref failed"}`);
      }
      reviewRefs += 1;
    }
  }

  let orphanWorkspaceStateDirectories = 0;
  const workspacesDir = join(stateDir, "workspaces");
  let entries: string[];
  try {
    entries = readdirSync(workspacesDir);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { reviewRefs, orphanWorkspaceStateDirectories };
    throw error;
  }
  const persistentIds = persistentWorkspaceIds(stateDir);
  for (const name of entries) {
    if (!WORKSPACE_ID.test(name) || persistentIds.has(name)) continue;
    const path = join(workspacesDir, name);
    if (!isDirectoryEmpty(path)) continue;
    try {
      rmdirSync(path);
      orphanWorkspaceStateDirectories += 1;
    } catch (error) {
      if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY")) throw error;
    }
  }
  return { reviewRefs, orphanWorkspaceStateDirectories };
}

function protectedWorkspaceIds(stateDir: string): Set<string> {
  const ids = persistentWorkspaceIds(stateDir);
  const workspacesDir = join(stateDir, "workspaces");
  let entries: string[];
  try {
    entries = readdirSync(workspacesDir);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return ids;
    throw error;
  }
  for (const name of entries) {
    if (!WORKSPACE_ID.test(name)) continue;
    const dir = join(workspacesDir, name);
    if (!isDirectoryEmpty(dir)) ids.add(name);
  }
  return ids;
}

function persistentWorkspaceIds(stateDir: string): Set<string> {
  const ids = new Set<string>();
  const path = databasePath(stateDir);
  if (!existsSync(path)) return ids;
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  sqlite.pragma("query_only = ON");
  try {
    if (tableExists(sqlite, "workspace_sessions")) {
      const rows = sqlite.prepare("select id from workspace_sessions").all() as Array<{ id: string }>;
      for (const row of rows) ids.add(row.id);
    }
    if (tableExists(sqlite, "workspace_session_aliases")) {
      const rows = sqlite.prepare("select alias_id from workspace_session_aliases").all() as Array<{ alias_id: string }>;
      for (const row of rows) ids.add(row.alias_id);
    }
  } finally {
    sqlite.close();
  }
  return ids;
}

function workspaceRepositories(stateDir: string): Set<string> {
  const repositories = new Set<string>();
  const path = databasePath(stateDir);
  if (!existsSync(path)) return repositories;
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  sqlite.pragma("query_only = ON");
  try {
    if (!tableExists(sqlite, "workspace_sessions")) return repositories;
    const rows = sqlite.prepare(
      "select root, source_root from workspace_sessions",
    ).all() as Array<{ root: string; source_root: string | null }>;
    for (const row of rows) {
      const candidate = row.source_root ?? row.root;
      if (!candidate || !existsSync(candidate)) continue;
      const gitRoot = gitOutput(candidate, ["rev-parse", "--show-toplevel"]);
      if (gitRoot) repositories.add(gitRoot);
    }
    return repositories;
  } finally {
    sqlite.close();
  }
}

function activityPrefixReferenced(sqlite: Database.Database, prefix: string): boolean {
  return Boolean(sqlite.prepare(
    "select 1 from activity_audit_events where payload_file = ? limit 1",
  ).get(prefix));
}

function bashPrefixReferenced(sqlite: Database.Database, prefix: string): boolean {
  return Boolean(sqlite.prepare(
    `select 1 from bash_output_streams
      where log_file = ? or command_file = ? or error_file = ?
      limit 1`,
  ).get(prefix, prefix, prefix));
}

function removeSegmentedPrefix(stateDir: string, prefix: string): number {
  const prefixPath = resolveStateRelativePath(stateDir, prefix);
  const directory = dirname(prefixPath);
  const stem = basename(prefixPath);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return 0;
    throw error;
  }
  const pattern = new RegExp(`^${escapeRegExp(stem)}\\.\\d{6}\\.log$`);
  let removed = 0;
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    rmSync(join(directory, entry), { force: true });
    removed += 1;
  }
  return removed;
}

function isDirectoryEmpty(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return false;
    throw error;
  }
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

function emptyHistoricalPruneResult(): HistoricalPruneResult {
  return {
    activities: 0,
    activityEvents: 0,
    activityPayloadBytes: 0,
    bashStreams: 0,
    bashPayloadBytes: 0,
    hostTurns: 0,
    removedSegmentFiles: 0,
    retainedActivityPayloadsRewritten: 0,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
