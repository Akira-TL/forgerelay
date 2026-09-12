import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchemaId } from "../../runtime/config/definition/schema.js";
import { generalConfigDefinition } from "../../runtime/config/definition/general-config.js";
import { externalMcpConfigDefinition } from "../../runtime/config/definition/external-mcp.js";
import { languageServersConfigDefinition } from "../../runtime/config/definition/language-servers.js";
import { parseExternalMcpServers } from "../../runtime/config/external-mcp-config.js";
import {
  loadForgeRelayFiles,
  type ForgeRelayUserConfig,
} from "../../runtime/config/user-config.js";
import { normalizeLanguageServerDefinitions } from "../../runtime/config/resolution/language-servers.js";
import {
  hooksConfigDefinition,
  normalizeLegacyHookEntries,
  type ResolvedHookEntryInput,
} from "../../mcp/hooks/config.js";
import { mergeHookConfigs, parseHookConfig } from "../../mcp/hooks/hooks.js";
import { canonicalSubagentProfileDocumentFromLegacy } from "../../subagents/profiles.js";
import { resolveProjectContext } from "../../workspaces/state/project-context.js";

interface MigrationOptions {
  dryRun: boolean;
  scope: "global" | "project";
  projectPath?: string;
}

interface PlannedWrite {
  path: string;
  content: string;
  mode: number;
}

interface PlannedCopy {
  source: string;
  target: string;
}

interface MigrationPlan {
  label: string;
  backupSources: { path: string; relativePath: string }[];
  writes: PlannedWrite[];
  copies: PlannedCopy[];
  removals: string[];
}

export async function runConfigMigration(args: string[]): Promise<void> {
  const options = parseMigrationArgs(args);
  const files = loadForgeRelayFiles();
  const plan = options.scope === "global"
    ? buildGlobalMigrationPlan(files.dir)
    : await buildProjectMigrationPlan(files.dir, options.projectPath!);

  if (plan.writes.length === 0 && plan.copies.length === 0 && plan.removals.length === 0) {
    console.log(`No legacy ForgeRelay configuration requires migration for ${plan.label}.`);
    return;
  }

  if (options.dryRun) {
    console.log(`DRY RUN: ${plan.label}`);
    printPlan(plan);
    return;
  }

  const backupRoot = createBackup(plan, files.dir);
  const newTargets = new Set([
    ...plan.writes.filter((write) => !existsSync(write.path)).map((write) => write.path),
    ...plan.copies.filter((copy) => !existsSync(copy.target)).map((copy) => copy.target),
  ]);
  try {
    for (const write of plan.writes) atomicWrite(write.path, write.content, write.mode);
    for (const copy of plan.copies) atomicCopyDirectory(copy.source, copy.target);
    for (const path of plan.removals) rmSync(path, { recursive: true, force: true });
  } catch (error) {
    for (const path of [...newTargets].reverse()) rmSync(path, { recursive: true, force: true });
    restoreBackupSources(plan, backupRoot);
    throw error;
  }

  console.log(`Migration complete: ${plan.label}`);
  console.log(`Backup: ${backupRoot}`);
  printPlan(plan);
}

