import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { externalMcpCredentialIdentity } from "../../runtime/config/external-mcp-auth-store.js";
import {
  formatExternalMcpDoctor,
  formatExternalMcpList,
  inspectExternalMcpStatus,
  resolveExternalMcpScope,
} from "./status.js";

void test("External MCP CLI scope resolves ancestor Project config and explicit global scope", async (t) => {
  const context = createStatusContext(t);
  const nested = join(context.projectRoot, "src", "nested");
  mkdirSync(nested, { recursive: true });
  writeJson(join(context.configDir, "mcp.json"), {
    servers: {
      shared: { transport: "streamable-http", url: "https://global.example/mcp" },
      global: { transport: "stdio", command: "global-command" },
    },
  });
  writeJson(join(context.projectRoot, ".forgerelay", "mcp.json"), {
    servers: {
      shared: { transport: "streamable-http", url: "https://project.example/mcp" },
      project: { transport: "stdio", command: "project-command" },
    },
  });

  const project = await resolveExternalMcpScope({}, { cwd: nested, env: context.env });
  assert.equal(project.mode, "project");
  assert.equal(project.projectRoot, context.projectRoot);
  assert.equal(project.projectSelection, "ancestor-config");
  assert.equal(project.snapshot.origins.shared, "project");
  assert.equal(project.snapshot.origins.project, "project");
  assert.equal(project.snapshot.origins.global, "global");

  const global = await resolveExternalMcpScope({ global: true }, { cwd: nested, env: context.env });
  assert.equal(global.mode, "global");
  assert.equal(global.snapshot.origins.shared, "global");
  assert.equal(global.snapshot.origins.global, "global");
  assert.equal(global.snapshot.servers.project, undefined);

  const explicit = await resolveExternalMcpScope(
    { projectRoot: context.projectRoot },
    { cwd: context.root, env: context.env },
  );
  assert.equal(explicit.projectSelection, "explicit");
  assert.equal(explicit.projectRoot, context.projectRoot);

  await assert.rejects(
    resolveExternalMcpScope(
      { global: true, projectRoot: context.projectRoot },
      { cwd: nested, env: context.env },
    ),
    /--global and --project cannot be used together/i,
  );
});

void test("External MCP list and doctor expose status without credential or static-header secrets", async (t) => {
  const context = createStatusContext(t);
  writeJson(join(context.configDir, "mcp.json"), {
    servers: {
      authenticated: { transport: "streamable-http", url: "https://auth.example/mcp" },
      required: { transport: "streamable-http", url: "https://required.example/mcp" },
      reauth: { transport: "streamable-http", url: "https://reauth.example/mcp" },
      static: {
        transport: "streamable-http",
        url: "https://static.example/mcp",
        headers: { Authorization: "Bearer STATIC-SECRET-SENTINEL" },
      },
      local: { transport: "stdio", command: "local-command", env: { TOKEN: "ENV-SECRET-SENTINEL" } },
      disabled: { disabled: true },
    },
  });
  const scope = await resolveExternalMcpScope({ global: true }, { cwd: context.projectRoot, env: context.env });
  await scope.store.replace(
    externalMcpCredentialIdentity("global", "authenticated", context.projectRoot),
    "https://auth.example/mcp",
    {
      tokens: { access_token: "ACCESS-SECRET-SENTINEL", token_type: "bearer", scope: "mcp" },
      clientInformation: { client_id: "client-authenticated", client_secret: "CLIENT-SECRET-SENTINEL" },
    },
  );
  await scope.store.replace(
    externalMcpCredentialIdentity("global", "required", context.projectRoot),
    "https://required.example/mcp",
    {
      reauthorization: { reason: "authorization_required", observedAt: new Date().toISOString() },
    },
  );
  await scope.store.replace(
    externalMcpCredentialIdentity("global", "reauth", context.projectRoot),
    "https://reauth.example/mcp",
    {
      tokens: { access_token: "OLD-ACCESS-SECRET", token_type: "bearer", scope: "mcp" },
      reauthorization: {
        reason: "insufficient_scope",
        observedAt: new Date().toISOString(),
        scope: "mcp admin",
      },
    },
  );

  const status = inspectExternalMcpStatus(scope);
  const list = formatExternalMcpList(status);
  assert.match(list, /authenticated[\s\S]*auth: oauth · authenticated/);
  assert.match(list, /required[\s\S]*auth: oauth · auth required/);
  assert.match(list, /reauth[\s\S]*auth: oauth · reauthorization required/);
  assert.match(list, /static[\s\S]*auth: static · configured/);
  assert.match(list, /local[\s\S]*auth: config-managed/);
  assert.match(list, /disabled[\s\S]*status: disabled/);
  for (const secret of [
    "STATIC-SECRET-SENTINEL",
    "ENV-SECRET-SENTINEL",
    "ACCESS-SECRET-SENTINEL",
    "CLIENT-SECRET-SENTINEL",
    "OLD-ACCESS-SECRET",
  ]) {
    assert.doesNotMatch(list, new RegExp(secret));
  }

  const doctor = formatExternalMcpDoctor(status);
  assert.match(doctor, /Effective servers: 5/);
  assert.match(doctor, /Disabled: 1/);
  assert.match(doctor, /OAuth authenticated: 1/);
  assert.match(doctor, /Auth required: 1/);
  assert.match(doctor, /Reauthorization required: 1/);
  assert.match(doctor, /Hot reload: active/);
  assert.match(doctor, /Active checks: not run/);
});

