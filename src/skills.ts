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
import { expandHomePath } from "./roots.js";

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
    config.devspaceSkillsDir,
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
  const resolution = resolveAdvertisedFileReadPath(skills, activatedSkillDirs, inputPath);
  if (!resolution) return undefined;

  return {
    absolutePath: resolution.absolutePath,
    skill: resolution.source,
    isSkillFile: resolution.isEntryFile,
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
