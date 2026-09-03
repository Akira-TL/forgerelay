import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
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
    packages: ["typescript-language-server@6", "typescript@6"],
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

export function managedLanguageServerExecutablePath(
  configDir: string,
  id: ManagedLanguageServerId,
): string | undefined {
  const bin = managedLanguageServerBinDir(configDir);
  const executable = MANAGED_LANGUAGE_SERVERS[id].executable;
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  return extensions
    .map((extension) => join(bin, `${executable}${extension}`))
    .find((path) => existsSync(path));
}

export function managedLanguageServerIdForCommand(
  configDir: string,
  command: string,
): ManagedLanguageServerId | undefined {
  return supportedManagedLanguageServers().find((id) => {
    const executable = managedLanguageServerExecutablePath(configDir, id);
    return executable !== undefined && resolve(executable) === resolve(command);
  });
}

export function managedTypeScriptTsserverPath(configDir: string): string | undefined {
  const path = join(managedLanguageServerRoot(configDir), "node_modules", "typescript", "lib", "tsserver.js");
  return existsSync(path) ? path : undefined;
}

export function managedLanguageServerRuntimeIdentity(
  configDir: string,
  id: ManagedLanguageServerId,
): string | undefined {
  const packageNames = id === "typescript"
    ? ["typescript-language-server", "typescript"]
    : ["pyright"];
  try {
    const versions = packageNames.map((name) => {
      const packageJson = JSON.parse(readFileSync(
        join(managedLanguageServerRoot(configDir), "node_modules", name, "package.json"),
        "utf8",
      )) as { version?: string };
      if (!packageJson.version) throw new Error(`Missing version for ${name}`);
      return [name, packageJson.version] as const;
    });
    return JSON.stringify(versions);
  } catch {
    return undefined;
  }
}

export function withManagedLanguageServerPath(
  env: NodeJS.ProcessEnv,
  configDir: string | undefined,
): NodeJS.ProcessEnv {
  if (!configDir) return { ...env };
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
  for (const id of selected) assertManagedLanguageServerInstall(configDir, id);
  return { installed: selected, packages, root };
}

function assertManagedLanguageServerInstall(configDir: string, id: ManagedLanguageServerId): void {
  if (!managedLanguageServerExecutablePath(configDir, id)) {
    throw new Error(`Managed Language Server ${id} installed without its expected executable.`);
  }
  if (id === "typescript" && !managedTypeScriptTsserverPath(configDir)) {
    throw new Error(
      "Managed TypeScript Language Server installed without a compatible TypeScript tsserver.js. " +
      "ForgeRelay requires a tsserver-based TypeScript package for typescript-language-server.",
    );
  }
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
