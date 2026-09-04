import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type Database from "better-sqlite3";
import { SegmentedLogStore, segmentPath } from "../activity/storage/segmented-log.js";
import { openDatabase } from "../runtime/state/db/client.js";
import { acquireRuntimeLease } from "../runtime/state/runtime-lease.js";
import { inspectMaintenanceState } from "./maintenance.js";
import { pruneMaintenanceState } from "./maintenance-prune.js";

const OLD_START = "2026-07-01T00:00:00.000Z";
const OLD_DONE = "2026-07-01T00:01:00.000Z";
const RECENT = "2026-09-03T00:00:00.000Z";
const NOW = new Date("2026-09-04T12:00:00.000Z");
const POLICY = { historyDays: 7, orphanedAdministrativeState: true } as const;
const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("FORGERELAY_")),
) as NodeJS.ProcessEnv;

const root = mkdtempSync(join(tmpdir(), "forgerelay-maintenance-prune-"));
try {
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  const repo = join(root, "repo");
  const managedWorktree = join(root, "managed-worktree");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "ForgeRelay Test"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["worktree", "add", "-b", "forgerelay/managed", managedWorktree, "HEAD"]);
  const head = git(repo, ["rev-parse", "HEAD"]);

  writeFileSync(join(configDir, "config.json"), JSON.stringify({ stateDir, retention: POLICY }, null, 2));

  const database = openDatabase(stateDir);
  const logs = new SegmentedLogStore(stateDir);
  const activityPrefixPath = join(stateDir, "workspaces", "ws_live", "activity", "events");
  const payloads = new Map<string, { prefix: string; offset: number; length: number; bytes: Buffer }>();
  const appendPayload = (id: string, text: string) => {
    const bytes = Buffer.from(text, "utf8");
    const ref = logs.append(activityPrefixPath, bytes);
    payloads.set(id, { ...ref, bytes });
    return ref;
  };

  try {
    insertWorkspace(database.sqlite, "ws_live", repo, "checkout", false, null, null);
    insertWorkspace(database.sqlite, "ws_managed", managedWorktree, "worktree", true, repo, "forgerelay/managed");
    database.sqlite.prepare(
      "insert into workspace_session_aliases (alias_id, workspace_session_id) values (?, ?)",
    ).run("ws_alias", "ws_live");

    insertTurn(database.sqlite, "turn_prune", OLD_START);
    insertTurn(database.sqlite, "turn_running", OLD_START);
    insertTurn(database.sqlite, "turn_subagent", OLD_START);
    insertTurn(database.sqlite, "turn_nonterminal", OLD_START);
    insertTurn(database.sqlite, "turn_recent", RECENT);

    insertActivityPair(database.sqlite, appendPayload, "act_prune_a", "turn_prune", OLD_START, OLD_DONE);
    insertActivityPair(database.sqlite, appendPayload, "act_prune_b", "turn_prune", OLD_START, OLD_DONE);
    insertActivityPair(database.sqlite, appendPayload, "act_running", "turn_running", OLD_START, OLD_DONE);
    insertActivityPair(database.sqlite, appendPayload, "act_running_sibling", "turn_running", OLD_START, OLD_DONE);
    insertActivityPair(database.sqlite, appendPayload, "act_subagent", "turn_subagent", OLD_START, OLD_DONE);
    insertActivityStart(database.sqlite, appendPayload, "act_nonterminal", "turn_nonterminal", OLD_START);
    insertActivityPair(database.sqlite, appendPayload, "act_recent", "turn_recent", RECENT, RECENT);

    const eligibleCommand = logs.append(
      join(stateDir, "workspaces", "ws_live", "activity", "bash", "out_prune.command"),
      Buffer.from("echo prune", "utf8"),
    );
    const eligibleOutput = logs.append(
      join(stateDir, "workspaces", "ws_live", "activity", "bash", "out_prune.output"),
      Buffer.from("prunable output\n", "utf8"),
    );
    insertBash(database.sqlite, {
      id: "out_prune",
      activityId: "act_prune_a",
      turnId: "turn_prune",
      status: "done",
      startedAt: OLD_START,
      finishedAt: OLD_DONE,
      output: eligibleOutput,
      command: eligibleCommand,
      outputBytes: Buffer.byteLength("prunable output\n"),
      commandLength: Buffer.byteLength("echo prune"),
    });

    const runningCommand = logs.append(
      join(stateDir, "workspaces", "ws_live", "activity", "bash", "out_running.command"),
      Buffer.from("sleep 100", "utf8"),
    );
    const runningOutput = logs.append(
      join(stateDir, "workspaces", "ws_live", "activity", "bash", "out_running.output"),
      Buffer.from("still running\n", "utf8"),
    );
    insertBash(database.sqlite, {
      id: "out_running",
      activityId: "act_running",
      turnId: "turn_running",
      status: "running",
      startedAt: OLD_START,
      finishedAt: null,
      output: runningOutput,
      command: runningCommand,
      outputBytes: Buffer.byteLength("still running\n"),
      commandLength: Buffer.byteLength("sleep 100"),
    });

    database.sqlite.prepare(
      `insert into local_agent_sessions
        (id, workspace_id, workspace_root, profile_name, provider, status,
         active_run_id, active_activity_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "agent_active", "ws_live", repo, "default", "test", "running",
      "run_active", "act_subagent", OLD_START, OLD_DONE,
    );
  } finally {
    database.close();
  }

  const liveStateDir = join(stateDir, "workspaces", "ws_live");
  const aliasStateDir = join(stateDir, "workspaces", "ws_alias");
  const privateStateDir = join(stateDir, "workspaces", "ws_private");
  const taskOrphanDir = join(stateDir, "workspaces", "ws_tasks");
  const checkpointOrphanDir = join(stateDir, "workspaces", "ws_checkpoint");
  const activityOrphanDir = join(stateDir, "workspaces", "ws_activity");
  const emptyOrphanDir = join(stateDir, "workspaces", "ws_empty");
  mkdirSync(liveStateDir, { recursive: true });
  mkdirSync(aliasStateDir, { recursive: true });
  mkdirSync(privateStateDir, { recursive: true });
  mkdirSync(taskOrphanDir, { recursive: true });
  mkdirSync(checkpointOrphanDir, { recursive: true });
  mkdirSync(join(activityOrphanDir, "activity"), { recursive: true });
  mkdirSync(emptyOrphanDir, { recursive: true });
  writeFileSync(join(liveStateDir, "tasks.json"), JSON.stringify({ version: 1, revision: 1, lists: [{ id: "tl_live", name: "live", state: "active", revision: 1, tasks: [{ id: "tsk_live", status: "in_progress", subject: "keep", content: "" }] }] }, null, 2));
  writeFileSync(join(liveStateDir, "checkpoints.json"), JSON.stringify({ version: 1, revision: 1, gitCommonDir: join(repo, ".git"), checkpoints: [{ id: "cp_live", name: "keep", createdAt: OLD_START, commit: head, baseHead: head, summary: { files: 0, additions: 0, removals: 0 } }] }, null, 2));
  writeFileSync(join(privateStateDir, "keep.bin"), "unknown private state\n");
  writeFileSync(join(taskOrphanDir, "tasks.json"), "{}\n");
  writeFileSync(join(checkpointOrphanDir, "checkpoints.json"), "{}\n");
  writeFileSync(join(activityOrphanDir, "activity", "keep.log"), "keep\n");

  for (const workspaceId of ["ws_live", "ws_alias", "ws_private", "ws_orphan"]) {
    git(repo, ["update-ref", `refs/forgerelay/review/${workspaceId}/open`, head]);
  }

  const taskBefore = readFileSync(join(liveStateDir, "tasks.json"));
  const checkpointBefore = readFileSync(join(liveStateDir, "checkpoints.json"));
  const worktreesBefore = git(repo, ["worktree", "list", "--porcelain"]);
  const managedBranchBefore = git(repo, ["rev-parse", "forgerelay/managed"]);
  const identityBefore = readIdentityRows(stateDir);
  const refsBeforeNoPolicy = reviewRefs(repo);
  const treeBeforeNoPolicy = snapshotTree(stateDir);

  const noPolicy = pruneMaintenanceState(stateDir, { historyDays: null, orphanedAdministrativeState: false }, NOW);
  assert.equal(noPolicy.result, "noop");
  assert.deepEqual(noPolicy.removed, zeroRemoved());
  assert.deepEqual(snapshotTree(stateDir), treeBeforeNoPolicy, "no-policy prune must not mutate state");
  assert.equal(reviewRefs(repo), refsBeforeNoPolicy, "no-policy prune must not mutate review refs");

  const leaseSnapshot = snapshotTree(stateDir);
  const lease = acquireRuntimeLease(stateDir);
  try {
    assert.throws(
      () => pruneMaintenanceState(stateDir, POLICY, NOW),
      /ForgeRelay state is already in use by PID/,
      "an active serve/runtime lease must block destructive prune",
    );
  } finally {
    lease.release();
  }
  assert.deepEqual(snapshotTree(stateDir), leaseSnapshot, "a rejected concurrent prune must leave state unchanged");
  assert.equal(reviewRefs(repo), refsBeforeNoPolicy, "a rejected concurrent prune must leave refs unchanged");

  const env = {
    ...process.env,
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_STATE_DIR: stateDir,
  };
  const before = inspectMaintenanceState(env, NOW);
  assert.equal(before.activityAudit.reclaimableActivities, 2);
  assert.equal(before.hostTurns.reclaimableTurns, 1);
  assert.equal(before.durableBashOutput.reclaimableStreams, 1);
  assert.equal(before.reviewRefs.reclaimableRefs, 1);
  assert.equal(before.administrativeState.reclaimableOrphanWorkspaceStateDirectories, 1);

  const originalSharedPrefix = payloads.get("act_prune_a:start")!.prefix;
  const originalSharedSegment = segmentPath(join(stateDir, originalSharedPrefix), 0);
  assert.equal(existsSync(originalSharedSegment), true, "fixture must share one Activity payload segment before prune");
  const retainedPayload = payloads.get("act_running_sibling:done")!;

  const first = runPruneCli(configDir, stateDir);
  assert.equal(first.result, "pruned");
  assert.equal(first.removed.activities, before.activityAudit.reclaimableActivities);
  assert.equal(first.removed.activityEvents, before.activityAudit.reclaimableEvents);
  assert.equal(first.removed.activityPayloadBytes, before.activityAudit.reclaimablePayloadBytes);
  assert.equal(first.removed.bashStreams, before.durableBashOutput.reclaimableStreams);
  assert.equal(first.removed.bashPayloadBytes, before.durableBashOutput.reclaimablePayloadBytes);
  assert.equal(first.removed.hostTurns, before.hostTurns.reclaimableTurns);
  assert.equal(first.removed.reviewRefs, before.reviewRefs.reclaimableRefs);
  assert.equal(
    first.removed.orphanWorkspaceStateDirectories,
    before.administrativeState.reclaimableOrphanWorkspaceStateDirectories,
  );
  assert.equal(first.protected.runningBashStreams, 1);
  assert.equal(first.protected.activeSubagentRuns, 1);
  assert.ok(first.cleanup.retainedActivityPayloadsRewritten >= 1, "retained payloads sharing a pruned segment must be compacted");
  assert.ok(first.cleanup.removedSegmentFiles >= 1, "unreferenced old segments must be removed after compaction");

  const afterDatabase = openDatabase(stateDir);
  try {
    assert.equal(count(afterDatabase.sqlite, "activity_audit_events", "activity_id in ('act_prune_a','act_prune_b')"), 0);
    assert.equal(count(afterDatabase.sqlite, "activity_host_turns", "turn_id = 'turn_prune'"), 0);
    assert.equal(count(afterDatabase.sqlite, "bash_output_streams", "id = 'out_prune'"), 0);

    assert.equal(count(afterDatabase.sqlite, "activity_audit_events", "activity_id in ('act_running','act_running_sibling')"), 4, "one running Bash must protect its whole Host Turn cohort");
    assert.equal(count(afterDatabase.sqlite, "activity_host_turns", "turn_id = 'turn_running'"), 1);
    assert.equal(count(afterDatabase.sqlite, "bash_output_streams", "id = 'out_running' and status = 'running'"), 1);
    assert.equal(count(afterDatabase.sqlite, "activity_audit_events", "activity_id = 'act_subagent'"), 2, "active Subagent Run must protect its Activity");
    assert.equal(count(afterDatabase.sqlite, "activity_host_turns", "turn_id = 'turn_subagent'"), 1);
    assert.equal(count(afterDatabase.sqlite, "activity_audit_events", "activity_id = 'act_nonterminal'"), 1, "nonterminal old Activity must be retained");
    assert.equal(count(afterDatabase.sqlite, "activity_audit_events", "activity_id = 'act_recent'"), 2, "recent Activity must be retained");

    const row = afterDatabase.sqlite.prepare(
      "select payload_file, payload_offset, payload_length from activity_audit_events where id = ?",
    ).get("evt_act_running_sibling_done") as { payload_file: string; payload_offset: number; payload_length: number };
    assert.notEqual(row.payload_file, originalSharedPrefix, "retained payload must move away from a segment containing pruned bytes");
    const compacted = new SegmentedLogStore(stateDir).read({
      prefix: row.payload_file,
      offset: row.payload_offset,
      length: row.payload_length,
    });
    assert.deepEqual(compacted, retainedPayload.bytes, "retained Activity payload bytes must remain readable after compaction");
  } finally {
    afterDatabase.close();
  }
  assert.equal(existsSync(originalSharedSegment), false, "old shared Activity segment must be removed once no rows reference it");

  assert.equal(existsSync(emptyOrphanDir), false, "empty orphan Workspace state may be deleted when explicitly authorized");
  assert.equal(existsSync(privateStateDir), true, "unknown non-empty private Workspace state must be protected");
  assert.equal(existsSync(taskOrphanDir), true, "orphan Task state must be protected");
  assert.equal(existsSync(checkpointOrphanDir), true, "orphan checkpoint state must be protected");
  assert.equal(existsSync(activityOrphanDir), true, "orphan Activity state must be protected");
  assert.equal(existsSync(aliasStateDir), true, "persistent alias Workspace state must be protected even when empty");

  const refsAfter = reviewRefs(repo);
  assert.match(refsAfter, /refs\/forgerelay\/review\/ws_live\/open/);
  assert.match(refsAfter, /refs\/forgerelay\/review\/ws_alias\/open/);
  assert.match(refsAfter, /refs\/forgerelay\/review\/ws_private\/open/);
  assert.doesNotMatch(refsAfter, /refs\/forgerelay\/review\/ws_orphan\/open/);
  assert.deepEqual(readIdentityRows(stateDir), identityBefore, "persistent Workspace identity and aliases must be untouched");
  assert.deepEqual(readFileSync(join(liveStateDir, "tasks.json")), taskBefore, "Workspace Task Lists must be untouched");
  assert.deepEqual(readFileSync(join(liveStateDir, "checkpoints.json")), checkpointBefore, "named checkpoints must be untouched");
  assert.equal(git(repo, ["worktree", "list", "--porcelain"]), worktreesBefore, "managed worktrees must be untouched");
  assert.equal(git(repo, ["rev-parse", "forgerelay/managed"]), managedBranchBefore, "managed branches must be untouched");

  const after = inspectMaintenanceState(env, NOW);
  assert.equal(after.activityAudit.reclaimableActivities, 0);
  assert.equal(after.activityAudit.reclaimableEvents, 0);
  assert.equal(after.durableBashOutput.reclaimableStreams, 0);
  assert.equal(after.hostTurns.reclaimableTurns, 0);
  assert.equal(after.reviewRefs.reclaimableRefs, 0);
  assert.equal(after.administrativeState.reclaimableOrphanWorkspaceStateDirectories, 0);

  const treeBeforeSecond = snapshotTree(stateDir);
  const refsBeforeSecond = reviewRefs(repo);
  const second = pruneMaintenanceState(stateDir, POLICY, NOW);
  assert.equal(second.result, "noop");
  assert.deepEqual(second.removed, zeroRemoved());
  assert.deepEqual(second.cleanup, { removedSegmentFiles: 0, retainedActivityPayloadsRewritten: 0 });
  assert.deepEqual(snapshotTree(stateDir), treeBeforeSecond, "repeat prune must be idempotent");
  assert.equal(reviewRefs(repo), refsBeforeSecond, "repeat prune must not mutate protected refs");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function insertWorkspace(
  sqlite: Database.Database,
  id: string,
  root: string,
  mode: "checkout" | "worktree",
  managed: boolean,
  sourceRoot: string | null,
  branch: string | null,
): void {
  sqlite.prepare(
    `insert into workspace_sessions
      (id, root, status, mode, source_root, branch, managed, created_at, last_used_at)
     values (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(id, root, mode, sourceRoot, branch, managed ? "true" : "false", OLD_START, RECENT);
}

function insertTurn(sqlite: Database.Database, turnId: string, createdAt: string): void {
  sqlite.prepare(
    "insert into activity_host_turns (turn_id, conversation_scope_id, workspace_id, created_at) values (?, ?, ?, ?)",
  ).run(turnId, "conversation", "ws_live", createdAt);
}

function insertActivityPair(
  sqlite: Database.Database,
  appendPayload: (id: string, text: string) => { prefix: string; offset: number; length: number },
  activityId: string,
  turnId: string,
  startedAt: string,
  doneAt: string,
): void {
  insertActivityStart(sqlite, appendPayload, activityId, turnId, startedAt);
  const ref = appendPayload(`${activityId}:done`, JSON.stringify({ result: `${activityId}-done` }));
  insertActivity(sqlite, {
    id: `evt_${activityId}_done`, activityId, sequence: 1, eventType: "succeeded", turnId: null,
    createdAt: doneAt, ref,
  });
}

function insertActivityStart(
  sqlite: Database.Database,
  appendPayload: (id: string, text: string) => { prefix: string; offset: number; length: number },
  activityId: string,
  turnId: string,
  createdAt: string,
): void {
  const ref = appendPayload(`${activityId}:start`, JSON.stringify({ request: `${activityId}-start` }));
  insertActivity(sqlite, {
    id: `evt_${activityId}_start`, activityId, sequence: 0, eventType: "started", turnId,
    createdAt, ref,
  });
}

function insertActivity(sqlite: Database.Database, input: {
  id: string;
  activityId: string;
  sequence: number;
  eventType: string;
  turnId: string | null;
  createdAt: string;
  ref: { prefix: string; offset: number; length: number };
}): void {
  sqlite.prepare(
    `insert into activity_audit_events
      (id, activity_id, sequence, event_type, turn_id, tool, workspace_id, workspace_root, workspace_mode,
       payload_file, payload_offset, payload_length, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.activityId,
    input.sequence,
    input.eventType,
    input.turnId,
    input.eventType === "started" ? "read" : null,
    input.eventType === "started" ? "ws_live" : null,
    input.eventType === "started" ? "fixture" : null,
    input.eventType === "started" ? "checkout" : null,
    input.ref.prefix,
    input.ref.offset,
    input.ref.length,
    input.createdAt,
  );
}

function insertBash(sqlite: Database.Database, input: {
  id: string;
  activityId: string;
  turnId: string;
  status: "running" | "done";
  startedAt: string;
  finishedAt: string | null;
  output: { prefix: string; offset: number; length: number };
  command: { prefix: string; offset: number; length: number };
  outputBytes: number;
  commandLength: number;
}): void {
  sqlite.prepare(
    `insert into bash_output_streams
      (id, activity_id, turn_id, process_id, workspace_id, workspace_root, command, tty, status,
       returned, timed_out, started_at, finished_at, log_file, output_bytes,
       command_file, command_offset, command_length, error_length)
     values (?, ?, ?, ?, ?, ?, '', 0, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    input.id,
    input.activityId,
    input.turnId,
    input.status === "running" ? 202 : 201,
    "ws_live",
    "fixture",
    input.status,
    input.startedAt,
    input.finishedAt,
    input.output.prefix,
    input.outputBytes,
    input.command.prefix,
    input.command.offset,
    input.commandLength,
  );
}

function count(sqlite: Database.Database, table: string, predicate: string): number {
  return Number((sqlite.prepare(`select count(*) as count from ${table} where ${predicate}`).get() as { count: number }).count);
}

function readIdentityRows(stateDir: string): unknown {
  const database = openDatabase(stateDir);
  try {
    return {
      sessions: database.sqlite.prepare(
        "select id, root, status, mode, source_root, branch, managed from workspace_sessions order by id",
      ).all(),
      aliases: database.sqlite.prepare(
        "select alias_id, workspace_session_id from workspace_session_aliases order by alias_id",
      ).all(),
    };
  } finally {
    database.close();
  }
}

function runPruneCli(configDir: string, stateDir: string): ReturnType<typeof pruneMaintenanceState> {
  const output = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "maintenance", "prune", "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...cleanProductEnv,
        FORGERELAY_CONFIG_DIR: configDir,
        FORGERELAY_STATE_DIR: stateDir,
      },
    },
  );
  return JSON.parse(output) as ReturnType<typeof pruneMaintenanceState>;
}

