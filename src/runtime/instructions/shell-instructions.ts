import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CommandShellFamily } from "../shell/command-shell-runtime.js";

export type ShellInstructionFamily = "pwsh" | "powershell" | "cmd" | "zsh" | "fish";
export type ShellInstructionSeedStatus = "created" | "preserved" | "failed";

export interface ShellInstructionSeedResult {
  family: ShellInstructionFamily;
  path: string;
  status: ShellInstructionSeedStatus;
  sourceUrl: string;
  error?: string;
}

interface SeedShellInstructionOptions {
  configDir: string;
  version: string;
  families: ShellInstructionFamily[];
  reset?: boolean;
  fetchText?: (url: string) => Promise<string>;
}

const TEMPLATE_REPOSITORY_RAW = "https://raw.githubusercontent.com/Akira-TL/forgerelay";
const TEMPLATE_DIRECTORY = "templates/instructions";

export function shellInstructionFamily(
  family: CommandShellFamily,
): ShellInstructionFamily | undefined {
  if (family === "pwsh" || family === "powershell" || family === "cmd" || family === "zsh" || family === "fish") {
    return family;
  }
  return undefined;
}

export function shellInstructionPath(configDir: string, family: CommandShellFamily): string | undefined {
  const instructionFamily = shellInstructionFamily(family);
  return instructionFamily ? join(resolve(configDir), "instructions", `${instructionFamily}.md`) : undefined;
}

export function shellInstructionFamiliesToSeed(
  platform: NodeJS.Platform,
  selectedFamily: CommandShellFamily,
): ShellInstructionFamily[] {
  const selectedPosixGuidance = selectedFamily === "zsh" || selectedFamily === "fish"
    ? [selectedFamily] as ShellInstructionFamily[]
    : [];
  if (platform === "win32") return ["pwsh", "powershell", "cmd", ...selectedPosixGuidance];
  return selectedPosixGuidance;
}

export function shellInstructionTemplateUrl(version: string, family: ShellInstructionFamily): string {
  const normalizedVersion = version.trim().replace(/^v/, "");
  if (!normalizedVersion) throw new Error("ForgeRelay version is required to fetch shell Instructions.");
  return `${TEMPLATE_REPOSITORY_RAW}/v${encodeURIComponent(normalizedVersion)}/${TEMPLATE_DIRECTORY}/${family}.md`;
}

export async function seedShellInstructionFiles(
  options: SeedShellInstructionOptions,
): Promise<ShellInstructionSeedResult[]> {
  const instructionsDir = join(resolve(options.configDir), "instructions");
  await mkdir(instructionsDir, { recursive: true, mode: 0o700 });
  const fetchText = options.fetchText ?? fetchInstructionText;
  const uniqueFamilies = [...new Set(options.families)];
  const results: ShellInstructionSeedResult[] = [];

  for (const family of uniqueFamilies) {
    const path = join(instructionsDir, `${family}.md`);
    const sourceUrl = shellInstructionTemplateUrl(options.version, family);
    if (!options.reset && await fileExists(path)) {
      results.push({ family, path, status: "preserved", sourceUrl });
      continue;
    }

    try {
      const content = await fetchText(sourceUrl);
      if (!content.trim()) throw new Error("template response was empty");
      await writeFile(path, content.endsWith("\n") ? content : `${content}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: options.reset ? "w" : "wx",
      });
      results.push({ family, path, status: "created", sourceUrl });
    } catch (error) {
      if (!options.reset && await fileExists(path)) {
        results.push({ family, path, status: "preserved", sourceUrl });
        continue;
      }
      results.push({
        family,
        path,
        status: "failed",
        sourceUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export async function readShellInstruction(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function fetchInstructionText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "forgerelay-shell-instructions" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return response.text();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
