import { opendir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  markCapabilityGuideActivated,
  resolveCapabilityGuideReadPath,
} from "../mcp/server/core/capabilities.js";
import type { ServerConfig } from "../runtime/config/config.js";
import { readShellInstruction } from "../runtime/instructions/shell-instructions.js";
import {
  assertAllowedPath,
  isPathInsideRoot,
  resolveAllowedPath,
} from "../mcp/filesystem/roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  redactSkillDiagnosticMessage,
  resolveSkillReadPath,
} from "./resources/skills.js";
import {
  defaultWorkspaceContextSources,
  resolveWorkspaceContextSources,
  type WorkspaceContextSources,
} from "./resources/context-sources.js";
import type { ProjectContext } from "./state/project-context.js";
import {
  WorkspaceResourceMonitor,
  type WorkspaceResourceUpdate,
} from "./resources/resource-monitor.js";
import type { WorkspaceMode } from "./state/workspace-store.js";
import type {
  AvailableAgentsFile,
  LoadedAgentsFile,
  Workspace,
  WorkspaceReadPath,
} from "../workspaces.js";
export type WorkspaceInstructionStateStatus = "loaded" | "disabled" | "unavailable";

export interface WorkspaceInstructionState {
  path: string;
  status: WorkspaceInstructionStateStatus;
}

export interface AdvertisedWorkspaceInstruction {
  path: string;
  content: string;
  status: "loaded" | "available" | "disabled";
}

const INITIAL_INSTRUCTION_DISCOVERY_DEPTH = 1;
const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".forgerelay",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

/**
 * Own the Workspace filesystem context boundary. Keeping path containment,
 * instruction discovery, and virtual Skill/Capability reads together prevents
 * lifecycle code from accidentally bypassing the same security rules.
 */
export class WorkspaceContextService {
  private readonly resourceMonitor = new WorkspaceResourceMonitor();
  private readonly contextSourceRefreshes = new Map<string, Promise<void>>();

  constructor(private readonly config: ServerConfig) {}

  fileToolRoots(workspace: Workspace): string[] {
    return [workspace.root, tmpdir()];
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }
    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    if (inputPath.startsWith("skills://")) {
      const skillRead = resolveSkillReadPath(workspace.skills, workspace.activatedSkillDirs, inputPath);
      if (!skillRead) {
        throw new Error(
          `Skill resource is not readable before its skill is loaded: ${inputPath}. Read skills://<name> first.`,
        );
      }
      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }

    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(workspace.skills, workspace.activatedSkillDirs, inputPath);
      if (skillRead) {
        return {
          absolutePath: skillRead.absolutePath,
          readRoots: [workspace.root, skillRead.skill.baseDir],
          skillRead,
        };
      }

      const capabilityGuideRead = resolveCapabilityGuideReadPath(
        workspace.capabilityGuides,
        workspace.activatedCapabilityGuideDirs,
        inputPath,
      );
      if (capabilityGuideRead) {
        return {
          absolutePath: capabilityGuideRead.absolutePath,
          readRoots: [workspace.root, capabilityGuideRead.guide.baseDir],
          capabilityGuideRead,
        };
      }