function parseMigrationArgs(args: string[]): MigrationOptions {
  let dryRun = false;
  let scope: MigrationOptions["scope"] | undefined;
  let projectPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may only be supplied once.");
      dryRun = true;
      continue;
    }
    if (arg === "--global") {
      if (scope) throw new Error("Choose exactly one migration scope: --global or --project <path>.");
      scope = "global";
      continue;
    }
    if (arg === "--project") {
      if (scope) throw new Error("Choose exactly one migration scope: --global or --project <path>.");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--project requires a project path.");
      scope = "project";
      projectPath = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown config migrate option: ${arg}`);
  }
  return { dryRun, scope: scope ?? "global", ...(projectPath ? { projectPath } : {}) };
}

function buildGlobalMigrationPlan(configDir: string): MigrationPlan {
  const files = loadForgeRelayFiles({ ...process.env, FORGERELAY_CONFIG_DIR: configDir });
  const writes: PlannedWrite[] = [];
  const copies: PlannedCopy[] = [];
  const removals: string[] = [];
  const backupSources: MigrationPlan["backupSources"] = [];
  const nextConfig: ForgeRelayUserConfig = { ...files.config };
  let configChanged = false;

  if (files.config.mcpServers !== undefined) {
    if (!existsSync(join(configDir, "mcp.json"))) {
      const servers = parseExternalMcpServers(files.config.mcpServers);
      writes.push(jsonWrite(join(configDir, "mcp.json"), {
        $schema: configSchemaId(externalMcpConfigDefinition, "user"),
        servers,
      }));
    }
    delete nextConfig.mcpServers;
    configChanged = true;
  }

  if (files.config.languageServers !== undefined) {
    if (!existsSync(join(configDir, "language-servers.json"))) {
      const definitions = normalizeLanguageServerDefinitions(asRecord(files.config.languageServers, "languageServers"));
      writes.push(jsonWrite(join(configDir, "language-servers.json"), {
        $schema: configSchemaId(languageServersConfigDefinition, "user"),
        ...definitions,
      }));
    }
    delete nextConfig.languageServers;
    configChanged = true;
  }

  const inlineHooks = parseHookConfig(files.config.hooks);
  const aggregateHooks = parseHookConfig(files.hooks);
  const mergedHooks = mergeHookConfigs(inlineHooks, aggregateHooks);
  if (Object.keys(mergedHooks).length > 0) {
    writes.push(...planHookWrites(join(configDir, "hooks"), "user", mergedHooks));
  }
  if (files.config.hooks !== undefined) {
    delete nextConfig.hooks;
    configChanged = true;
  }
  if (files.hooksExists) removals.push(files.hooksPath);

  const agentsDir = join(configDir, "agents");
  const subagentsDir = join(configDir, "subagents");
  if (existsSync(agentsDir)) {
    writes.push(...planProfileWrites(agentsDir, subagentsDir));
    removals.push(agentsDir);
  }

  const generalSchema = configSchemaId(generalConfigDefinition, "user");
  if (files.configExists && nextConfig.$schema !== generalSchema) {
    nextConfig.$schema = generalSchema;
    configChanged = true;
  }
  if (configChanged) writes.push(jsonWrite(files.configPath, nextConfig));

  if (configChanged && files.configExists) backupSources.push({ path: files.configPath, relativePath: "config.json" });
  if (files.hooksExists) backupSources.push({ path: files.hooksPath, relativePath: "hooks.json" });
  if (existsSync(agentsDir)) backupSources.push({ path: agentsDir, relativePath: "agents" });

  return deduplicatePlan({ label: "global ForgeRelay configuration", backupSources, writes, copies, removals });
}

async function buildProjectMigrationPlan(configDir: string, projectPath: string): Promise<MigrationPlan> {
  const project = await resolveProjectContext(configDir, projectPath);
  const writes: PlannedWrite[] = [];
  const copies: PlannedCopy[] = [];
  const removals: string[] = [];
  const backupSources: MigrationPlan["backupSources"] = [];
  const hooksPath = join(project.sharedConfigDir, "hooks.json");
  if (existsSync(hooksPath)) {
    const hooks = parseHookConfig(readJson(hooksPath));
    writes.push(...planHookWrites(join(project.sharedConfigDir, "hooks"), "project", hooks));
    removals.push(hooksPath);
    backupSources.push({ path: hooksPath, relativePath: join("project", project.id, "hooks.json") });
  }
  const agentsDir = join(project.sharedConfigDir, "agents");
  if (existsSync(agentsDir)) {
    writes.push(...planProfileWrites(agentsDir, join(project.sharedConfigDir, "subagents")));
    removals.push(agentsDir);
    backupSources.push({ path: agentsDir, relativePath: join("project", project.id, "agents") });
  }
  return deduplicatePlan({
    label: `Project configuration at ${project.projectRoot}`,
    backupSources,
    writes,
    copies,
    removals,
  });
}

function planHookWrites(
  canonicalDir: string,
  scope: "user" | "project",
  legacyConfig: unknown,
): PlannedWrite[] {
  const normalized = normalizeLegacyHookEntries(legacyConfig);
  const writes: PlannedWrite[] = [];
  const reserved = new Set(
    existsSync(canonicalDir)
      ? readdirSync(canonicalDir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5))
      : [],
  );
  for (const [key, value] of Object.entries(normalized)) {
    if (reserved.has(key)) continue;
    if (!Array.isArray(value)) continue;
    for (const [index, entry] of value.entries()) {
      const stem = availableHookFileStem(key, index, reserved);
      reserved.add(stem);
      writes.push(jsonWrite(join(canonicalDir, `${stem}.json`), canonicalHookDocument(entry, scope)));
    }
  }
  return writes;
}

function canonicalHookDocument(entry: ResolvedHookEntryInput, scope: "user" | "project"): Record<string, unknown> {
  return {
    $schema: configSchemaId(hooksConfigDefinition, scope),
    event: entry.event,
    ...(entry.matcher ? { matcher: entry.matcher } : {}),
    command: entry.command,
    ...(entry.timeoutSeconds === undefined ? {} : { timeoutSeconds: entry.timeoutSeconds }),
    ...(entry.report === undefined ? {} : { report: entry.report }),
  };
}

function availableHookFileStem(key: string, index: number, reserved: Set<string>): string {
  const preferred = index === 0 ? key : `${key}--${index + 1}`;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(preferred) && !reserved.has(preferred)) return preferred;
  for (let salt = 0; ; salt += 1) {
    const candidate = `legacy-${createHash("sha256").update(`${key}\0${index}\0${salt}`).digest("hex").slice(0, 20)}`;
    if (!reserved.has(candidate)) return candidate;
  }
}

function planProfileWrites(legacyDir: string, canonicalDir: string): PlannedWrite[] {
  const canonicalNames = new Set<string>();
  const reservedFiles = new Set<string>();
  if (existsSync(canonicalDir)) {
    for (const file of readdirSync(canonicalDir).filter((entry) => entry.endsWith(".md"))) {
      const path = join(canonicalDir, file);
      reservedFiles.add(file);
      canonicalNames.add(profileName(readFileSync(path, "utf8"), path));
    }
  }
  const writes: PlannedWrite[] = [];
  for (const file of readdirSync(legacyDir).filter((entry) => entry.endsWith(".md")).sort()) {
    const sourcePath = join(legacyDir, file);
    const content = readFileSync(sourcePath, "utf8");
    const name = profileName(content, sourcePath);
    if (canonicalNames.has(name)) continue;
    const targetFile = reservedFiles.has(file)
      ? availableProfileFileName(name, file, reservedFiles)
      : file;
    reservedFiles.add(targetFile);
    canonicalNames.add(name);
    writes.push({
      path: join(canonicalDir, targetFile),
      content: canonicalSubagentProfileDocumentFromLegacy(content, sourcePath),
      mode: 0o600,
    });
  }
  return writes;
}

function availableProfileFileName(profileName: string, originalFile: string, reserved: Set<string>): string {
  for (let salt = 0; ; salt += 1) {
    const digest = createHash("sha256")
      .update(`${profileName}\0${originalFile}\0${salt}`)
      .digest("hex")
      .slice(0, 20);
    const candidate = `legacy-${digest}.md`;
    if (!reserved.has(candidate)) return candidate;
  }
}

function profileName(content: string, path: string): string {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (lines[0]?.trim() !== "---" || end < 0) throw new Error(`Subagent Profile is invalid: ${path}`);
  const parsed = parseYaml(lines.slice(1, end).join("\n"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Subagent Profile is invalid: ${path}`);
  const raw = (parsed as Record<string, unknown>).name;
  return typeof raw === "string" && raw.trim() ? raw.trim() : basename(path, ".md");
}

