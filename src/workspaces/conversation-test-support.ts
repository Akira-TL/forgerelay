import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "../runtime/config/config.js";
import { SqliteWorkspaceStore } from "./state/workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceFixture {
  root: string;
  project: string;
  stateDir: string;
  config: ServerConfig;
  store: SqliteWorkspaceStore;
  registry: WorkspaceRegistry;
  openStore: () => SqliteWorkspaceStore;
  closeStore: (store: SqliteWorkspaceStore) => void;
}

export async function fixture(
  t: TestContext,
  options: { git?: boolean } = {},
): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-conversation-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  const stores = new Set<SqliteWorkspaceStore>();

  await mkdir(join(project, ".forgerelay", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".forgerelay", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) await initializeGitRepository(project);

  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: join(root, ".config"),
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_WORKTREE_ROOT: join(root, ".worktrees"),
    FORGERELAY_AGENT_DIR: agentDir,
    FORGERELAY_SUBAGENTS: "1",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const openStore = () => {
    const store = new SqliteWorkspaceStore(stateDir);
    stores.add(store);
    return store;
  };
  const closeStore = (store: SqliteWorkspaceStore) => {
    if (stores.delete(store)) store.close();
  };
  const store = openStore();

  t.after(async () => {
    for (const openStore of stores) openStore.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    project,
    stateDir,
    config,
    store,
    registry: new WorkspaceRegistry(config, store),
    openStore,
    closeStore,
  };
}

export async function breakAgentsDirectory(agentsDir: string, backupDir: string): Promise<void> {
  await rename(agentsDir, backupDir);
  await writeFile(agentsDir, "not a directory\n");
}

export async function restoreAgentsDirectory(agentsDir: string, backupDir: string): Promise<void> {
  await rm(agentsDir, { force: true });
  await rename(backupDir, agentsDir);
}

export async function initializeGitRepository(root: string): Promise<void> {
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "forgerelay@example.com"]);
  await git(root, ["config", "user.name", "ForgeRelay Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial commit"]);
}

export async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

export function checkoutTargetKey(project: string): string {
  return JSON.stringify(["checkout", project, null]);
}
