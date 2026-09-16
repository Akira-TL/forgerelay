import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("FORGERELAY_")),
) as NodeJS.ProcessEnv;

const root = mkdtempSync(join(tmpdir(), "forgerelay-general-config-cli-test-"));
try {
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    host: "localhost",
    port: 7711,
  }, null, 2) + "\n");

  const output = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "get", "--global"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...cleanProductEnv,
        FORGERELAY_CONFIG_DIR: configDir,
        PORT: "7722",
      },
    },
  );
  const effective = JSON.parse(output) as Record<string, unknown>;
  assert.equal(effective.host, "localhost");
  assert.equal(effective.port, 7722);
  assert.equal(effective.artifactsEnabled, false);

  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const explicitProject = JSON.parse(execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "get", "--project", projectRoot],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir, PORT: "7733" },
    },
  )) as Record<string, unknown>;
  assert.equal(explicitProject.host, "localhost");
  assert.equal(explicitProject.port, 7733);

  const currentProject = JSON.parse(execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "get"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...cleanProductEnv,
        FORGERELAY_CONFIG_DIR: configDir,
        FORGERELAY_WORKSPACE_ROOT: projectRoot,
        PORT: "7744",
      },
    },
  )) as Record<string, unknown>;
  assert.equal(currentProject.port, 7744);
  assert.equal(existsSync(join(configDir, "projects")), false);

  execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "set", "config.port", "7755", "--global"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir },
    },
  );
  let persistedAfterSet = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(persistedAfterSet.port, 7755);

  execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "set", "config.allowedHosts", '["alpha.local","beta.local"]', "--global"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir } },
  );
  execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "set", "config.retention", '{"historyDays":14}', "--global"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir } },
  );
  execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "set", "config.host", "relay.home.arpa", "--global"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir } },
  );
  persistedAfterSet = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(persistedAfterSet.allowedHosts, ["alpha.local", "beta.local"]);
  assert.deepEqual(persistedAfterSet.retention, { historyDays: 14 });
  assert.equal(persistedAfterSet.host, "relay.home.arpa");

  execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "unset", "config.port", "--global"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir } },
  );
  const persistedAfterUnset = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(persistedAfterUnset, "port"), false);

  const beforeRejectedProjectWrite = readFileSync(join(configDir, "config.json"), "utf8");
  const rejectedProjectWrite = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "set", "config.port", "7766"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...cleanProductEnv,
        FORGERELAY_CONFIG_DIR: configDir,
        FORGERELAY_WORKSPACE_ROOT: projectRoot,
      },
    },
  );
  assert.equal(rejectedProjectWrite.status, 1);
  assert.match(rejectedProjectWrite.stderr, /Unrecognized key/);
  assert.equal(readFileSync(join(configDir, "config.json"), "utf8"), beforeRejectedProjectWrite);
  assert.equal(existsSync(join(projectRoot, ".forgerelay", "config.json")), false);

  const missingProjectWrite = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "set", "config.port", "7767"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...cleanProductEnv,
        FORGERELAY_CONFIG_DIR: configDir,
        FORGERELAY_WORKSPACE_ROOT: join(root, "missing-project"),
      },
    },
  );
  assert.equal(missingProjectWrite.status, 1);
  assert.match(missingProjectWrite.stderr, /ENOENT|no such file/i);
  assert.equal(readFileSync(join(configDir, "config.json"), "utf8"), beforeRejectedProjectWrite);

  const projectId = "proj_0123456789abcdefabcd";
  const projectsDir = join(configDir, "projects");
  const localConfigDir = join(projectsDir, projectId);
  mkdirSync(localConfigDir, { recursive: true });
  writeFileSync(join(projectsDir, "non-git-identities.json"), JSON.stringify({
    version: 1,
    projects: { [projectRoot]: projectId },
  }, null, 2) + "\n");
  const localConfigPath = join(localConfigDir, "config.json");
  writeFileSync(localConfigPath, JSON.stringify({ port: 7799 }, null, 2) + "\n");
  const projectLocalRead = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "get", "--project", projectRoot],
    { cwd: process.cwd(), encoding: "utf8", env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir } },
  );
  assert.equal(projectLocalRead.status, 1);
  assert.ok(projectLocalRead.stderr.includes(localConfigPath), projectLocalRead.stderr);
  rmSync(localConfigPath, { force: true });

  const conflictingScope = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "get", "--global", "--project", projectRoot],
    { cwd: process.cwd(), encoding: "utf8", env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir } },
  );
  assert.equal(conflictingScope.status, 1);
  assert.match(conflictingScope.stderr, /--global and --project cannot be used together/);

  const projectLocalScope = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "get", "--project-local"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir } },
  );
  assert.equal(projectLocalScope.status, 1);
  assert.match(projectLocalScope.stderr, /--project-local is not a public configuration scope/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