function reviewRefs(repo: string): string {
  return git(repo, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/forgerelay/review"]);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function zeroRemoved() {
  return {
    activities: 0,
    activityEvents: 0,
    activityPayloadBytes: 0,
    bashStreams: 0,
    bashPayloadBytes: 0,
    hostTurns: 0,
    reviewRefs: 0,
    orphanWorkspaceStateDirectories: 0,
  };
}

function snapshotTree(root: string): Array<{ path: string; type: "dir" | "file"; size?: number; hash?: string }> {
  if (!existsSync(root)) return [];
  const result: Array<{ path: string; type: "dir" | "file"; size?: number; hash?: string }> = [];
  visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));

  function visit(path: string): void {
    const stats = statSync(path);
    const name = relative(root, path) || ".";
    if (["forgerelay.sqlite-wal", "forgerelay.sqlite-shm", "forgerelay-runtime.lock"].includes(name)) return;
    if (stats.isDirectory()) {
      // Directory stat sizes are filesystem-specific metadata and can change when
      // SQLite creates/removes transient WAL/SHM entries. Persistent idempotency
      // is defined by the directory/file paths and durable file contents instead.
      result.push({ path: name, type: "dir" });
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    const bytes = readFileSync(path);
    result.push({
      path: name,
      type: "file",
      size: stats.size,
      hash: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}