      try {
        return {
          absolutePath: resolveAllowedPath(inputPath, workspace.root, [tmpdir()]),
          readRoots: this.fileToolRoots(workspace),
        };
      } catch {
        throw workspaceError;
      }
    }
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
      this.resourceMonitor.markSkillActivated(workspace.id, readPath.skillRead.skill.filePath);
    }
    if (readPath.capabilityGuideRead?.isGuideFile) {
      markCapabilityGuideActivated(
        workspace.activatedCapabilityGuideDirs,
        readPath.capabilityGuideRead.guide,
      );
    }
  }

  async readAdvertisedInstruction(
    workspace: Workspace,
    inputPath: string,
  ): Promise<AdvertisedWorkspaceInstruction> {
    const candidates = [
      ...workspace.loadedInstructionPaths,
      ...workspace.workspaceInstructions.map((instruction) => instruction.path),
      ...new Set([...workspace.knownInstructionPathsByDir.values()].flat()),
    ];
    const selectedPath = candidates.find((candidate) =>
      candidate === inputPath || formatAgentsPath(candidate, workspace.root) === inputPath
    );
    if (!selectedPath) {
      throw new Error(`Instruction path is not advertised for this Workspace: ${inputPath}`);
    }

    const realPath = await tryRealpath(selectedPath);
    if (!realPath) {
      throw new Error(`Instruction file is no longer available: ${inputPath}`);
    }

    // Project instructions must resolve inside the Workspace. Config-owned
    // system/shell instructions are intentionally exempt because they are
    // trusted inputs explicitly advertised by ForgeRelay.
    const trustedExternalInstructionPaths = new Set([
      resolve(workspace.contextSources.systemInstructionsPath),
      ...(this.config.shellInstructionPath ? [resolve(this.config.shellInstructionPath)] : []),
    ]);
    if (!trustedExternalInstructionPaths.has(resolve(selectedPath))) {
      const realRoot = (await tryRealpath(workspace.root)) ?? resolve(workspace.root);
      if (!isPathInsideRoot(realPath, realRoot)) {
        throw new Error(`Instruction path escaped the Workspace after discovery: ${inputPath}`);
      }
    }

    const workspaceInstruction = workspace.workspaceInstructions.find((instruction) =>
      resolve(instruction.path) === resolve(selectedPath)
    );
    return {
      path: selectedPath,
      content: await readFile(realPath, "utf8"),
      status: workspaceInstruction?.status === "disabled"
        ? "disabled"
        : workspace.loadedInstructionPaths.has(selectedPath) ? "loaded" : "available",
    };
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  defaultContextSources(root: string): Workspace["contextSources"] {
    return defaultWorkspaceContextSources(this.config, root);
  }

  async loadContextSourcesForWorkspace(
    project: ProjectContext,
    root: string,
  ): Promise<Pick<Workspace, "contextSources" | "skills" | "skillDiagnostics">> {
    const contextSources = await resolveWorkspaceContextSources(this.config, project, root);
    return {
      contextSources,
      ...this.loadSkillsForWorkspace(root, contextSources.skillPaths),
    };
  }

  async refreshContextSourcesForWorkspace(workspace: Workspace): Promise<void> {
    const existing = this.contextSourceRefreshes.get(workspace.id);
    if (existing) return existing;
    const refresh = this.applyContextSourceRefresh(workspace);
    this.contextSourceRefreshes.set(workspace.id, refresh);
    try {
      await refresh;
    } finally {
      if (this.contextSourceRefreshes.get(workspace.id) === refresh) this.contextSourceRefreshes.delete(workspace.id);
    }
  }

  private async applyContextSourceRefresh(workspace: Workspace): Promise<void> {
    if (!workspace.project) return;
    const contextSources = await resolveWorkspaceContextSources(this.config, workspace.project, workspace.root);
    if (sameContextSources(workspace.contextSources, contextSources)) return;

    const previousSources = workspace.contextSources;
    const previousLoadedPaths = new Set([...workspace.loadedInstructionPaths].map((path) => resolve(path)));
    const previousKnownPaths = new Set(
      [...workspace.knownInstructionPathsByDir.values()].flat().map((path) => resolve(path)),
    );
    const previousAvailablePaths = new Set(
      [...previousKnownPaths].filter((path) => !previousLoadedPaths.has(path)),
    );
    const previousSkills = workspace.skills.map((skill) => ({ ...skill }));
    const previousSkillDiagnostics = workspace.skillDiagnostics.map((diagnostic) => ({ ...diagnostic }));

    const nextSkills = this.loadSkillsForWorkspace(workspace.root, contextSources.skillPaths);
    workspace.contextSources = contextSources;
    workspace.skills = nextSkills.skills;
    workspace.skillDiagnostics = nextSkills.skillDiagnostics;
    const retainedSkillDirs = new Set(workspace.skills.map((skill) => resolve(skill.baseDir)));
    for (const activatedDir of [...workspace.activatedSkillDirs]) {
      if (!retainedSkillDirs.has(resolve(activatedDir))) workspace.activatedSkillDirs.delete(activatedDir);
    }

    workspace.scannedInstructionDirs.clear();
    workspace.knownInstructionPathsByDir.clear();
    workspace.loadedInstructionRealPaths.clear();
    workspace.loadedInstructionPaths.clear();
    workspace.workspaceInstructions.length = 0;
    const agentsFiles = await this.loadInitialAgentsFiles(workspace);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace, agentsFiles);
    this.trackWorkspaceResources(workspace, agentsFiles, availableAgentsFiles);
    this.resourceMonitor.announce(
      workspace.id,
      formatContextSourceRefresh({
        workspace,
        previousSources,
        previousLoadedPaths,
        previousAvailablePaths,
        previousSkills,
        previousSkillDiagnostics,
        agentsFiles,
        availableAgentsFiles,
      }),
      ["agentsFiles", "availableAgentsFiles", "skills", "skillDiagnostics"],
    );
  }

  loadSkillsForWorkspace(
    root: string,
    skillPaths: readonly string[] = this.config.skillPaths,
  ): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root, skillPaths);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }
    return assertAllowedPath(root, this.config.allowedRoots);
  }

  async loadInitialAgentsFiles(workspace: Workspace): Promise<LoadedAgentsFile[]> {
    const systemInstructionsPath = resolve(workspace.contextSources.systemInstructionsPath);
    const loadedFiles: LoadedAgentsFile[] = [];
    const systemInstructions = await readSystemInstructions(systemInstructionsPath);
    const systemInstructionsRealPath = await tryRealpath(systemInstructionsPath);

    if (systemInstructions !== undefined) {
      loadedFiles.push({ path: systemInstructionsPath, content: systemInstructions });
      workspace.loadedInstructionPaths.add(systemInstructionsPath);
      if (systemInstructionsRealPath) workspace.loadedInstructionRealPaths.add(systemInstructionsRealPath);
    } else {
      workspace.workspaceInstructions.push({ path: systemInstructionsPath, status: "unavailable" });
    }

    const shellInstructionPath = this.config.shellInstructionPath;
    if (shellInstructionPath) {
      const shellInstruction = await readShellInstruction(shellInstructionPath);
      if (shellInstruction === undefined) {
        workspace.workspaceInstructions.push({ path: shellInstructionPath, status: "unavailable" });
      } else if (this.config.shellInstructionsEnabled) {
        loadedFiles.push({ path: shellInstructionPath, content: shellInstruction });
        workspace.loadedInstructionPaths.add(shellInstructionPath);
        const shellInstructionRealPath = await tryRealpath(shellInstructionPath);
        if (shellInstructionRealPath) workspace.loadedInstructionRealPaths.add(shellInstructionRealPath);
        workspace.workspaceInstructions.push({ path: shellInstructionPath, status: "loaded" });
      } else {
        workspace.workspaceInstructions.push({ path: shellInstructionPath, status: "disabled" });
      }
    }

    await this.discoverInstructionTree(workspace, workspace.root, INITIAL_INSTRUCTION_DISCOVERY_DEPTH);
    loadedFiles.push(...await this.loadKnownInstructionsInDirectory(workspace, workspace.root));
    return loadedFiles;
  }

  async findAvailableAgentsFiles(
    workspace: Workspace,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const discovered: AvailableAgentsFile[] = [];
    for (const paths of workspace.knownInstructionPathsByDir.values()) {
      for (const path of paths) {
        if (loadedPaths.has(path)) continue;
        const realPath = await tryRealpath(path);
        if (realPath && workspace.loadedInstructionRealPaths.has(realPath)) continue;
        discovered.push({ path });
      }
    }
    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }

  async discoverPathInstructions(
    workspace: Workspace,
    inputPath: string,
  ): Promise<LoadedAgentsFile[]> {
    const absolutePath = resolve(inputPath);
    if (!isPathInsideRoot(absolutePath, workspace.root)) return [];

    const targetDirectory = dirname(absolutePath);
    const relationship = relative(workspace.root, targetDirectory);
    if (
      relationship === ".." ||
      relationship.startsWith(`..${sep}`) ||
      resolve(targetDirectory) === resolve(this.config.agentDir) ||
      isPathInsideRoot(targetDirectory, resolve(this.config.agentDir))
    ) {
      return [];
    }

    const directories = [resolve(workspace.root)];
    if (relationship) {
      let current = resolve(workspace.root);
      for (const segment of relationship.split(sep).filter(Boolean)) {
        if (SKIPPED_CONTEXT_DIRS.has(segment)) break;
        current = join(current, segment);
        directories.push(current);
      }
    }

    const loaded: LoadedAgentsFile[] = [];
    for (const directory of directories) {
      await this.discoverInstructionTree(workspace, directory, 0);
      loaded.push(...await this.loadKnownInstructionsInDirectory(workspace, directory));
    }
    for (const file of loaded) {
      this.resourceMonitor.trackLoadedInstruction(workspace.id, workspace.root, file.path);
    }
    return loaded;
  }

  trackWorkspaceResources(
    workspace: Workspace,
    agentsFiles: LoadedAgentsFile[],
    availableAgentsFiles: AvailableAgentsFile[],
  ): void {
    this.resourceMonitor.trackWorkspace({
      workspaceId: workspace.id,
      root: workspace.root,
      loadedInstructions: agentsFiles.map((file) => file.path),
      availableInstructions: availableAgentsFiles.map((file) => file.path),
      skills: workspace.skills.map((skill) => ({
        name: skill.name,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        activated: workspace.activatedSkillDirs.has(resolve(skill.baseDir)),
      })),
    });
  }

  claimResourceUpdates(
    workspaceId: string,
    conversationScopeId: string | undefined,
  ): WorkspaceResourceUpdate | undefined {
    return this.resourceMonitor.claim(workspaceId, conversationScopeId);
  }

  acknowledgeResourceUpdates(workspaceId: string, conversationScopeId: string | undefined): void {
    this.resourceMonitor.acknowledge(workspaceId, conversationScopeId);
  }

  resourceUpdatesCurrent(workspaceId: string, conversationScopeId: string | undefined): boolean {
    return this.resourceMonitor.isCurrentForScope(workspaceId, conversationScopeId);
  }

  forgetWorkspaceResources(workspaceId: string): void {
    this.resourceMonitor.forgetWorkspace(workspaceId);
  }

  pruneWorkspaceResources(activeWorkspaceIds: Iterable<string>): void {
    this.resourceMonitor.pruneWorkspaces(activeWorkspaceIds);
  }


  private async discoverInstructionTree(
    workspace: Workspace,
    directory: string,
    remainingDepth: number,
  ): Promise<void> {
    const resolvedDirectory = resolve(directory);
    if (workspace.scannedInstructionDirs.has(resolvedDirectory)) return;
    workspace.scannedInstructionDirs.add(resolvedDirectory);

    if (
      resolvedDirectory !== resolve(workspace.root) &&
      isPathInsideRoot(resolvedDirectory, resolve(this.config.agentDir))
    ) {
      return;
    }

    let entries;
    try {
      entries = await opendir(resolvedDirectory);
    } catch {
      return;
    }

    const instructionPaths: string[] = [];
    const childDirectories: string[] = [];
    for await (const entry of entries) {
      const path = join(resolvedDirectory, entry.name);
      if (entry.isFile() && workspace.contextSources.instructionNames.includes(entry.name)) {
        instructionPaths.push(path);
        continue;
      }
      if (remainingDepth > 0 && entry.isDirectory() && !SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        childDirectories.push(path);
      }
    }

    workspace.knownInstructionPathsByDir.set(
      resolvedDirectory,
      instructionPaths.sort((left, right) => left.localeCompare(right)),
    );
    if (remainingDepth <= 0) return;
    for (const childDirectory of childDirectories) {
      await this.discoverInstructionTree(workspace, childDirectory, remainingDepth - 1);
    }
  }

  private async loadKnownInstructionsInDirectory(
    workspace: Workspace,
    directory: string,
  ): Promise<LoadedAgentsFile[]> {
    const resolvedDirectory = resolve(directory);
    const paths = workspace.knownInstructionPathsByDir.get(resolvedDirectory) ?? [];
    const loaded: LoadedAgentsFile[] = [];
    const resolvedRoot = (await tryRealpath(workspace.root)) ?? resolve(workspace.root);
    const realDirectory = (await tryRealpath(resolvedDirectory)) ?? resolvedDirectory;

    for (const path of paths) {
      const realPath = await tryRealpath(path);
      if (!realPath) continue;
      if (!isPathInsideRoot(realPath, resolvedRoot)) continue;
      if (dirname(realPath) !== realDirectory) continue;
      if (workspace.loadedInstructionRealPaths.has(realPath)) continue;

      let content: string;
      try {
        content = await readFile(realPath, "utf8");
      } catch (error) {
        if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
        throw error;
      }

      workspace.loadedInstructionRealPaths.add(realPath);
      workspace.loadedInstructionPaths.add(path);
      loaded.push({ path, content });
    }
    return loaded;
  }
}

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");
  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }
  return relationship.split(sep).join("/");
}

