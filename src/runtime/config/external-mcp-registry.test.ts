import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseExternalMcpStandaloneConfig } from "./external-mcp-config.js";
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
  assert.throws(
    () => parseExternalMcpStandaloneConfig({ servers: {}, extra: true }),
    /unsupported fields/i,
  );
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

  const masked = registry.resolve(project);
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
  const unmaskedProject = registry.resolve(project);
  assert.deepEqual(unmaskedProject.servers, {
    shared: globalServer,
    "global-only": globalServer,
  });
  assert.deepEqual(unmaskedProject.origins, {
    shared: "global",
    "global-only": "global",
  });

  await unlink(projectPath);
  const deletedProject = registry.resolve(project);
  assert.deepEqual(deletedProject.servers, unmaskedProject.servers);
  assert.equal(sourceStatus(deletedProject, "project").state, "missing");

  await unlink(globalPath);
  const deletedGlobal = registry.resolve(project);
  assert.deepEqual(deletedGlobal.servers, {
    shared: legacyServer,
    "legacy-only": legacyServer,
  });
  assert.deepEqual(deletedGlobal.origins, {
    shared: "legacy",
    "legacy-only": "legacy",
  });
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

  await writeJson(globalPath, { servers: { first: globalServer } });
  const first = registry.resolve(project);
  assert.deepEqual(first.servers, { first: globalServer });
  assert.equal(first.diagnostics.length, 0);

  await writeFile(globalPath, '{"servers":{"broken":', "utf8");
  const invalid = registry.resolve(project);
  assert.deepEqual(invalid.servers, { first: globalServer });
  assert.equal(sourceStatus(invalid, "global").state, "invalid");
  assert.equal(sourceStatus(invalid, "global").usingLastKnownGood, true);
  assert.equal(invalid.diagnostics.length, 1);
  assert.equal(diagnostics.length, 1);

  const sameInvalid = registry.resolve(project);
  assert.deepEqual(sameInvalid.servers, { first: globalServer });
  assert.equal(diagnostics.length, 1, "unchanged invalid content should not spam diagnostics");

  await replaceJson(globalPath, { servers: { second: projectServer } });
  const recovered = registry.resolve(project);
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

  await writeJson(globalPath, { servers: { shared: globalServer } });
  const started = registry.resolve(project);
  await replaceJson(globalPath, { servers: { shared: projectServer } });

  assert.deepEqual(started.servers, { shared: globalServer });
  const next = registry.resolve(project);
  assert.deepEqual(next.servers, { shared: projectServer });
});

function sourceStatus(
  snapshot: ReturnType<ExternalMcpConfigRegistry["resolve"]>,
  source: "global" | "project",
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
