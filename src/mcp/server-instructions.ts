import type { ServerConfig } from "../config.js";

export const toolNames = {
  openWorkspace: "open_workspace",
  closeWorktree: "close_worktree",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

interface ServerInstructionContext {
  artifactDownloadSupported?: boolean;
}

export interface ToolDescriptions {
  read: string;
  write: string;
  edit: string;
  applyPatch: string;
  shell: string;
  shellCommand: string;
}

export function buildServerInstructions(
  config: ServerConfig,
  context: ServerInstructionContext = {},
): string {
  return joinInstructions(
    capabilityContractInstructions(config, context),
    selectedWorkflowInstructions(config),
    config.appendInstructions,
  );
}

export function buildToolDescriptions(config: ServerConfig): ToolDescriptions {
  const skillCapability = config.skillsEnabled
    ? " Advertised skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
    : "";
  const shellSurface = config.toolMode === "minimal"
    ? ` In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled, so shell commands may be used for equivalent search and directory inspection.`
    : "";

  return {
    read: `Read a file inside an open workspace. Instruction files returned by ${toolNames.openWorkspace} and advertised skill files are also readable when applicable.${skillCapability} Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    write: `Create or completely overwrite a file inside an open workspace. The path is resolved within the workspace filesystem boundary. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    edit: `Edit one file inside an open workspace by replacing exact text blocks. Each oldText must match a unique, non-overlapping region of the original file. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    applyPatch: `Apply one Codex-style patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Paths must be relative to the workspace. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    shell: `Run a shell command inside an open workspace.${shellSurface} Commands execute with the local user's authority; workspace filesystem containment does not make shell execution a sandbox. Do not use ${toolNames.shell} to create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes. Call ${toolNames.openWorkspace} first and pass workspaceId. This capability should only be exposed behind strong authentication.`,
    shellCommand: "Shell command to run with the local user's authority.",
  };
}

function capabilityContractInstructions(
  config: ServerConfig,
  context: ServerInstructionContext,
): string {
  const workspaceLifecycle = config.toolMode === "codex"
    ? `Use ForgeRelay as a local coding workspace. Default to the user's existing checkout and reuse its workspaceId. Only open mode=\"worktree\" when the user explicitly asks for isolated or parallel work. Managed worktrees use dedicated forgerelay/* branches, not detached HEADs. When work in a managed worktree is complete and verified, call ${toolNames.closeWorktree}; it commits remaining worktree changes, fast-forwards the original target branch only when safe, then removes the worktree and its branch. If the target branch diverged or the source checkout is dirty, closing is refused and the worktree is preserved.`
    : `Use ForgeRelay as a local coding workspace. Default to the user's existing checkout and reuse its workspaceId for later file, search, edit, write, show-changes, and shell tools. Only open mode=\"worktree\" when the user explicitly asks for isolated or parallel work. Managed worktrees use dedicated forgerelay/* branches, not detached HEADs. When work in a managed worktree is complete and verified, call ${toolNames.closeWorktree}; it commits remaining worktree changes, fast-forwards the original target branch only when safe, then removes the worktree and its branch. If the target branch diverged or the source checkout is dirty, closing is refused and the worktree is preserved.`;

  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it.`;
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories.`
    : "";
  const toolSurface = toolSurfaceInstructions(config);
  const artifact = config.artifactsEnabled && context.artifactDownloadSupported
    ? "When the user supplies or generates a file that is not present on the ForgeRelay host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
    : "";
  const showChanges = config.widgets === "changes"
    ? "If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
    : "";

  return joinInstructions(workspaceLifecycle, agents, skills, toolSurface, artifact, showChanges);
}

function toolSurfaceInstructions(config: ServerConfig): string {
  if (config.toolMode === "codex") {
    return `In codex tool mode, workspace file and command operations use ${toolNames.read}, apply_patch, exec_command, and write_stdin.`;
  }

  if (config.toolMode === "full") {
    return `In full tool mode, dedicated ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} inspection tools are available alongside the core workspace tools.`;
  }

  return `In minimal tool mode, dedicated ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} inspection tools are disabled; the core workspace tools remain available.`;
}

function selectedWorkflowInstructions(config: ServerConfig): string {
  if (config.workflowInstructions === false) return "";
  if (typeof config.workflowInstructions === "string") return config.workflowInstructions;
  return defaultWorkflowInstructions(config);
}

function defaultWorkflowInstructions(config: ServerConfig): string {
  if (config.toolMode === "codex") {
    return `Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes.`;
  }

  const inspection = config.toolMode === "full"
    ? `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection.`
    : `Use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection.`;

  return joinInstructions(
    inspection,
    `Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell.`,
    `Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.`,
  );
}

function joinInstructions(...parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