function sameContextSources(left: WorkspaceContextSources, right: WorkspaceContextSources): boolean {
  return left.systemInstructionsPath === right.systemInstructionsPath &&
    sameStringList(left.instructionNames, right.instructionNames) &&
    sameStringList(left.skillPaths, right.skillPaths);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatContextSourceRefresh(input: {
  workspace: Workspace;
  previousSources: WorkspaceContextSources;
  previousLoadedPaths: Set<string>;
  previousAvailablePaths: Set<string>;
  previousSkills: Workspace["skills"];
  previousSkillDiagnostics: Workspace["skillDiagnostics"];
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
}): string {
  const {
    workspace,
    previousSources,
    previousLoadedPaths,
    previousAvailablePaths,
    previousSkills,
    previousSkillDiagnostics,
    agentsFiles,
    availableAgentsFiles,
  } = input;
  const sections = ["Agent context source configuration changed; the effective Workspace context has been refreshed without reopening the Workspace."];

  if (previousSources.systemInstructionsPath !== workspace.contextSources.systemInstructionsPath) {
    sections.push([
      "System instruction source changed:",
      `- ${formatAgentsPath(previousSources.systemInstructionsPath, workspace.root)}`,
      `+ ${formatAgentsPath(workspace.contextSources.systemInstructionsPath, workspace.root)}`,
    ].join("\n"));
  }
  if (!sameStringList(previousSources.instructionNames, workspace.contextSources.instructionNames)) {
    sections.push([
      "Project instruction filename selection changed:",
      `- ${previousSources.instructionNames.join(", ") || "(none)"}`,
      `+ ${workspace.contextSources.instructionNames.join(", ") || "(none)"}`,
    ].join("\n"));
  }
  if (!sameStringList(previousSources.skillPaths, workspace.contextSources.skillPaths)) {
    sections.push([
      "Skill source path selection changed:",
      `- ${previousSources.skillPaths.join(", ") || "(none)"}`,
      `+ ${workspace.contextSources.skillPaths.join(", ") || "(none)"}`,
    ].join("\n"));
  }

  const currentLoadedPaths = new Set(agentsFiles.map((file) => resolve(file.path)));
  for (const path of [...previousLoadedPaths].filter((path) => !currentLoadedPaths.has(path)).sort()) {
    sections.push(`Instruction source is no longer active: ${formatAgentsPath(path, workspace.root)}`);
  }
  for (const file of agentsFiles) {
    if (previousLoadedPaths.has(resolve(file.path))) continue;
    sections.push([
      `Instruction source loaded: ${formatAgentsPath(file.path, workspace.root)}`,
      file.content,
    ].join("\n"));
  }

  const currentAvailablePaths = new Set(availableAgentsFiles.map((file) => resolve(file.path)));
  for (const path of [...previousAvailablePaths].filter((path) => !currentAvailablePaths.has(path)).sort()) {
    sections.push(`Lazy Workspace instruction is no longer advertised: ${formatAgentsPath(path, workspace.root)}`);
  }
  for (const file of availableAgentsFiles) {
    if (previousAvailablePaths.has(resolve(file.path))) continue;
    sections.push(`Lazy Workspace instruction is now available: ${formatAgentsPath(file.path, workspace.root)}. Read it before working under that directory.`);
  }

  const previousSkillKeys = new Map(previousSkills.map((skill) => [
    `${skill.name}\u0000${resolve(skill.filePath)}`,
    skill,
  ]));
  const currentSkillKeys = new Map(workspace.skills.map((skill) => [
    `${skill.name}\u0000${resolve(skill.filePath)}`,
    skill,
  ]));
  for (const [key, skill] of previousSkillKeys) {
    if (currentSkillKeys.has(key)) continue;
    sections.push(`Skill metadata removed: skills://${encodeURIComponent(skill.name)}`);
  }
  for (const [key, skill] of currentSkillKeys) {
    if (previousSkillKeys.has(key)) continue;
    sections.push(`Skill metadata added: skills://${encodeURIComponent(skill.name)}\n+ description: ${skill.description}`);
  }

  if (JSON.stringify(previousSkillDiagnostics) !== JSON.stringify(workspace.skillDiagnostics)) {
    if (workspace.skillDiagnostics.length === 0) {
      sections.push("Skill diagnostics cleared.");
    } else {
      sections.push([
        "Current Skill diagnostics:",
        ...workspace.skillDiagnostics.map((diagnostic) =>
          `- ${diagnostic.type}: ${redactSkillDiagnosticMessage(diagnostic)}`
        ),
      ].join("\n"));
    }
  }

  return sections.join("\n\n");
}

async function readSystemInstructions(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
    throw error;
  }
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
