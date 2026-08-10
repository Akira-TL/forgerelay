import type { ServerConfig } from "../config.js";

export const toolNames = {
  openWorkspace: "open_workspace",
  closeWorkspace: "close_workspace",
  closeWorktree: "close_worktree",
  read: "read",
  write: "write",
  edit: "edit",
  rename: "rename",
  delete: "delete",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
  writeStdin: "write_stdin",
} as const;

interface ServerInstructionContext {
  artifactDownloadSupported?: boolean;
}

export interface ToolDescriptions {
  read: string;
  write: string;
  edit: string;
  rename: string;
  delete: string;
  applyPatch: string;
  shell: string;
  shellCommand: string;
}

export function buildShellMutationPolicy(): string {
  return "Shell commands may modify ordinary project files when that is a natural part of the user's requested development task. Never use shell commands to modify security- or privilege-sensitive operating-system files or credential material such as /etc/sudoers, /etc/passwd, /etc/shadow, PAM or authentication policy, SSH private keys, or equivalent privileged system files. Modify configuration files through shell only when the user's request explicitly calls for that configuration change; do not infer permission merely because changing configuration would be convenient.";
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

  const shellMutationPolicy = buildShellMutationPolicy();

  return {
    read: `Read a file inside an open workspace or the OS temp directory. Instruction files returned by ${toolNames.openWorkspace} and advertised skill files are also readable when applicable.${skillCapability} Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    write: `Create or completely overwrite a file inside an open workspace or the OS temp directory. Workspace paths may be relative; OS temp paths may be absolute. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    edit: `Edit one file inside an open workspace or the OS temp directory by replacing exact text blocks. Each oldText must match a unique, non-overlapping region of the original file. Workspace paths may be relative; OS temp paths may be absolute. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    rename: `Rename or move one file or directory inside an open workspace or the OS temp directory without overwriting an existing destination. Source and destination must both remain inside the permitted file roots. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    delete: `Delete one file or directory inside an open workspace or the OS temp directory. Non-empty directories require recursive=true. An allowed root itself cannot be deleted. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    applyPatch: `Apply one Codex-style patch inside an open workspace or the OS temp directory. Supports adding, overwriting, updating, deleting, and moving files. Workspace paths must remain relative; absolute paths are accepted only inside the OS temp directory. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    shell: `Run a shell command inside an open workspace.${shellSurface} Commands execute with the local user's authority; workspace filesystem containment does not make shell execution a sandbox. ForgeRelay waits up to 300 seconds for bash, then returns a running process with a processId without killing it; use ${toolNames.writeStdin} with that processId to poll, keep waiting, interact, or send Ctrl-C. Completed background commands are also reported with a later tool result for the same workspaceId. ${shellMutationPolicy} Call ${toolNames.openWorkspace} first and pass workspaceId. This capability should only be exposed behind strong authentication.`,
    shellCommand: "Shell command to run with the local user's authority.",
  };
}