function jsonWrite(path: string, value: unknown): PlannedWrite {
  return { path, content: `${JSON.stringify(value, null, 2)}\n`, mode: 0o600 };
}

function createBackup(plan: MigrationPlan, configDir: string): string {
  const suffix = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const backupRoot = join(configDir, "migration-backups", suffix);
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  for (const source of plan.backupSources) {
    const target = join(backupRoot, source.relativePath);
    mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
    cpSync(source.path, target, { recursive: true, force: false, errorOnExist: true });
  }
  return backupRoot;
}

function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, content, { mode, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function atomicCopyDirectory(source: string, target: string): void {
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    cpSync(source, temp, { recursive: statSync(source).isDirectory(), force: false, errorOnExist: true });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function restoreBackupSources(plan: MigrationPlan, backupRoot: string): void {
  for (const source of plan.backupSources) {
    const backup = join(backupRoot, source.relativePath);
    if (!existsSync(backup)) continue;
    rmSync(source.path, { recursive: true, force: true });
    mkdirSync(resolve(source.path, ".."), { recursive: true, mode: 0o700 });
    cpSync(backup, source.path, { recursive: true, force: false, errorOnExist: true });
  }
}

function deduplicatePlan(plan: MigrationPlan): MigrationPlan {
  const writes = new Map<string, PlannedWrite>();
  for (const write of plan.writes) {
    const existing = writes.get(write.path);
    if (existing && existing.content !== write.content) {
      throw new Error(`Migration would write conflicting canonical values to ${write.path}.`);
    }
    writes.set(write.path, write);
  }
  const copies = new Map<string, PlannedCopy>();
  for (const copy of plan.copies) {
    if (copies.has(copy.target)) throw new Error(`Migration would copy multiple legacy resources to ${copy.target}.`);
    copies.set(copy.target, copy);
  }
  return {
    ...plan,
    writes: [...writes.values()],
    copies: [...copies.values()],
    removals: [...new Set(plan.removals)],
  };
}

function printPlan(plan: MigrationPlan): void {
  for (const write of plan.writes) console.log(`WRITE ${write.path}`);
  for (const copy of plan.copies) console.log(`COPY ${copy.source} -> ${copy.target}`);
  for (const path of plan.removals) console.log(`REMOVE ${path}`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
