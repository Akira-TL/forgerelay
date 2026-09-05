import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type PowerShellSkillSeedStatus = "created" | "preserved" | "failed";

export interface PowerShellSkillSeedResult {
  path: string;
  status: PowerShellSkillSeedStatus;
  sourceUrl: string;
  error?: string;
}

interface SeedPowerShellSkillOptions {
  configDir: string;
  version: string;
  reset?: boolean;
  fetchText?: (url: string) => Promise<string>;
}

const TEMPLATE_REPOSITORY_RAW = "https://raw.githubusercontent.com/Akira-TL/forgerelay";
const POWERSHELL_SKILL_PATH = "templates/skills/powershell/SKILL.md";

export function powerShellSkillPath(configDir: string): string {
  return join(resolve(configDir), "skills", "powershell", "SKILL.md");
}

export function powerShellSkillTemplateUrl(version: string): string {
  const normalizedVersion = version.trim().replace(/^v/, "");
  if (!normalizedVersion) throw new Error("ForgeRelay version is required to fetch the PowerShell Skill.");
  return `${TEMPLATE_REPOSITORY_RAW}/v${encodeURIComponent(normalizedVersion)}/${POWERSHELL_SKILL_PATH}`;
}

export async function seedPowerShellSkill(
  options: SeedPowerShellSkillOptions,
): Promise<PowerShellSkillSeedResult> {
  const path = powerShellSkillPath(options.configDir);
  const sourceUrl = powerShellSkillTemplateUrl(options.version);
  if (!options.reset && await fileExists(path)) {
    return { path, status: "preserved", sourceUrl };
  }

  await mkdir(join(resolve(options.configDir), "skills", "powershell"), {
    recursive: true,
    mode: 0o700,
  });
  const fetchText = options.fetchText ?? fetchSkillText;
  try {
    const content = await fetchText(sourceUrl);
    if (!content.trim()) throw new Error("template response was empty");
    await writeFile(path, content.endsWith("\n") ? content : `${content}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: options.reset ? "w" : "wx",
    });
    return { path, status: "created", sourceUrl };
  } catch (error) {
    if (!options.reset && await fileExists(path)) {
      return { path, status: "preserved", sourceUrl };
    }
    return {
      path,
      status: "failed",
      sourceUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readPowerShellSkill(configDir: string): Promise<string | undefined> {
  try {
    return await readFile(powerShellSkillPath(configDir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
}

async function fetchSkillText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "forgerelay-powershell-skill" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`);
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
