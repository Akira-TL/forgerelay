import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  markAdvertisedFileSourceActivated,
  resolveAdvertisedFileReadPath,
} from "../../mcp/filesystem/advertised-files.js";
import type { ServerConfig } from "../../runtime/config/config.js";
import { expandHomePath, isPathInsideRoot } from "../../mcp/filesystem/roots.js";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}

export interface SkillCollision {
  resourceType: "skill";
  name: string;
  winnerPath: string;
  loserPath: string;
  winnerSource?: string;
  loserSource?: string;
}

export interface SkillDiagnostic {
  type: "warning" | "error" | "collision";
  message: string;
  path?: string;
  collision?: SkillCollision;
}

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

export interface SkillSummary {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

interface ParsedSkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
}

interface SkillCandidate {
  skill: Skill;
  source: string;
}

const FRONTMATTER_DELIMITER = "---";

export function effectiveSkillPaths(config: ServerConfig, cwd: string): string[] {
  const defaultPathCandidates = [
    join(homedir(), ".agents", "skills"),
    resolve(cwd, ".agents", "skills"),
    config.configSkillsDir,
    join(config.agentDir, "skills"),
  ];
  const defaultPaths = defaultPathCandidates.filter(
    (path): path is string => path !== undefined && existsSync(path),
  );

  const seen = new Set<string>();
  return [...defaultPaths, ...config.skillPaths]
    .map((path) => resolveSkillPath(path, cwd))
    .filter((path) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
}

function resolveSkillPath(path: string, cwd: string): string {
  return resolve(cwd, expandHomePath(path));
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const winners = new Map<string, SkillCandidate>();

  for (const sourcePath of effectiveSkillPaths(config, cwd)) {
    const candidates = discoverSkills(sourcePath, diagnostics);
    for (const skill of candidates) {
      const existing = winners.get(skill.name);
      if (existing) {
        diagnostics.push({
          type: "collision",
          message: `Skill '${skill.name}' from ${skill.filePath} was ignored because ${existing.skill.filePath} was loaded first.`,
          collision: {
            resourceType: "skill",
            name: skill.name,
            winnerPath: existing.skill.filePath,
            loserPath: skill.filePath,
            winnerSource: existing.source,
            loserSource: sourcePath,
          },
        });
        continue;
      }
      winners.set(skill.name, { skill, source: sourcePath });
      skills.push(skill);
    }
  }

  if (config.subagents) return { skills, diagnostics };

  return { skills, diagnostics };
}

function discoverSkills(sourcePath: string, diagnostics: SkillDiagnostic[]): Skill[] {
  if (!existsSync(sourcePath)) return [];

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(sourcePath);
  } catch (error) {
    diagnostics.push({
      type: "warning",
      message: `Unable to inspect skill path ${sourcePath}: ${errorMessage(error)}`,
      path: sourcePath,
    });
    return [];
  }

  if (stats.isFile()) {
    const skill = loadSkillFile(sourcePath, diagnostics);
    return skill ? [skill] : [];
  }
  if (!stats.isDirectory()) return [];

  const entry = join(sourcePath, "SKILL.md");
  if (existsSync(entry)) {
    const skill = loadSkillFile(entry, diagnostics);
    return skill ? [skill] : [];
  }

  const skills: Skill[] = [];
  for (const entryName of sortedDirectoryEntries(sourcePath, diagnostics)) {
    const child = join(sourcePath, entryName);
    let childStats: ReturnType<typeof statSync>;
    try {
      childStats = statSync(child);
    } catch (error) {
      diagnostics.push({
        type: "warning",
        message: `Unable to inspect skill candidate ${child}: ${errorMessage(error)}`,
        path: child,
      });
      continue;
    }

    if (childStats.isDirectory()) {
      skills.push(...discoverSkills(child, diagnostics));
      continue;
    }
    if (childStats.isFile() && extname(entryName).toLowerCase() === ".md") {
      const skill = loadSkillFile(child, diagnostics);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

function sortedDirectoryEntries(path: string, diagnostics: SkillDiagnostic[]): string[] {
  try {
    return readdirSync(path).sort((left, right) => left.localeCompare(right));
  } catch (error) {
    diagnostics.push({
      type: "warning",
      message: `Unable to read skill directory ${path}: ${errorMessage(error)}`,
      path,
    });
    return [];
  }
}

function loadSkillFile(filePath: string, diagnostics: SkillDiagnostic[]): Skill | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    diagnostics.push({
      type: "warning",
      message: `Unable to read skill file ${filePath}: ${errorMessage(error)}`,
      path: filePath,
    });
    return undefined;
  }

  let frontmatter: ParsedSkillFrontmatter = {};
  try {
    frontmatter = parseSkillFrontmatter(content);
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: `Invalid skill frontmatter in ${filePath}: ${errorMessage(error)}`,
      path: filePath,
    });
    return undefined;
  }

  const baseDir = dirname(filePath);
  const summary = skillSummaryFromFrontmatter(frontmatter, filePath);
  if (!summary.name) {
    diagnostics.push({
      type: "error",
      message: `Skill ${filePath} has an invalid or empty name.`,
      path: filePath,
    });
    return undefined;
  }

  return {
    ...summary,
    filePath: resolve(filePath),
    baseDir: resolve(baseDir),
  };
}