function capabilityContractInstructions(
  config: ServerConfig,
  context: ServerInstructionContext,
): string {
  const workspaceLifecycle = config.toolMode === "codex"
    ? `Use ForgeRelay as a local coding workspace. Default to the user's existing checkout. Keep the workspaceId returned for this conversation stable. Different conversations normally receive separate logical workspaceIds even when they point at the same physical checkout or worktree; pass an existing workspaceId to ${toolNames.openWorkspace} only when the user wants to resume that logical workspace in this conversation. Only request a new logical workspace when the user explicitly asks. Only open mode=\"worktree\" when the user explicitly asks for isolated or parallel Git work. Managed worktrees use dedicated forgerelay/* branches, not detached HEADs. When work in a managed worktree is complete and verified, call ${toolNames.closeWorktree}; it commits remaining worktree changes, fast-forwards the original target branch only when safe, then removes the worktree and its branch. If the target branch diverged or the source checkout is dirty, closing is refused and the worktree is preserved.`
    : `Use ForgeRelay as a local coding workspace. Default to the user's existing checkout. Keep the workspaceId returned for this conversation stable for later file, search, edit, write, rename, delete, show-changes, shell, and process-polling tools. Different conversations normally receive separate logical workspaceIds even when they point at the same physical checkout or worktree; pass an existing workspaceId to ${toolNames.openWorkspace} only when the user wants to resume that logical workspace in this conversation. Only request a new logical workspace when the user explicitly asks. If ${toolNames.openWorkspace} reports logical workspaces idle for more than two days, tell the user each workspaceId and let them decide whether to resume it or explicitly clean it up with ${toolNames.closeWorkspace}; do not close it automatically. Only open mode=\"worktree\" when the user explicitly asks for isolated or parallel Git work. Managed worktrees use dedicated forgerelay/* branches, not detached HEADs. When work in a managed worktree is complete and verified, call ${toolNames.closeWorktree}; it commits remaining worktree changes, fast-forwards the original target branch only when safe, then removes the worktree and its branch. If the target branch diverged or the source checkout is dirty, closing is refused and the worktree is preserved.`;

  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it.`;
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories.`
    : "";
  const toolSurface = toolSurfaceInstructions(config);
  const shellMutationPolicy = buildShellMutationPolicy();
  const hooks = "When a ForgeRelay tool result reports Hook results, tell the user which meaningful hooks ran and whether they passed or blocked the operation. Do not claim the requested operation succeeded when a blocking hook prevented it.";
  const artifact = config.artifactsEnabled && context.artifactDownloadSupported
    ? "When the user supplies or generates a file that is not present on the ForgeRelay host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
    : "";
  const showChanges = config.widgets === "changes"
    ? "If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
    : "";

  return joinInstructions(workspaceLifecycle, agents, skills, toolSurface, shellMutationPolicy, hooks, artifact, showChanges);
}

function toolSurfaceInstructions(config: ServerConfig): string {
  if (config.toolMode === "codex") {
    return `In codex tool mode, workspace file and command operations use ${toolNames.read}, ${toolNames.rename}, ${toolNames.delete}, apply_patch, exec_command, and ${toolNames.writeStdin}.`;
  }

  if (config.toolMode === "full") {
    return `In full tool mode, dedicated ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} inspection tools are available alongside the core workspace tools. ${toolNames.writeStdin} is available for running bash processes.`;
  }

  return `In minimal tool mode, dedicated ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} inspection tools are disabled; the core workspace tools remain available, including ${toolNames.writeStdin} for running bash processes.`;
}

function selectedWorkflowInstructions(config: ServerConfig): string {
  if (config.workflowInstructions === false) return "";
  if (typeof config.workflowInstructions === "string") return config.workflowInstructions;
  return defaultWorkflowInstructions(config);
}

function defaultWorkflowInstructions(config: ServerConfig): string {
  if (config.toolMode === "codex") {
    return `Use ${toolNames.read} for direct file reads, ${toolNames.rename} and ${toolNames.delete} for direct path moves or removals, apply_patch for content modifications, exec_command for inspection, tests, builds, and other commands, and ${toolNames.writeStdin} to poll or interact with running processes.`;
  }

  const inspection = config.toolMode === "full"
    ? `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection.`
    : `Use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection.`;

  return joinInstructions(
    inspection,
    `Prefer ${toolNames.edit} for targeted content modifications, ${toolNames.write} only for new files or complete rewrites, ${toolNames.rename} for path moves, ${toolNames.delete} for removals, and ${toolNames.shell} for tests, builds, git inspection, package scripts, generators, formatters, and commands that are better executed by the shell. If ${toolNames.shell} returns a running process with a processId, use ${toolNames.writeStdin} only when you need to poll, wait, interact, or interrupt it; otherwise you may continue other work and consume its completion notice from a later tool result.`,
  );
}

function joinInstructions(...parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
