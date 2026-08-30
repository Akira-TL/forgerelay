import type { ServerConfig } from "../config.js";

export const toolNames = {
  openWorkspace: "open_workspace",
  closeWorkspace: "close_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  rename: "rename",
  delete: "delete",
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
    ? " Available skills are loaded through the virtual skills://<name> namespace; after loading a skill, files inside it may be read with skills://<name>/<relative-path>."
    : "";
  const shellSurface = config.toolMode === "codex"
    ? ""
    : " Use shell commands for search and directory inspection instead of dedicated MCP search tools.";

  return {
    read: `Read one file or multiple files inside an open workspace or the OS temp directory. Use path for one target or paths for multiple targets; offset/limit apply to every target in a bulk read. Instruction files and advertised capability guides returned by ${toolNames.openWorkspace} are also readable when applicable.${skillCapability} Only advertised entry files and files under already-loaded advertised directories are readable outside the normal roots. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    write: `Create or completely overwrite a file inside an open workspace or the OS temp directory. Workspace paths may be relative; OS temp paths may be absolute. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    edit: `Edit one file or multiple files inside an open workspace or the OS temp directory by replacing exact text blocks. Use path for one target or paths for multiple targets; a bulk Edit applies the same edits to every file and preflights all targets before the first mutation. Each oldText must match a unique, non-overlapping region of the original file. Workspace paths may be relative; OS temp paths may be absolute. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    rename: `Rename or move one file or directory inside an open workspace or the OS temp directory without overwriting an existing destination. Source and destination must both remain inside the permitted file roots. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    delete: `Delete one path or multiple paths inside an open workspace or the OS temp directory. Use path for one target or paths for multiple targets; a bulk Delete preflights all targets before deleting anything. Non-empty directories require recursive=true. An allowed root itself cannot be deleted. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    applyPatch: `Apply one Codex-style patch inside an open workspace or the OS temp directory. Supports adding, overwriting, updating, deleting, and moving files. Workspace paths must remain relative; absolute paths are accepted only inside the OS temp directory. Call ${toolNames.openWorkspace} first and pass workspaceId.`,
    shell: `Run or manage a shell process inside an open workspace.${shellSurface} Commands execute with the local user's authority; workspace containment does not make shell execution a sandbox. For action=run, yieldTimeMs is only the feedback wait (default 10000ms; 0 returns a processId immediately) and optional timeoutMs is the independent total execution limit. action=process polls/waits for incremental output, writes input, resizes a PTY, or interrupts by processId. Keep explicit waits below the Host request deadline; use 60000ms only when supported. Completed background results may be attached to a later result for the same workspaceId. Call ${toolNames.openWorkspace} first and pass workspaceId. Expose this capability only behind strong authentication.`,
    shellCommand: "Shell command to run with the local user's authority.",
  };
}

function capabilityContractInstructions(config: ServerConfig): string {
  const staleWorkspacePolicy = config.toolMode === "codex"
    ? ""
    : ` If ${toolNames.openWorkspace} reports stale workspaces, let the user choose resume or ${toolNames.closeWorkspace}; never auto-close.`;
  const workspaceLifecycle = `Default to the user's existing checkout. Reuse workspaceId from ${toolNames.openWorkspace}; change it only when asked.${staleWorkspacePolicy} Only open mode=\"worktree\" when the user explicitly asks for isolated or parallel Git work. ${toolNames.closeWorkspace} preserves Workspace identity. Managed close finalizes backing and needs commitMessage. Composite close preserves members; delete removes only Composite state. Active worktree delete still finalizes safely; checkout files are never deleted.`;
  const activityPanel = `Project-work order: ${toolNames.openWorkspace} if needed → activity_panel(workspaceId) once → work tools. activity_panel is the single ForgeRelay UI render tool: Workspace above Activity. A new workspaceId creates a new card. Never call activity_panel before needed ${toolNames.openWorkspace}.`;

  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Read an availableAgentsFiles path before working under it.`;
  const capabilityGuides = `For optional capabilities from ${toolNames.openWorkspace}, use ${toolNames.capability}; if unfamiliar, describe first and read its advertised capability guide with ${toolNames.read}.`;
  const skills = config.skillsEnabled
    ? `For a matching skill from ${toolNames.openWorkspace}, load ${toolNames.read}(path="skills://<name>") first. Skill paths stay internal; loaded skill files use skills://<name>/<relative-path>.`
    : "";
  const shellMutationPolicy = buildShellMutationPolicy();
  const hooks = "When a ForgeRelay tool result reports Hook results, tell the user which meaningful hooks ran and whether they passed or blocked the operation. Do not claim the requested operation succeeded when a blocking hook prevented it.";

  return joinInstructions(workspaceLifecycle, activityPanel, agents, capabilityGuides, skills, shellMutationPolicy, hooks);
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

  const inspection = `Use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection.`;

  return joinInstructions(
    inspection,
    `Prefer ${toolNames.edit} for targeted content modifications, ${toolNames.write} only for new files or complete rewrites, ${toolNames.rename} for path moves, ${toolNames.delete} for removals, and ${toolNames.shell} for tests, builds, Git/package scripts, generators, formatters, and shell-suited commands. If ${toolNames.shell} returns a running processId, use action=\"process\" to poll/wait/interact/resize/interrupt it. When only waiting, set yieldTimeMs instead of short polling; reuse processId if still running. Otherwise keep working and consume its later completion notice.`,
  );
}

function joinInstructions(...parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
