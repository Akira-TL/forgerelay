import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectContextResolver } from "../../workspaces/state/project-context.js";
import { externalMcpConfigDefinition } from "./definition/external-mcp.js";
import { parseExternalMcpStandaloneConfig } from "./external-mcp-config.js";
import { resolveConfigDomain } from "./resolution/resolver.js";
import {
  ExternalMcpConfigRegistry,
  type ExternalMcpConfigDiagnostic,
} from "./external-mcp-registry.js";

const legacyServer = {
  transport: "streamable-http" as const,
  url: "https://legacy.example/mcp",
};

const globalServer = {
  transport: "streamable-http" as const,
  url: "https://global.example/mcp",
};

const projectServer = {
  transport: "streamable-http" as const,
  url: "https://project.example/mcp",
};

test("standalone External MCP config requires servers and supports strict disabled masks", () => {
  assert.deepEqual(parseExternalMcpStandaloneConfig({ servers: {} }), {});
  assert.deepEqual(parseExternalMcpStandaloneConfig({
    servers: { inherited: { disabled: true } },
  }), {
    inherited: { disabled: true },
  });
  assert.deepEqual(parseExternalMcpStandaloneConfig({
    servers: {
      configured: {
        transport: "streamable-http",
        url: "https://configured.example/mcp",
        disabled: true,
      },
      enabled: {
        transport: "streamable-http",
        url: "https://enabled.example/mcp",
        disabled: false,
      },
    },
  }), {
    configured: { disabled: true },
    enabled: {
      transport: "streamable-http",
      url: "https://enabled.example/mcp",
    },
  });
  assert.throws(
    () => parseExternalMcpStandaloneConfig({ servers: { invalid: { disabled: "yes" } } }),
    /must be a boolean/i,
  );
  assert.deepEqual(parseExternalMcpStandaloneConfig({
    servers: {
      cimd: {
        transport: "streamable-http",
        url: "https://mcp.example/mcp",
        oauth: {
          clientMetadataUrl: "https://client.example/forgerelay.json",
          callbackPort: 49152,
        },
      },
    },
  }), {
    cimd: {
      transport: "streamable-http",
      url: "https://mcp.example/mcp",
      oauth: {
        clientMetadataUrl: "https://client.example/forgerelay.json",
        callbackPort: 49152,
      },
    },
  });
  assert.throws(
    () => parseExternalMcpStandaloneConfig({
      servers: {
        invalid: {
          transport: "streamable-http",
          url: "https://mcp.example/mcp",
          oauth: { clientMetadataUrl: "http://client.example/forgerelay.json", callbackPort: 49152 },
        },
      },
    }),
    /clientMetadataUrl must use https/i,
  );
  assert.throws(
    () => parseExternalMcpStandaloneConfig({ servers: {}, extra: true }),
    /unsupported fields/i,
  );
});

test("External MCP interpolation is limited to env and headers and provenance never exposes resolved secrets", () => {
  const secret = "resolved-secret-sentinel";
  const resolution = resolveConfigDomain({
    definition: externalMcpConfigDefinition,
    sources: [{
      id: "canonical:user:mcp",
      scope: "user",
      kind: "file",
      location: "/tmp/mcp.json",
      priority: 100,
      value: {
        servers: {
          stdio: {
            transport: "stdio",
            command: "${SECRET_TOKEN}",
            env: { TOKEN: "prefix-${SECRET_TOKEN}" },
          },
          http: {
            transport: "streamable-http",
            url: "https://mcp.example/mcp",
            headers: { Authorization: "Bearer ${SECRET_TOKEN}" },
          },
        },
      },
    }],
    environment: { SECRET_TOKEN: secret },
  });

  const servers = resolution.values.servers as Record<string, Record<string, unknown>>;
  assert.equal(servers.stdio?.command, "${SECRET_TOKEN}");
  assert.deepEqual(servers.stdio?.env, { TOKEN: `prefix-${secret}` });
  assert.deepEqual(servers.http?.headers, { Authorization: `Bearer ${secret}` });
  assert.doesNotMatch(JSON.stringify(resolution.entries), new RegExp(secret));
  assert.match(JSON.stringify(resolution.entries), /\$\{SECRET_TOKEN\}/);
});

