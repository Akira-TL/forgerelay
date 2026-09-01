import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  markAdvertisedFileSourceActivated,
  resolveAdvertisedFileReadPath,
} from "./advertised-files.js";
import {
  loadSkills,
  type Skill,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: LoadSkillsResult["diagnostics"];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

const SUBAGENT_DELEGATION_NAME = "subagent-delegation";

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

  const result = loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: effectiveSkillPaths(config, cwd),
    includeDefaults: false,
  });

  if (config.subagents) return result;

  return {
    skills: result.skills.filter((skill) => skill.name !== SUBAGENT_DELEGATION_NAME),
    diagnostics: result.diagnostics.filter((diagnostic) => {
      const collision = diagnostic.collision;
      return !(collision?.resourceType === "skill" && collision.name === SUBAGENT_DELEGATION_NAME);
    }),
  };
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const virtualRead = resolveVirtualSkillReadPath(skills, activatedSkillDirs, inputPath);
  if (virtualRead) return virtualRead;

  // Compatibility for stale Host metadata that still contains the historical real path.
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