export function skillSummaryFromContent(content: string, filePath: string): SkillSummary {
  return skillSummaryFromFrontmatter(parseSkillFrontmatter(content), filePath);
}

function skillSummaryFromFrontmatter(frontmatter: ParsedSkillFrontmatter, filePath: string): SkillSummary {
  return {
    name: normalizedSkillName(frontmatter.name, filePath),
    description: typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
  };
}

function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER);
  if (end < 0) throw new Error("opening '---' is missing a closing delimiter");
  const parsed = parseYaml(lines.slice(1, end).join("\n"));
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  return parsed as ParsedSkillFrontmatter;
}

function normalizedSkillName(value: unknown, filePath: string): string {
  const explicit = typeof value === "string" ? value.trim() : "";
  if (explicit) return explicit;
  if (basename(filePath).toLowerCase() === "skill.md") return basename(dirname(filePath)).trim();
  return basename(filePath, extname(filePath)).trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const virtualRead = resolveVirtualSkillReadPath(skills, activatedSkillDirs, inputPath);
  if (virtualRead) return virtualRead;

  const resolution = resolveAdvertisedFileReadPath(skills, activatedSkillDirs, inputPath);
  if (!resolution) return undefined;

  return {
    absolutePath: resolution.absolutePath,
    skill: resolution.source,
    isSkillFile: resolution.isEntryFile,
  };
}

function resolveVirtualSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const prefix = "skills://";
  if (!inputPath.startsWith(prefix)) return undefined;

  const requested = inputPath.slice(prefix.length);
  const slashIndex = requested.indexOf("/");
  const encodedName = slashIndex === -1 ? requested : requested.slice(0, slashIndex);
  if (!encodedName) throw new Error(`Invalid skill URI: ${inputPath}`);

  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    throw new Error(`Invalid skill URI: ${inputPath}`);
  }

  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`Unknown advertised skill: ${name}`);

  if (slashIndex === -1 || slashIndex === requested.length - 1) {
    return {
      absolutePath: resolve(skill.filePath),
      skill,
      isSkillFile: true,
    };
  }

  const relativePart = requested.slice(slashIndex + 1);
  const segments = relativePart.split("/").map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`Invalid skill URI: ${inputPath}`);
    }
    if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error(`Invalid skill URI: ${inputPath}`);
    }
    return decoded;
  });

  const baseDir = resolve(skill.baseDir);
  if (!activatedSkillDirs.has(baseDir)) return undefined;

  const absolutePath = resolve(baseDir, ...segments);
  if (!isPathInsideRoot(absolutePath, baseDir)) {
    throw new Error(`Skill resource is outside its skill directory: ${inputPath}`);
  }

  return {
    absolutePath,
    skill,
    isSkillFile: false,
  };
}

export function markSkillActivated(
  activatedSkillDirs: Set<string>,
  skill: Skill,
): void {
  markAdvertisedFileSourceActivated(activatedSkillDirs, skill);
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}
