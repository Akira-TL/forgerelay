import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveProjectContext } from "../workspaces/state/project-context.js";
import type { LanguageServerDefinitionInput as CanonicalLanguageServerDefinitionInput } from "../runtime/config/definition/language-servers.js";
import {
  effectiveLanguageServerEntries,
  resolveLanguageServersConfig,
} from "../runtime/config/resolution/language-servers.js";

export type LanguageServerDefinitionInput = Omit<CanonicalLanguageServerDefinitionInput, "disabled"> & {
  enabled?: boolean;
};

export type LanguageServerConfigInput = Record<string, LanguageServerDefinitionInput>;

export interface ResolvedLanguageServerDefinition {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  languages: string[];
  extensions: string[];
  languageIdByExtension: Record<string, string>;
  projectMarkers: string[];
  source: "builtin" | "global" | "project" | "project-local";
  initializationOptions?: Record<string, unknown>;
  fingerprint: string;
}

export interface ResolvedLanguageProject {
  definition: ResolvedLanguageServerDefinition;
  projectRoot: string;
}

export class LanguageServerConfigurationError extends Error {
  constructor(
    readonly code: "code.language_service_unavailable" | "code.configuration_ambiguous" | "code.configuration_invalid",
    message: string,
  ) {
    super(message);
    this.name = "LanguageServerConfigurationError";
  }
}

const BUILTIN_EXECUTABLE_CANDIDATES: Record<string, string[]> = {
  typescript: ["typescript-language-server"],
  pyright: ["pyright-langserver"],
  "rust-analyzer": ["rust-analyzer"],
  gopls: ["gopls"],
  clangd: ["clangd"],
};

interface CandidateDefinition extends CanonicalLanguageServerDefinitionInput {
  id: string;
  source: ResolvedLanguageServerDefinition["source"];
}

