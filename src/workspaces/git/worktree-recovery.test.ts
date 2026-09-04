import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ServerConfig } from "../../runtime/config/config.js";
import type { WorkspaceSession } from "../state/workspace-store.js";
import { git } from "./git.js";
import { inspectManagedWorktreeRecovery } from "./worktree-recovery.js";

test("managed-worktree registration matches filesystem aliases of the same backing path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-worktree-recovery-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceRoot = join(root, "source");
  const worktreeRoot = join(root, "worktrees");
  const aliasRoot = join(root, "worktrees-alias");
  const actualBacking = join(worktreeRoot, "managed");
  const aliasedBacking = join(aliasRoot, "managed");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await git(sourceRoot, ["init", "-b", "main"]);
  await git(sourceRoot, ["config", "user.name", "ForgeRelay Test"]);
  await git(sourceRoot, ["config", "user.email", "forgerelay-test@example.invalid"]);
  await git(sourceRoot, ["commit", "--allow-empty", "-m", "initial"]);
  await git(sourceRoot, ["worktree", "add", "-b", "forgerelay/recovery-alias", actualBacking, "main"]);
  await symlink(worktreeRoot, aliasRoot, platform() === "win32" ? "junction" : "dir");

  const now = new Date().toISOString();
  const session: WorkspaceSession = {
    id: "ws_recovery_alias",
    root: aliasedBacking,
    status: "active",
    mode: "worktree",
    sourceRoot,
    baseRef: "main",
    baseSha: (await git(sourceRoot, ["rev-parse", "main"])).stdout.trim(),
    branch: "forgerelay/recovery-alias",
    targetBranch: "main",
    managed: true,
    createdAt: now,
    lastUsedAt: now,
  };
  const config = {
    allowedRoots: [sourceRoot],
    worktreeRoot: aliasRoot,
  } as ServerConfig;

  assert.deepEqual(await inspectManagedWorktreeRecovery(session, config), {
    classification: "healthy",
    conditions: [],
    backing: "present",
    source: "available",
    gitRegistration: "registered",
    managedBranch: "present",
    targetBranch: "present",
    backingBranch: "matching",
  });
});
