import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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
import { databasePath, openDatabase } from "../runtime/state/db/client.js";
import type { MaintenanceInspectReport } from "./maintenance.js";

const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("FORGERELAY_")),
) as NodeJS.ProcessEnv;

const emptyRoot = mkdtempSync(join(tmpdir(), "forgerelay-maintenance-empty-"));
try {
  const configDir = join(emptyRoot, "config");
  const stateDir = join(emptyRoot, "state");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ stateDir }));

  const report = runInspect(configDir, stateDir);
  assert.equal(report.database, "absent");
  assert.equal(report.policy.historyDays, null);
  assert.equal(report.policy.durableHistory, "unlimited");
  assert.equal(report.policy.orphanedAdministrativeState, false);
  assert.equal(report.activityAudit.events, 0);
  assert.equal(report.namedCheckpoints.checkpoints, 0);
  assert.equal(report.workspaceTasks.tasks, 0);
  assert.equal(existsSync(stateDir), false, "read-only inspection must not create a missing state directory");
} finally {
  rmSync(emptyRoot, { recursive: true, force: true });
}

const walRoot = mkdtempSync(join(tmpdir(), "forgerelay-maintenance-wal-"));
try {
  const configDir = join(walRoot, "config");
  const stateDir = join(walRoot, "state");
  const workspaceRoot = join(walRoot, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ stateDir }));

  const database = openDatabase(stateDir);
  try {
    const timestamp = "2026-09-04T12:00:00.000Z";
    database.sqlite.prepare(
      `insert into workspace_sessions
        (id, root, status, mode, managed, created_at, last_used_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run("ws_wal", workspaceRoot, "active", "checkout", "false", timestamp, timestamp);

    const sourceDatabase = databasePath(stateDir);
    const sourceWal = `${sourceDatabase}-wal`;
    assert.equal(existsSync(sourceWal), true, "active SQLite state should retain a WAL file for this regression");
    assert.ok(statSync(sourceWal).size > 0, "latest Workspace state should be represented in the active WAL");
    const before = snapshotTree(stateDir);

    const report = runInspect(configDir, stateDir);
    assert.equal(report.database, "present");
    assert.equal(report.workspaceState.sessions, 1);
    assert.equal(report.workspaceState.activeSessions, 1);
    assertSnapshotEqual(snapshotTree(stateDir), before);
  } finally {
    database.close();
  }
} finally {
  rmSync(walRoot, { recursive: true, force: true });
}

const root = mkdtempSync(join(tmpdir(), "forgerelay-maintenance-inspect-"));
try {
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const repo = join(root, "repo");
  const missingBacking = join(root, "missing-worktree");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "ForgeRelay Test"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["branch", "forgerelay/recoverable"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/forgerelay/review/ws_live/open", head]);
  git(repo, ["update-ref", "refs/forgerelay/review/ws_live/baseline", head]);
  git(repo, ["update-ref", "refs/forgerelay/review/ws_alias/open", head]);
  git(repo, ["update-ref", "refs/forgerelay/review/ws_unknown/open", head]);
  git(repo, ["update-ref", "refs/forgerelay/review/ws_deleted/open", head]);

  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    stateDir,
    retention: {
      historyDays: 7,
      orphanedAdministrativeState: true,
    },
  }, null, 2));

  const database = openDatabase(stateDir);
  const oldStart = "2026-07-01T00:00:00.000Z";
  const oldDone = "2026-07-01T00:01:00.000Z";
  const recent = "2026-09-03T00:00:00.000Z";
  try {
    database.sqlite.prepare(
      `insert into workspace_sessions
        (id, root, status, mode, source_root, branch, managed, created_at, last_used_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("ws_live", repo, "active", "checkout", null, null, "false", oldStart, recent);
    database.sqlite.prepare(
      `insert into workspace_sessions
        (id, root, status, mode, source_root, branch, managed, created_at, last_used_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ws_recoverable",
      missingBacking,
      "active",
      "worktree",
      repo,
      "forgerelay/recoverable",
      "true",
      oldStart,
      recent,
    );
    database.sqlite.prepare(
      "insert into workspace_session_aliases (alias_id, workspace_session_id) values (?, ?)",
    ).run("ws_alias", "ws_live");
    database.sqlite.prepare(
      `insert into workspace_conversation_bindings
        (conversation_scope_id, target_key, workspace_session_id, created_at, last_used_at)
       values (?, ?, ?, ?, ?)`,
    ).run("conversation", "target", "ws_live", oldStart, recent);
    database.sqlite.prepare(
      `insert into workspace_context_deliveries
        (conversation_scope_id, target_key, context_fingerprint, delivered_at)
       values (?, ?, ?, ?)`,
    ).run("conversation", "target", "fingerprint", recent);
    database.sqlite.prepare(
      `insert into loaded_agent_files
        (workspace_session_id, path, content_hash, content, loaded_at, last_seen_at)
       values (?, ?, ?, ?, ?, ?)`,
    ).run("ws_live", "AGENTS.md", "hash", "rules", oldStart, recent);

    insertActivity(database.sqlite, {
      id: "evt_old_start",
      activityId: "act_old",
      sequence: 0,
      type: "started",
      turnId: "turn_old",
      createdAt: oldStart,
      payloadLength: 10,
      root: repo,
    });
    insertActivity(database.sqlite, {
      id: "evt_old_done",
      activityId: "act_old",
      sequence: 1,
      type: "succeeded",
      turnId: null,
      createdAt: oldDone,
      payloadLength: 20,
      root: repo,
    });
    insertActivity(database.sqlite, {
      id: "evt_returned_start",
      activityId: "act_returned",
      sequence: 0,
      type: "started",
      turnId: "turn_returned",
      createdAt: oldStart,
      payloadLength: 40,
      root: repo,
    });
    insertActivity(database.sqlite, {
      id: "evt_returned",
      activityId: "act_returned",
      sequence: 1,
      type: "returned",
      turnId: null,
      createdAt: oldDone,
      payloadLength: 50,
      root: repo,
    });
    insertActivity(database.sqlite, {
      id: "evt_recent_start",
      activityId: "act_recent",
      sequence: 0,
      type: "started",
      turnId: "turn_recent",
      createdAt: recent,
      payloadLength: 30,
      root: repo,
    });
    database.sqlite.prepare(
      "insert into activity_host_turns (turn_id, conversation_scope_id, workspace_id, created_at) values (?, ?, ?, ?)",
    ).run("turn_old", "conversation", "ws_live", oldStart);
    database.sqlite.prepare(
      "insert into activity_host_turns (turn_id, conversation_scope_id, workspace_id, created_at) values (?, ?, ?, ?)",
    ).run("turn_returned", "conversation", "ws_live", oldStart);
    database.sqlite.prepare(
      "insert into activity_host_turns (turn_id, conversation_scope_id, workspace_id, created_at) values (?, ?, ?, ?)",
    ).run("turn_recent", "conversation", "ws_live", recent);
    database.sqlite.prepare(
      `insert into bash_output_streams
        (id, activity_id, turn_id, process_id, workspace_id, workspace_root, command, tty, status,
         returned, timed_out, started_at, finished_at, output_bytes, command_length, error_length)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "out_old", "act_old", "turn_old", 101, "ws_live", repo, "old-command", 0, "done",
      0, 0, oldStart, oldDone, 100, 11, 0,
    );
    database.sqlite.prepare(
      `insert into bash_output_streams
        (id, activity_id, turn_id, process_id, workspace_id, workspace_root, command, tty, status,
         returned, timed_out, started_at, output_bytes, command_length, error_length)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "out_returned_running", "act_returned", "turn_returned", 102, "ws_live", repo, "returned-running", 0, "running",
      1, 0, oldStart, 70, 16, 0,
    );
    database.sqlite.prepare(
      `insert into bash_output_streams
        (id, activity_id, turn_id, process_id, workspace_id, workspace_root, command, tty, status,
         returned, timed_out, started_at, output_bytes, command_length, error_length)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "out_running", "act_recent", "turn_recent", 103, "ws_live", repo, "running-command", 0, "running",
      1, 0, recent, 50, 15, 0,
    );
  } finally {
    database.close();
  }

  const liveStateDir = join(stateDir, "workspaces", "ws_live");
  mkdirSync(liveStateDir, { recursive: true });
  writeFileSync(join(liveStateDir, "checkpoints.json"), JSON.stringify({
    version: 1,
    revision: 2,
    gitCommonDir: join(repo, ".git"),
    checkpoints: [
      { id: "cp_one", name: "one", createdAt: oldStart, commit: head, baseHead: head, summary: { files: 1, additions: 1, removals: 0 } },
      { id: "cp_two", name: "two", createdAt: recent, commit: head, baseHead: head, summary: { files: 1, additions: 0, removals: 1 } },
    ],
  }, null, 2));
  writeFileSync(join(liveStateDir, "tasks.json"), JSON.stringify({
    version: 1,
    revision: 1,
    lists: [{
      id: "tl_test",
      name: "test",
      state: "active",
      revision: 1,
      tasks: [
        { id: "tsk_open", status: "in_progress", subject: "open", content: "" },
        { id: "tsk_done", status: "completed", subject: "done", content: "" },
      ],
    }],
  }, null, 2));
  mkdirSync(join(stateDir, "workspaces", "ws_deadbeef"), { recursive: true });
  mkdirSync(join(stateDir, "workspaces", "ws_alias"), { recursive: true });
  const protectedOrphan = join(stateDir, "workspaces", "ws_cafebabe");
  mkdirSync(protectedOrphan, { recursive: true });
  writeFileSync(join(protectedOrphan, "tasks.json"), JSON.stringify({ version: 1, revision: 0, lists: [] }));
  const unknownOrphan = join(stateDir, "workspaces", "ws_unknown");
  mkdirSync(unknownOrphan, { recursive: true });
  writeFileSync(join(unknownOrphan, "keep.bin"), "unknown private state\n");

  const stateBefore = snapshotTree(stateDir);
  const refsBefore = git(repo, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/forgerelay"]);
  const worktreesBefore = git(repo, ["worktree", "list", "--porcelain"]);
  const taskBefore = readFileSync(join(liveStateDir, "tasks.json"), "utf8");
  const checkpointBefore = readFileSync(join(liveStateDir, "checkpoints.json"), "utf8");

  const first = runInspect(configDir, stateDir);
  const second = runInspect(configDir, stateDir);
  assert.deepEqual(second, first);

  assert.equal(first.policy.historyDays, 7);
  assert.equal(first.policy.orphanedAdministrativeState, true);
  assert.equal(first.activityAudit.events, 5);
  assert.equal(first.activityAudit.activities, 3);
  assert.equal(first.activityAudit.payloadBytes, 150);
  assert.equal(first.activityAudit.reclaimableActivities, 1);
  assert.equal(first.activityAudit.reclaimableEvents, 2);
  assert.equal(first.activityAudit.reclaimablePayloadBytes, 30);
  assert.equal(first.durableBashOutput.streams, 3);
  assert.equal(first.durableBashOutput.runningStreams, 2);
  assert.equal(first.durableBashOutput.payloadBytes, 262);
  assert.equal(first.durableBashOutput.reclaimableStreams, 1);
  assert.equal(first.durableBashOutput.reclaimablePayloadBytes, 111);
  assert.equal(first.hostTurns.turns, 3);
  assert.equal(first.hostTurns.reclaimableTurns, 1);
  assert.equal(first.workspaceState.sessions, 2);
  assert.equal(first.workspaceState.missingManagedBacking, 1);
  assert.equal(first.workspaceState.recoverableManagedBackingCandidates, 1);
  assert.equal(first.workspaceState.conversationBindings, 1);
  assert.equal(first.workspaceState.contextDeliveries, 1);
  assert.equal(first.workspaceState.loadedInstructionFiles, 1);
  assert.equal(first.namedCheckpoints.checkpoints, 2);
  assert.equal(first.namedCheckpoints.reclaimableCheckpoints, 0);
  assert.equal(first.namedCheckpoints.protected, true);
  assert.equal(first.workspaceTasks.tasks, 2);
  assert.equal(first.workspaceTasks.unfinishedTasks, 1);
  assert.equal(first.workspaceTasks.protected, true);
  assert.equal(first.reviewRefs.refs, 5);
  assert.equal(first.reviewRefs.orphanedRefs, 1);
  assert.equal(first.reviewRefs.reclaimableRefs, 1);
  assert.equal(first.administrativeState.orphanWorkspaceStateDirectories, 3);
  assert.equal(first.administrativeState.protectedOrphanWorkspaceStateDirectories, 2);
  assert.equal(first.administrativeState.reclaimableOrphanWorkspaceStateDirectories, 1);

  const human = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "maintenance", "inspect"],
    { cwd: process.cwd(), encoding: "utf8", env: cliEnv(configDir, stateDir) },
  );
  assert.match(human, /Retention: durable history 7 days; orphaned administrative cleanup enabled/);
  assert.match(human, /Named checkpoints: 2 .*protected, explicit deletion only/);
  assert.match(human, /Review refs: 5 .*orphaned 1; reclaimable 1/);

  assertSnapshotEqual(snapshotTree(stateDir), stateBefore);
  assert.equal(git(repo, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/forgerelay"]), refsBefore);
  assert.equal(git(repo, ["worktree", "list", "--porcelain"]), worktreesBefore);
  assert.equal(readFileSync(join(liveStateDir, "tasks.json"), "utf8"), taskBefore);
  assert.equal(readFileSync(join(liveStateDir, "checkpoints.json"), "utf8"), checkpointBefore);

  const invalid = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "maintenance", "inspect", "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...cliEnv(configDir, stateDir), FORGERELAY_RETENTION_HISTORY_DAYS: "0" },
    },
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Retention historyDays must be an integer between 1 and 36500/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function insertActivity(sqlite: import("better-sqlite3").Database, input: {
  id: string;
  activityId: string;
  sequence: number;
  type: string;
  turnId: string | null;
  createdAt: string;
  payloadLength: number;
  root: string;
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
    input.type,
    input.turnId,
    input.type === "started" ? "read" : null,
    input.type === "started" ? "ws_live" : null,
    input.type === "started" ? input.root : null,
    input.type === "started" ? "checkout" : null,
    `workspaces/ws_live/activity/events.000000.log`,
    input.sequence * 100,
    input.payloadLength,
    input.createdAt,
  );
}

function runInspect(configDir: string, stateDir: string): MaintenanceInspectReport {
  const output = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "maintenance", "inspect", "--json"],
    { cwd: process.cwd(), encoding: "utf8", env: cliEnv(configDir, stateDir) },
  );
  return JSON.parse(output) as MaintenanceInspectReport;
}

function cliEnv(configDir: string, stateDir: string): NodeJS.ProcessEnv {
  return {
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_STATE_DIR: stateDir,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function assertSnapshotEqual(
  actual: ReturnType<typeof snapshotTree>,
  expected: ReturnType<typeof snapshotTree>,
): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  const before = new Map(expected.map((entry) => [entry.path, entry]));
  const after = new Map(actual.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = paths.filter((path) => JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path)));
  throw new Error(`maintenance inspect mutated state entries: ${changed.join(", ")}`);
}

function snapshotTree(root: string): Array<{ path: string; type: "dir" | "file"; size: number; mtimeMs: number; hash?: string }> {
  if (!existsSync(root)) return [];
  const result: Array<{ path: string; type: "dir" | "file"; size: number; mtimeMs: number; hash?: string }> = [];
  visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));

  function visit(path: string): void {
    const stats = statSync(path);
    const name = relative(root, path) || ".";
    if (stats.isDirectory()) {
      result.push({ path: name, type: "dir", size: stats.size, mtimeMs: stats.mtimeMs });
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    const content = readFileSync(path);
    result.push({
      path: name,
      type: "file",
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hash: createHash("sha256").update(content).digest("hex"),
    });
  }
}
