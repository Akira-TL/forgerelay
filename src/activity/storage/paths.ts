import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ActivityWorkspaceSnapshot } from "../audit-store.js";

const SAFE_WORKSPACE_ID = /^(?:ws|rws|cws)_[a-z0-9]+$/i;

export function activityWorkspaceStorageKey(workspace: ActivityWorkspaceSnapshot): string {
  if (workspace.id && SAFE_WORKSPACE_ID.test(workspace.id)) return workspace.id;
  return `root_${createHash("sha256").update(`${workspace.mode}\0${resolve(workspace.root)}`).digest("hex").slice(0, 20)}`;
}

export function activityWorkspaceDirectory(
  stateDir: string,
  workspace: ActivityWorkspaceSnapshot,
): string {
  return join(stateDir, "workspaces", activityWorkspaceStorageKey(workspace), "activity");
}

export function activityEventLogPrefix(
  stateDir: string,
  workspace: ActivityWorkspaceSnapshot,
): string {
  return join(activityWorkspaceDirectory(stateDir, workspace), "events");
}

export function bashOutputDirectory(
  stateDir: string,
  workspace: ActivityWorkspaceSnapshot,
): string {
  return join(activityWorkspaceDirectory(stateDir, workspace), "bash");
}

export function bashOutputLogPrefix(
  stateDir: string,
  workspace: ActivityWorkspaceSnapshot,
  outputId: string,
): string {
  return join(bashOutputDirectory(stateDir, workspace), outputId);
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function stateRelativePath(stateDir: string, path: string): string {
  const relationship = relative(resolve(stateDir), resolve(path));
  if (
    relationship === "" ||
    relationship === ".." ||
    relationship.startsWith(`..${sep}`)
  ) {
    throw new Error(`Activity log path is outside ForgeRelay state directory: ${path}`);
  }
  return relationship.split(sep).join("/");
}

export function resolveStateRelativePath(stateDir: string, path: string): string {
  const absolute = resolve(stateDir, path);
  const relationship = relative(resolve(stateDir), absolute);
  if (relationship === ".." || relationship.startsWith(`..${sep}`)) {
    throw new Error(`Activity log reference escapes ForgeRelay state directory: ${path}`);
  }
  return absolute;
}

export function ensureParentPrivate(path: string): void {
  ensurePrivateDirectory(dirname(path));
}