void test("External MCP invalid live edit reports last-known-good status without exposing invalid content", async (t) => {
  const context = createStatusContext(t);
  const globalPath = join(context.configDir, "mcp.json");
  writeJson(globalPath, {
    servers: {
      stable: { transport: "streamable-http", url: "https://stable.example/mcp" },
    },
  });
  const scope = await resolveExternalMcpScope({ global: true }, { cwd: context.projectRoot, env: context.env });
  assert.equal(scope.snapshot.sources.find((source) => source.source === "global")?.state, "valid");

  writeFileSync(globalPath, '{"servers":{"secret":"DO-NOT-ECHO-INVALID-CONTENT"');
  const next = { ...scope, snapshot: scope.registry.resolveGlobal() };
  const status = inspectExternalMcpStatus(next);
  const list = formatExternalMcpList(status);
  assert.match(list, /global[\s\S]*invalid · using last-known-good/);
  assert.match(list, /Using this process's last-known-good configuration/);
  assert.match(list, /stable[\s\S]*status: configured/);
  assert.doesNotMatch(list, /DO-NOT-ECHO-INVALID-CONTENT/);
});

void test("External MCP status reports an invalid credential store without echoing persisted secret content", async (t) => {
  const context = createStatusContext(t);
  writeJson(join(context.configDir, "mcp.json"), {
    servers: {
      secure: { transport: "streamable-http", url: "https://secure.example/mcp" },
    },
  });
  writeFileSync(join(context.configDir, "mcp-auth.json"), '{"secret":"CREDENTIAL-SECRET-SENTINEL"');
  const scope = await resolveExternalMcpScope({ global: true }, { cwd: context.projectRoot, env: context.env });
  const status = inspectExternalMcpStatus(scope);
  const list = formatExternalMcpList(status);
  assert.equal(status.credentialStore, "invalid");
  assert.equal(status.configIssues, 1);
  assert.match(list, /mcp-auth\.json · invalid/);
  assert.doesNotMatch(list, /CREDENTIAL-SECRET-SENTINEL/);
});

function createStatusContext(t: test.TestContext): {
  root: string;
  configDir: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-mcp-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(projectRoot, ".forgerelay"), { recursive: true });
  const canonicalProjectRoot = realpathSync(projectRoot);
  writeJson(join(configDir, "config.json"), { allowedRoots: [canonicalProjectRoot] });
  writeJson(join(configDir, "auth.json"), { ownerToken: "status-test-owner-token-0123456789" });
  return {
    root,
    configDir,
    projectRoot: canonicalProjectRoot,
    env: {
      ...process.env,
      FORGERELAY_CONFIG_DIR: configDir,
      FORGERELAY_ALLOWED_ROOTS: projectRoot,
      FORGERELAY_WORKSPACE_ROOT: undefined,
    },
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
