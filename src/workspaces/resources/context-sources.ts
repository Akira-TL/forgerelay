import { resolve } from "node:path";
import { expandHomePath } from "../../mcp/filesystem/roots.js";
import type { ServerConfig } from "../../runtime/config/config.js";
import {
  DEFAULT_INSTRUCTION_NAMES,
  DEFAULT_SKILL_PATHS,
  DEFAULT_SYSTEM_INSTRUCTIONS_PATH,
  generalConfigDefinition,
} from "../../runtime/config/definition/general-config.js";
import type { ForgeRelayUserConfig } from "../../runtime/config/user-config.js";
import { resolveProjectGeneralConfig } from "../../runtime/config/resolution/project-sources.js";
import { assertConfigResolutionValid } from "../../runtime/config/resolution/resolver.js";
import type { ProjectContext } from "../state/project-context.js";

export interface WorkspaceContextSources {
  systemInstructionsPath: string;
  instructionNames: string[];
  skillPaths: string[];
}

export function defaultWorkspaceContextSources(
  config: Pick<ServerConfig, "systemInstructionsPath" | "instructionNames" | "skillPaths">,
  workspaceRoot: string,
): WorkspaceContextSources {
  return {
    systemInstructionsPath: resolveContextPath(config.systemInstructionsPath, workspaceRoot),
    instructionNames: [...config.instructionNames],
    skillPaths: [...config.skillPaths],
  };
}

export async function resolveWorkspaceContextSources(
  config: ServerConfig,
  project: ProjectContext,
  workspaceRoot: string,
): Promise<WorkspaceContextSources> {
  const inputs = config.configRuntime.resolutionInputsFor(generalConfigDefinition.domain);
  const resolution = await resolveProjectGeneralConfig(project, {
    env: inputs.environment,
    ...(inputs.cli ? { cli: inputs.cli } : {}),
  });
  assertConfigResolutionValid(resolution);
  const values = resolution.values as ForgeRelayUserConfig;
  return {
    systemInstructionsPath: resolveContextPath(
      values.systemInstructionsPath ?? DEFAULT_SYSTEM_INSTRUCTIONS_PATH,
      workspaceRoot,
    ),
    instructionNames: [...(values.instructionNames ?? DEFAULT_INSTRUCTION_NAMES)],
    skillPaths: [...(values.skillPaths ?? DEFAULT_SKILL_PATHS)],
  };
}

function resolveContextPath(value: string, workspaceRoot: string): string {
  return resolve(workspaceRoot, expandHomePath(value));
}