test("registry merges Project over global over legacy and disabled entries mask lower sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-external-mcp-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const project = join(root, "project");
  await mkdir(join(project, ".forgerelay"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  const globalPath = join(configDir, "mcp.json");
  const projectPath = join(project, ".forgerelay", "mcp.json");
  await writeJson(globalPath, {
    servers: {
      shared: globalServer,
      "global-only": globalServer,
      "legacy-only": { disabled: true },
    },
  });
  await writeJson(projectPath, {
    servers: {
      shared: projectServer,
      "global-only": { disabled: true },
      "project-only": projectServer,
    },
  });
  const registry = new ExternalMcpConfigRegistry({
    configDir,
    legacyServers: {
      shared: legacyServer,
      "legacy-only": legacyServer,
    },
  });
  const projectContext = await new ProjectContextResolver(configDir).resolve(project);

  const masked = registry.resolve(projectContext);
  assert.deepEqual(masked.servers, {
    shared: projectServer,
    "project-only": projectServer,
  });
  assert.deepEqual(masked.origins, {
    shared: "project",
    "project-only": "project",
  });
  assert.deepEqual(masked.masked, {
    "legacy-only": "global",
    "global-only": "project",
  });

  await replaceJson(projectPath, { servers: {} });
  const unmaskedProject = registry.resolve(projectContext);
  assert.deepEqual(unmaskedProject.servers, {
    shared: globalServer,
    "global-only": globalServer,
  });
  assert.deepEqual(unmaskedProject.origins, {
    shared: "global",
    "global-only": "global",
  });

  await unlink(projectPath);
  const deletedProject = registry.resolve(projectContext);
  assert.deepEqual(deletedProject.servers, unmaskedProject.servers);
  assert.equal(sourceStatus(deletedProject, "project").state, "missing");

  await unlink(globalPath);
  const deletedGlobal = registry.resolve(projectContext);
  assert.deepEqual(deletedGlobal.servers, {
    shared: legacyServer,
    "legacy-only": legacyServer,
  });
  assert.deepEqual(deletedGlobal.origins, {
    shared: "legacy",
    "legacy-only": "legacy",
  });
});

test("Project Local External MCP entries outrank Project entries and tombstones mask the whole inherited server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-external-mcp-project-local-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  await mkdir(project.sharedConfigDir, { recursive: true });
  await mkdir(project.localConfigDir, { recursive: true });
  await writeJson(join(project.sharedConfigDir, "mcp.json"), {
    servers: { shared: projectServer, masked: projectServer },
  });
  await writeJson(join(project.localConfigDir, "mcp.json"), {
    servers: { shared: globalServer, masked: { disabled: true } },
  });

  const snapshot = new ExternalMcpConfigRegistry({ configDir }).resolve(project);
  assert.deepEqual(snapshot.servers, { shared: globalServer });
  assert.equal(snapshot.origins.shared, "project-local");
  assert.equal(snapshot.masked.masked, "project-local");
  assert.equal(sourceStatus(snapshot, "project-local").state, "valid");
});

test("a present invalid canonical user mcp.json shadows legacy inline mcpServers on first load", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-external-mcp-canonical-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  await mkdir(configDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(configDir, "mcp.json"), '{"servers":{"broken":', "utf8");
  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  const registry = new ExternalMcpConfigRegistry({
    configDir,
    legacyServers: { legacy: legacyServer },
  });

  const snapshot = registry.resolve(project);
  assert.deepEqual(snapshot.servers, {});
  assert.equal(snapshot.origins.legacy, undefined);
  assert.equal(sourceStatus(snapshot, "global").state, "invalid");
  assert.equal(sourceStatus(snapshot, "global").usingLastKnownGood, false);
  assert.equal(snapshot.diagnostics.some((diagnostic) => diagnostic.source === "global" && diagnostic.severity === "error"), true);
});

test("invalid changed source keeps its whole last-known-good snapshot until a valid replacement arrives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-external-mcp-lkg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const project = join(root, "project");
  await mkdir(configDir, { recursive: true });
  await mkdir(join(project, ".forgerelay"), { recursive: true });
  const globalPath = join(configDir, "mcp.json");
  const diagnostics: ExternalMcpConfigDiagnostic[] = [];
  const registry = new ExternalMcpConfigRegistry({
    configDir,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const projectContext = await new ProjectContextResolver(configDir).resolve(project);

  await writeJson(globalPath, { servers: { first: globalServer } });
  const first = registry.resolve(projectContext);
  assert.deepEqual(first.servers, { first: globalServer });
  assert.equal(first.diagnostics.length, 0);

  await writeFile(globalPath, '{"servers":{"broken":', "utf8");
  const invalid = registry.resolve(projectContext);
  assert.deepEqual(invalid.servers, { first: globalServer });
  assert.equal(sourceStatus(invalid, "global").state, "invalid");
  assert.equal(sourceStatus(invalid, "global").usingLastKnownGood, true);
  assert.equal(invalid.diagnostics.length, 1);
  assert.equal(diagnostics.length, 1);

  const sameInvalid = registry.resolve(projectContext);
  assert.deepEqual(sameInvalid.servers, { first: globalServer });
  assert.equal(diagnostics.length, 1, "unchanged invalid content should not spam diagnostics");

  await replaceJson(globalPath, { servers: { second: projectServer } });
  const recovered = registry.resolve(projectContext);
  assert.deepEqual(recovered.servers, { second: projectServer });
  assert.equal(sourceStatus(recovered, "global").state, "valid");
  assert.equal(recovered.diagnostics.length, 0);
});

test("an operation snapshot remains stable after the backing file changes and the next resolve observes the replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-external-mcp-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const project = join(root, "project");
  await mkdir(configDir, { recursive: true });
  await mkdir(project, { recursive: true });
  const globalPath = join(configDir, "mcp.json");
  const registry = new ExternalMcpConfigRegistry({ configDir });
  const projectContext = await new ProjectContextResolver(configDir).resolve(project);

  await writeJson(globalPath, { servers: { shared: globalServer } });
  const started = registry.resolve(projectContext);
  await replaceJson(globalPath, { servers: { shared: projectServer } });

  assert.deepEqual(started.servers, { shared: globalServer });
  const next = registry.resolve(projectContext);
  assert.deepEqual(next.servers, { shared: projectServer });
});

function sourceStatus(
  snapshot: ReturnType<ExternalMcpConfigRegistry["resolve"]>,
  source: "global" | "project" | "project-local",
) {
  const status = snapshot.sources.find((entry) => entry.source === source);
  assert.ok(status);
  return status;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.replacement`;
  await writeJson(temporary, value);
  await rename(temporary, path);
}
