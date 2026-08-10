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
  capability: "capability",
} as const;

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
  return "Shell commands may modify ordinary project files when that is a natural part of the user's requested development task. They may also perform external device or hardware mutations when the user's current request explicitly asks for the actual device-changing operation, including firmware flashing or equivalent persistent device updates; do not infer such authorization from a check, audit, probe, backup, verification, dry-run, or build-only request. Never use shell commands to modify security- or privilege-sensitive operating-system files or credential material such as /etc/sudoers, /etc/passwd, /etc/shadow, PAM or authentication policy, SSH private keys, or equivalent privileged system files. Modify configuration files through shell only when the user's request explicitly calls for that configuration change; do not infer permission merely because changing configuration would be convenient.";
}

export function buildServerInstructions(config: ServerConfig): string {
  return joinInstructions(
    capabilityContractInstructions(config),
    selectedWorkflowInstructions(config),
    config.appendInstructions,
  );
}

export function buildToolDescriptions(config: ServerConfig): ToolDescriptions {
  const skillCapability = config.skillsEnabled
    ? " Advertised skill paths may also be outside the workspace."
    : "";
  const shellSurface = config.toolMode === "minimal"
    ? ` In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled, so shell commands may be used for equivalent search and directory inspection.`
    : "";

  return {
    read: `Read a file inside an open workspace or the OS temp directory. Instruction files and advertised capability guides returned by ${toolNames.openWorkspace} are also readable when applicable.${skillCapability} Only advertised entry files and files under already-loaded advertised directories are readable outside the normal roots. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    write: `Create or completely overwrite a file inside an open workspace or the OS temp directory. Workspace paths may be relative; OS temp paths may be absolute. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    edit: `Edit one file inside an open workspace or the OS temp directory by replacing exact text blocks. Each oldText must match a unique, non-overlapping region of the original file. Workspace paths may be relative; OS temp paths may be absolute. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    rename: `Rename or move one file or directory inside an open workspace or the OS temp directory without overwriting an existing destination. Source and destination must both remain inside the permitted file roots. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    delete: `Delete one file or directory inside an open workspace or the OS temp directory. Non-empty directories require recursive=true. An allowed root itself cannot be deleted. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    applyPatch: `Apply one Codex-style patch inside an open workspace or the OS temp directory. Supports adding, overwriting, updating, deleting, and moving files. Workspace paths must remain relative; absolute paths are accepted only inside the OS temp directory. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    shell: `Run a shell command inside an open workspace.${shellSurface} Commands execute with the local user's authority; workspace filesystem containment does not make shell execution a sandbox. ForgeRelay waits up to 300 seconds, then returns a processId for a still-running command; use ${toolNames.writeStdin} to poll, interact, wait, or send Ctrl-C. Completed background commands may be reported later for the same workspaceId. Call ${toolNames.openWorkspace} first and pass workspaceId. Expose this capability only behind strong authentication.`,
    shellCommand: "Shell command to run with the local user's authority.",
  };
}

function capabilityContractInstructions(config: ServerConfig): string {
  const staleWorkspacePolicy = config.toolMode === "codex"
    ? ""
    : ` If ${toolNames.openWorkspace} reports logical workspaces idle for more than two days, let the user choose whether to resume or close them with ${toolNames.closeWorkspace}; never close them automatically.`;
  const workspaceLifecycle = `Use ForgeRelay as a local coding workspace. Default to the user's existing checkout. Reuse the workspaceId returned by ${toolNames.openWorkspace} for this conversation; resume another logical workspaceId only when the user wants that workspace, and request a new logical workspace only when explicitly asked.${staleWorkspacePolicy} Only open mode=\"worktree\" when the user explicitly asks for isolated or parallel Git work. ${toolNames.closeWorkspace} releases a logical workspace; ${toolNames.closeWorktree} finalizes a managed worktree. Read the managed-worktrees capability guide for advanced worktree lifecycle and failure semantics.`;

  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Read an availableAgentsFiles path before working under it.`;
  const capabilityGuides = `For optional capabilities from ${toolNames.openWorkspace}, use ${toolNames.capability}; if unfamiliar, describe first and read its advertised capability guide with ${toolNames.read}.`;
  const skills = config.skillsEnabled
    ? `When a task matches an available skill from ${toolNames.openWorkspace}, read its advertised path before proceeding. Outside normal file roots, ${toolNames.read} permits only advertised entry files and files under already-loaded advertised directories.`
    : "";
  const shellMutationPolicy = buildShellMutationPolicy();
  const hooks = "When a ForgeRelay tool result reports Hook results, tell the user which meaningful hooks ran and whether they passed or blocked the operation. Do not claim the requested operation succeeded when a blocking hook prevented it.";

  return joinInstructions(workspaceLifecycle, agents, capabilityGuides, skills, shellMutationPolicy, hooks);
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
