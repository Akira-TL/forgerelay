import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export interface LanguageServerDefinitionInput {
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  languages?: string[];
  extensions?: string[];
  projectMarkers?: string[];
}

export type LanguageServerConfigInput = Record<string, LanguageServerDefinitionInput>;

export interface ResolvedLanguageServerDefinition {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  languages: string[];
  extensions: string[];
  projectMarkers: string[];
  source: "builtin" | "global" | "project";
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

const definitionSchema = z.object({
  enabled: z.boolean().optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  languages: z.array(z.string().min(1)).min(1).optional(),
  extensions: z.array(z.string().regex(/^\./)).min(1).optional(),
  projectMarkers: z.array(z.string().min(1)).optional(),
}).strict();

const configSchema = z.record(z.string().min(1), definitionSchema);

type BuiltinDefinition = LanguageServerDefinitionInput & {
  executableCandidates: string[];
};

const BUILTIN_DEFINITIONS: Record<string, BuiltinDefinition> = {
  typescript: {
    executableCandidates: ["typescript-language-server"],
    args: ["--stdio"],
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    projectMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
  },
  pyright: {
    executableCandidates: ["pyright-langserver"],
    args: ["--stdio"],
    languages: ["python"],
    extensions: [".py", ".pyi"],
    projectMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.cfg", "setup.py"],
  },
  "rust-analyzer": {
    executableCandidates: ["rust-analyzer"],
    languages: ["rust"],
    extensions: [".rs"],
    projectMarkers: ["Cargo.toml"],
  },
  gopls: {
    executableCandidates: ["gopls"],
    languages: ["go"],
    extensions: [".go"],
    projectMarkers: ["go.work", "go.mod"],
  },
  clangd: {
    executableCandidates: ["clangd"],
    languages: ["c", "cpp", "objective-c", "objective-cpp"],
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".m", ".mm"],
    projectMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd"],
  },
};

interface CandidateDefinition extends LanguageServerDefinitionInput {
  id: string;
  source: ResolvedLanguageServerDefinition["source"];
  executableCandidates?: string[];
}

export async function resolveLanguageProject(input: {
  workspaceRoot: string;
  sourcePath: string;
  globalConfig?: LanguageServerConfigInput;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedLanguageProject> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const sourcePath = await resolveWorkspaceSourcePath(workspaceRoot, input.sourcePath);
  const projectConfig = await loadProjectLanguageServerConfig(workspaceRoot);
  const globalConfig = parseLanguageServerConfig(
    input.globalConfig ?? {},
    "global ForgeRelay config",
  );
  const definitions = await effectiveDefinitions(
    globalConfig,
    projectConfig,
    input.env ?? process.env,
  );
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

  const sourceRank = { builtin: 0, global: 1, project: 2 } as const;
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

export async function loadProjectLanguageServerConfig(
  workspaceRoot: string,
): Promise<LanguageServerConfigInput> {
  const path = join(workspaceRoot, ".forgerelay", "language-servers.json");
  try {
    return parseLanguageServerConfig(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    if (isMissingFile(error)) return {};
    if (error instanceof LanguageServerConfigurationError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new LanguageServerConfigurationError(
      "code.configuration_invalid",
      `Unable to load Language-server configuration at ${path}: ${reason}`,
    );
  }
}

export function parseLanguageServerConfig(value: unknown, label: string): LanguageServerConfigInput {
  const parsed = configSchema.safeParse(value ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new LanguageServerConfigurationError(
      "code.configuration_invalid",
      `Invalid Language-server configuration in ${label}: ${details}`,
    );
  }
  return parsed.data;
}

async function effectiveDefinitions(
  globalConfig: LanguageServerConfigInput,
  projectConfig: LanguageServerConfigInput,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedLanguageServerDefinition[]> {
  const ids = new Set([
    ...Object.keys(BUILTIN_DEFINITIONS),
    ...Object.keys(globalConfig),
    ...Object.keys(projectConfig),
  ]);
  const definitions: ResolvedLanguageServerDefinition[] = [];

  for (const id of ids) {
    const builtin = BUILTIN_DEFINITIONS[id];
    const global = globalConfig[id];
    const project = projectConfig[id];
    const source: ResolvedLanguageServerDefinition["source"] = project
      ? "project"
      : global
        ? "global"
        : "builtin";
    const merged: CandidateDefinition = {
      id,
      source,
      ...(builtin ?? {}),
      ...(global ?? {}),
      ...(project ?? {}),
      env: {
        ...(builtin?.env ?? {}),
        ...(global?.env ?? {}),
        ...(project?.env ?? {}),
      },
    };

    if (merged.enabled === false) continue;
    const languages = merged.languages ?? [];
    const extensions = merged.extensions?.map((entry) => entry.toLowerCase()) ?? [];
    if (languages.length === 0 || extensions.length === 0) continue;

    let command = merged.command;
    if (!command && builtin?.executableCandidates) {
      command = await findExecutable(builtin.executableCandidates, env);
      if (!command) continue;
    }
    if (!command) {
      throw new LanguageServerConfigurationError(
        "code.configuration_invalid",
        `Language-server definition ${id} requires a command.`,
      );
    }

    const normalized = {
      id,
      command,
      args: merged.args ?? [],
      env: merged.env ?? {},
      languages,
      extensions,
      projectMarkers: merged.projectMarkers ?? [],
      source,
    };
    definitions.push({
      ...normalized,
      fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
    });
  }

  return definitions;
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