export async function resolveLanguageProject(input: {
  workspaceRoot: string;
  sourcePath: string;
  configDir?: string;
  globalConfig?: LanguageServerConfigInput;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedLanguageProject> {
  const workspaceRoot = await canonicalWorkspaceRoot(input.workspaceRoot);
  const sourcePath = await resolveWorkspaceSourcePath(workspaceRoot, input.sourcePath);
  const environment = input.env ?? process.env;
  const project = input.configDir
    ? await resolveProjectContext(input.configDir, workspaceRoot)
    : undefined;
  const resolution = await resolveLanguageServersConfig({
    ...(input.configDir ? { configDir: input.configDir } : {}),
    ...(project ? { project } : {}),
    projectSharedConfigDir: join(workspaceRoot, ".forgerelay"),
    ...(input.globalConfig ? { legacyUser: input.globalConfig } : {}),
    environment,
  });
  const errors = resolution.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new LanguageServerConfigurationError(
      "code.configuration_invalid",
      `Invalid Language-server configuration: ${errors.map((diagnostic) => `${diagnostic.source.location ?? diagnostic.source.id}: ${diagnostic.message}`).join("; ")}`,
    );
  }
  const definitions = await materializeResolvedDefinitions(resolution, environment);
  const extension = extname(sourcePath).toLowerCase();
  const candidates: ResolvedLanguageProject[] = [];

  for (const definition of definitions) {
    if (!definition.extensions.includes(extension)) continue;
    const projectRoot = await findLanguageProjectRoot(
      workspaceRoot,
      dirname(sourcePath),
      definition.projectMarkers,
    );
    if (!projectRoot) continue;
    candidates.push({ definition, projectRoot });
  }

  if (candidates.length === 0) {
    throw new LanguageServerConfigurationError(
      "code.language_service_unavailable",
      `No available Language-server definition matches ${relative(workspaceRoot, sourcePath) || "."}.`,
    );
  }

  const sourceRank = { builtin: 0, global: 1, project: 2, "project-local": 3 } as const;
  const highestRank = Math.max(...candidates.map((candidate) => sourceRank[candidate.definition.source]));
  const highest = candidates.filter((candidate) => sourceRank[candidate.definition.source] === highestRank);
  const deepestLength = Math.max(...highest.map((candidate) => candidate.projectRoot.length));
  const nearest = highest.filter((candidate) => candidate.projectRoot.length === deepestLength);

  if (nearest.length !== 1) {
    throw new LanguageServerConfigurationError(
      "code.configuration_ambiguous",
      `Multiple Language-server definitions match ${relative(workspaceRoot, sourcePath)} at the same priority: ${nearest.map((candidate) => candidate.definition.id).join(", ")}.`,
    );
  }

  return nearest[0]!;
}

async function materializeResolvedDefinitions(
  resolution: Awaited<ReturnType<typeof resolveLanguageServersConfig>>,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedLanguageServerDefinition[]> {
  const definitions: ResolvedLanguageServerDefinition[] = [];

  for (const entry of effectiveLanguageServerEntries(resolution)) {
    const merged: CandidateDefinition = {
      id: entry.id,
      source: sourceForScope(entry.scope),
      ...entry.value,
    };
    const languages = merged.languages ?? [];
    const extensions = merged.extensions?.map((value) => value.toLowerCase()) ?? [];
    if (languages.length === 0 || extensions.length === 0) continue;
    const languageIdByExtension = normalizeLanguageIds(entry.id, merged, languages, extensions);

    let command = merged.command;
    const executableCandidates = BUILTIN_EXECUTABLE_CANDIDATES[entry.id];
    if (!command && executableCandidates) {
      command = await findExecutable(executableCandidates, env);
      if (!command) continue;
    }
    if (!command) {
      throw new LanguageServerConfigurationError(
        "code.configuration_invalid",
        `Language-server definition ${entry.id} requires a command.`,
      );
    }

    const normalized = {
      id: entry.id,
      command,
      args: merged.args ?? [],
      env: merged.env ?? {},
      languages,
      extensions,
      languageIdByExtension,
      projectMarkers: merged.projectMarkers ?? [],
      source: merged.source,
    };
    definitions.push({
      ...normalized,
      fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
    });
  }

  return definitions;
}

function sourceForScope(scope: string): ResolvedLanguageServerDefinition["source"] {
  if (scope === "built-in") return "builtin";
  if (scope === "user") return "global";
  if (scope === "project" || scope === "project-local") return scope;
  throw new Error(`Unsupported Language Server config scope: ${scope}`);
}

function normalizeLanguageIds(
  id: string,
  definition: CandidateDefinition,
  languages: string[],
  extensions: string[],
): Record<string, string> {
  const mapping = Object.fromEntries(
    Object.entries(definition.languageIdByExtension ?? {})
      .map(([extension, languageId]) => [extension.toLowerCase(), languageId]),
  );

  for (let index = 0; index < extensions.length; index += 1) {
    const extension = extensions[index]!;
    if (mapping[extension]) continue;
    if (languages.length === 1) {
      mapping[extension] = languages[0]!;
      continue;
    }
    if (languages.length === extensions.length) {
      mapping[extension] = languages[index]!;
      continue;
    }
    throw new LanguageServerConfigurationError(
      "code.configuration_invalid",
      `Language-server definition ${id} must map extension ${extension} to a languageId when multiple language IDs do not align one-to-one with extensions.`,
    );
  }

  for (const [extension, languageId] of Object.entries(mapping)) {
    if (!extensions.includes(extension)) continue;
    if (!languages.includes(languageId)) {
      throw new LanguageServerConfigurationError(
        "code.configuration_invalid",
        `Language-server definition ${id} maps ${extension} to unknown languageId ${languageId}.`,
      );
    }
  }

  return mapping;
}

async function findLanguageProjectRoot(
  workspaceRoot: string,
  startDirectory: string,
  markers: string[],
): Promise<string | undefined> {
  if (markers.length === 0) return workspaceRoot;
  let current = startDirectory;
  while (isWithin(workspaceRoot, current)) {
    for (const marker of markers) {
      try {
        await access(join(current, marker));
        return current;
      } catch {
        // Try the next marker or parent directory.
      }
    }
    if (current === workspaceRoot) break;
    current = dirname(current);
  }
  return undefined;
}

async function canonicalWorkspaceRoot(inputPath: string): Promise<string> {
  try {
    return await realpath(resolve(inputPath));
  } catch {
    throw new LanguageServerConfigurationError(
      "code.language_service_unavailable",
      `Code-intelligence Workspace root does not exist: ${inputPath}`,
    );
  }
}

async function resolveWorkspaceSourcePath(workspaceRoot: string, inputPath: string): Promise<string> {
  const candidate = resolve(workspaceRoot, inputPath);
  if (!isWithin(workspaceRoot, candidate)) {
    throw new LanguageServerConfigurationError(
      "code.language_service_unavailable",
      `Code-intelligence source path must remain inside the Workspace: ${inputPath}`,
    );
  }
  try {
    const [canonicalRoot, canonicalCandidate] = await Promise.all([
      realpath(workspaceRoot),
      realpath(candidate),
    ]);
    if (!isWithin(canonicalRoot, canonicalCandidate)) {
      throw new LanguageServerConfigurationError(
        "code.language_service_unavailable",
        `Code-intelligence source path resolves outside the Workspace: ${inputPath}`,
      );
    }
    return canonicalCandidate;
  } catch (error) {
    if (error instanceof LanguageServerConfigurationError) throw error;
    throw new LanguageServerConfigurationError(
      "code.language_service_unavailable",
      `Code-intelligence source path does not exist: ${inputPath}`,
    );
  }
}

async function findExecutable(candidates: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (isAbsolute(candidate)) {
      if (await executable(candidate)) return candidate;
      continue;
    }
    const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
    const extensions = process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
    for (const directory of pathEntries) {
      for (const extension of extensions) {
        const path = join(directory, process.platform === "win32" ? `${candidate}${extension}` : candidate);
        if (await executable(path)) return path;
      }
    }
  }
  return undefined;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
