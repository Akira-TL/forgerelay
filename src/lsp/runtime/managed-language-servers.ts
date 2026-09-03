import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ManagedLanguageServerId } from "../code-intelligence-types.js";

export type { ManagedLanguageServerId } from "../code-intelligence-types.js";

interface ManagedLanguageServerSpec {
  id: ManagedLanguageServerId;
  label: string;
  executable: string;
  packages: string[];
}

const MANAGED_LANGUAGE_SERVERS: Record<ManagedLanguageServerId, ManagedLanguageServerSpec> = {
  typescript: {
    id: "typescript",
    label: "TypeScript / JavaScript",
    executable: "typescript-language-server",
    packages: ["typescript-language-server@6", "typescript@7"],
  },
  pyright: {
    id: "pyright",
    label: "Python (Pyright)",
    executable: "pyright-langserver",
    packages: ["pyright@1"],
  },
};

export interface ManagedLanguageServerInstallResult {
  installed: ManagedLanguageServerId[];
  packages: string[];
  root: string;
}

export type ManagedNpmRunner = (args: string[]) => Promise<void>;

export function managedLanguageServerRoot(configDir: string): string {
  return join(configDir, "language-servers");
}

export function managedLanguageServerBinDir(configDir: string): string {
  return join(managedLanguageServerRoot(configDir), "node_modules", ".bin");
}

export function withManagedLanguageServerPath(
  env: NodeJS.ProcessEnv,
  configDir: string,
): NodeJS.ProcessEnv {
  const bin = managedLanguageServerBinDir(configDir);
  return {
    ...env,
    PATH: [bin, env.PATH].filter((value): value is string => Boolean(value)).join(delimiter),
  };
}

export function managedLanguageServerOptions(): Array<{
  value: ManagedLanguageServerId;
  label: string;
  hint: string;
}> {
  return [
    {
      value: "typescript",
      label: MANAGED_LANGUAGE_SERVERS.typescript.label,
      hint: "Installs typescript-language-server and TypeScript into ForgeRelay's private config directory.",
    },
    {
      value: "pyright",
      label: MANAGED_LANGUAGE_SERVERS.pyright.label,
      hint: "Installs Pyright into ForgeRelay's private config directory.",
    },
  ];
}

export function supportedManagedLanguageServers(): ManagedLanguageServerId[] {
  return Object.keys(MANAGED_LANGUAGE_SERVERS) as ManagedLanguageServerId[];
}

export function installedManagedLanguageServers(configDir: string): ManagedLanguageServerId[] {
  return supportedManagedLanguageServers()
    .filter((id) => managedExecutableExists(configDir, MANAGED_LANGUAGE_SERVERS[id].executable));
}

export function managedLanguageServerPackages(ids: readonly ManagedLanguageServerId[]): string[] {
  const packages = new Set<string>();
  for (const id of ids) {
    for (const packageSpec of MANAGED_LANGUAGE_SERVERS[id].packages) packages.add(packageSpec);
  }
  return [...packages];
}

export async function installManagedLanguageServers(
  ids: readonly ManagedLanguageServerId[],
  configDir: string,
  runNpm: ManagedNpmRunner = defaultNpmRunner,
): Promise<ManagedLanguageServerInstallResult> {
  const selected = Array.from(new Set(ids));
  const root = managedLanguageServerRoot(configDir);
  const packages = managedLanguageServerPackages(selected);
  if (packages.length === 0) return { installed: [], packages: [], root };

  mkdirSync(root, { recursive: true });
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    writeFileSync(packageJsonPath, JSON.stringify({
      name: "forgerelay-managed-language-servers",
      private: true,
      description: "ForgeRelay-managed optional Language Servers. Do not publish.",
    }, null, 2) + "\n");
  }

  await runNpm([
    "install",
    "--prefix",
    root,
    "--save-exact",
    "--no-audit",
    "--no-fund",
    ...packages,
  ]);
  return { installed: selected, packages, root };
}

function managedExecutableExists(configDir: string, executable: string): boolean {
  const bin = managedLanguageServerBinDir(configDir);
  if (process.platform === "win32") {
    return [".cmd", ".exe", ".bat", ""].some((extension) => existsSync(join(bin, `${executable}${extension}`)));
  }
  return existsSync(join(bin, executable));
}

function defaultNpmRunner(args: string[]): Promise<void> {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = (stderr || stdout).trim();
      reject(new Error(`npm install for managed Language Servers failed with exit ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
    });
  });
}
