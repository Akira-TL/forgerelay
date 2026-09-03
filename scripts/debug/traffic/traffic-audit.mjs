import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { activityRefreshDelayMs } from "../../../src/ui/activity/model.ts";
import { debugRoot, repoRoot } from "../runtime.mjs";
import { jsonRequest, curlRequest, jsonLogEntries, requestLogEntries, requestBodiesForRpc, countBy, waitForHealth, stopServer, assertPortsFree, jsonBytes, formatBytes } from "./support.mjs";


const mode = process.argv[2] ?? "all";
if (!["all", "local", "relay"].includes(mode)) {
  throw new Error("Usage: npm run traffic:audit -- [all|local|relay]");
}

const trafficRoot = resolve(debugRoot, "traffic-audit");
const findings = [];
let highTrafficFinding = false;

await assertPortsFree([7677, 7678]);
rmSync(trafficRoot, { recursive: true, force: true });
mkdirSync(trafficRoot, { recursive: true });

if (mode === "all" || mode === "local") await auditLocalTraffic();
if (mode === "all" || mode === "relay") await auditRelayTraffic();

console.log("\n=== ForgeRelay traffic audit ===");
for (const finding of findings) {
  console.log(`${finding.level.padEnd(5)} ${finding.name}`);
  for (const [key, value] of Object.entries(finding.metrics)) {
    console.log(`      ${key}: ${value}`);
  }
}
console.log(`\nArtifacts: ${trafficRoot}`);

if (highTrafficFinding) {
  console.error("\nTRAFFIC_AUDIT_RED: current implementation exceeds at least one conservative traffic budget.");
  process.exitCode = 2;
} else {
  console.log("\nTRAFFIC_AUDIT_GREEN: no configured traffic budget was exceeded.");
}

async function auditLocalTraffic() {
  const root = join(trafficRoot, "local");
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const worktreeRoot = join(root, "worktrees");
  const logPath = join(root, "server.jsonl");
  mkdirSync(configDir, { recursive: true });
  const ownerToken = randomBytes(32).toString("base64url");
  writeAuthFile(configDir, ownerToken, "traffic-audit-local");

  const env = instanceEnv({
    port: 7677,
    baseUrl: "http://127.0.0.1:7677",
    configDir,
    stateDir,
    worktreeRoot,
    allowedRoot: repoRoot,
    ownerToken,
    widgets: "full",
  });
  const server = spawnServer(env, "Local 7677", logPath);

  try {
    await waitForHealth(server, "http://127.0.0.1:7677");
    const host = authorizeHost("http://127.0.0.1:7677", "http://127.0.0.1:7677/mcp", ownerToken);
    const sessionId = initializeSession("http://127.0.0.1:7677/mcp", host.accessToken, 1, "traffic-audit-local");
    const meta = { "openai/session": "traffic-audit-local-conversation" };
    let id = 10;

    const full = callToolMeasured("http://127.0.0.1:7677/mcp", host.accessToken, sessionId, id++, "open_workspace", {
      path: repoRoot,
      context: "full",
    }, meta);
    const workspaceId = full.result.structuredContent.workspaceId;
    const auto = callToolMeasured("http://127.0.0.1:7677/mcp", host.accessToken, sessionId, id++, "open_workspace", {
      workspaceId,
      context: "auto",
    }, meta);
    const panel = callToolMeasured("http://127.0.0.1:7677/mcp", host.accessToken, sessionId, id++, "activity_panel", {
      workspaceId,
    }, meta);
    const turnId = panel.result.structuredContent.turnId;

    const fullBytes = full.http.sizeDownload;
    const autoBytes = auto.http.sizeDownload;
    const panelBytes = panel.http.sizeDownload;
    const autoRatio = fullBytes === 0 ? 0 : autoBytes / fullBytes;
    const panelRatio = fullBytes === 0 ? 0 : panelBytes / fullBytes;
    const autoCardBytes = jsonBytes(auto.result._meta?.card);
    const autoStructuredBytes = jsonBytes(auto.result.structuredContent);
    const panelWorkspace = panel.result._meta?.["forgerelay/activityPanelWorkspace"];
    const panelWorkspaceBytes = jsonBytes(panelWorkspace);
    const panelStructuredWorkspaceBytes = jsonBytes(
      panel.result.structuredContent?.["forgerelay/activityPanelWorkspace"],
    );
    addFinding(
      autoRatio >= 0.5 ? "HIGH" : autoRatio >= 0.2 ? "MED" : "LOW",
      "open_workspace context=auto wire reuse",
      {
        "full response body": formatBytes(fullBytes),
        "auto response body": formatBytes(autoBytes),
        "auto/full": autoRatio.toFixed(2),
        "auto _meta.card": formatBytes(autoCardBytes),
        "auto structuredContent": formatBytes(autoStructuredBytes),
        "activity_panel response body": formatBytes(panelBytes),
        "panel/full": panelRatio.toFixed(2),
        "panel workspace copy in _meta": formatBytes(panelWorkspaceBytes),
        "panel workspace copy in structuredContent": formatBytes(panelStructuredWorkspaceBytes),
      },
      autoRatio >= 0.5,
    );

    const bash = callToolMeasured("http://127.0.0.1:7677/mcp", host.accessToken, sessionId, id++, "bash", {
      workspaceId,
      command: `${JSON.stringify(process.execPath)} -e "let n=0; const chunk='x'.repeat(262144); const t=setInterval(()=>{process.stdout.write(chunk); n += 1; if(n===5){clearInterval(t); setTimeout(()=>process.exit(0), 1200)}}, 1000)"`,
      yieldTimeMs: 0,
      maxOutputTokens: 1000,
    }, meta);
    const outputId = bash.result.structuredContent.outputId;
    assert.equal(typeof outputId, "string");

    const outputPolls = [];
    let outputCursor;
    for (let poll = 0; poll < 5; poll += 1) {
      await delay(1100);
      const response = callToolMeasured(
        "http://127.0.0.1:7677/mcp",
        host.accessToken,
        sessionId,
        id++,
        "activity_output",
        {
          turnId,
          outputId,
          ...(outputCursor !== undefined ? { cursor: outputCursor } : {}),
        },
        meta,
      );
      const output = response.result.structuredContent.output;
      const nextCursor = response.result.structuredContent.cursor;
      if (Number.isInteger(nextCursor) && nextCursor >= 0) outputCursor = nextCursor;
      outputPolls.push({
        bodyBytes: response.http.sizeDownload,
        outputBytes: Buffer.byteLength(output ?? "", "utf8"),
        cursor: nextCursor,
        status: response.result.structuredContent.status,
      });
    }
    await delay(1500);

    const totalOutputResponseBytes = outputPolls.reduce((sum, item) => sum + item.bodyBytes, 0);
    const finalOutputBytes = 5 * 262_144;
    const outputAmplification = finalOutputBytes === 0 ? 0 : totalOutputResponseBytes / finalOutputBytes;
    addFinding(
      outputAmplification >= 2 ? "HIGH" : outputAmplification >= 1.25 ? "MED" : "LOW",
      "activity_output cumulative retransmission",
      {
        polls: String(outputPolls.length),
        "final durable output": formatBytes(finalOutputBytes),
        "downloaded response bodies": formatBytes(totalOutputResponseBytes),
        "response/final-output amplification": `${outputAmplification.toFixed(2)}x`,
        "per-poll output bytes": outputPolls.map((item) => formatBytes(item.outputBytes)).join(" -> "),
        "per-poll cursors": outputPolls.map((item) => String(item.cursor ?? "missing")).join(" -> "),
      },
      outputAmplification >= 2,
    );

    const changedSnapshot = callToolMeasured(
      "http://127.0.0.1:7677/mcp",
      host.accessToken,
      sessionId,
      id++,
      "activity_snapshot",
      { turnId },
      meta,
    );
    const revision = changedSnapshot.result.structuredContent.revision;
    const state = changedSnapshot.result.structuredContent.state;
    const stateStructured = changedSnapshot.result.structuredContent;
    const stateOnlyRegression = Object.hasOwn(stateStructured, "activities")
      || (changedSnapshot.result.content?.length ?? 0) !== 0;
    const explicitIndex = callToolMeasured(
      "http://127.0.0.1:7677/mcp",
      host.accessToken,
      sessionId,
      id++,
      "activity_index",
      { turnId },
      meta,
    );
    addFinding(
      stateOnlyRegression ? "HIGH" : "LOW",
      "Activity Panel state/index request tiers",
      {
        "state response body": formatBytes(changedSnapshot.http.sizeDownload),
        "state carries Activity rows": String(Object.hasOwn(stateStructured, "activities")),
        "state natural-language content items": String(changedSnapshot.result.content?.length ?? 0),
        "explicit index response body": formatBytes(explicitIndex.http.sizeDownload),
        "explicit index Activity rows": String(explicitIndex.result.structuredContent.activities?.length ?? 0),
        note: "Collapsed/default refresh uses state only; Activity rows are an explicit expanded-panel request.",
      },
      stateOnlyRegression,
    );
    const unchanged = [];
    for (let index = 0; index < 10; index += 1) {
      unchanged.push(callToolMeasured(
        "http://127.0.0.1:7677/mcp",
        host.accessToken,
        sessionId,
        id++,
        "activity_snapshot",
        { turnId, knownRevision: revision },
        meta,
      ));
    }
    const averageSnapshotBytes = unchanged.reduce((sum, item) => sum + item.http.sizeDownload, 0) / unchanged.length;
    const averageSnapshotHttpBytes = unchanged.reduce(
      (sum, item) => sum + item.http.sizeRequest + item.http.sizeHeader + item.http.sizeDownload,
      0,
    ) / unchanged.length;
    const hourlySnapshotHttpBytes = averageSnapshotHttpBytes * 3600;
    const workingBackoff = [0, 1, 2, 3].map((count) => activityRefreshDelayMs("working", count, true));
    const terminalDelay = activityRefreshDelayMs("done", 0, true);
    const hiddenDelay = activityRefreshDelayMs("working", 0, false);
    const pollingRegression = JSON.stringify(workingBackoff) !== JSON.stringify([1_000, 2_000, 5_000, 10_000])
      || terminalDelay !== null
      || hiddenDelay !== null;
    addFinding(
      pollingRegression ? "HIGH" : "LOW",
      "Activity Panel adaptive polling policy",
      {
        "turn state after Bash completion": String(state),
        "unchanged response body avg": formatBytes(averageSnapshotBytes),
        "unchanged HTTP avg": formatBytes(averageSnapshotHttpBytes),
        "working unchanged delays": workingBackoff.map((value) => `${value}ms`).join(" -> "),
        "terminal next poll": terminalDelay === null ? "stopped" : `${terminalDelay}ms`,
        "hidden next poll": hiddenDelay === null ? "stopped" : `${hiddenDelay}ms`,
        "legacy 1Hz HTTP cost avoided": `${formatBytes(hourlySnapshotHttpBytes)}/hour per live Panel`,
      },
      pollingRegression,
    );

    const assetFinding = auditActivityAssets();
    addFinding("LOW", "Activity Panel initial static assets", assetFinding, false);
  } finally {
    await stopServer(server);
  }
}

async function auditRelayTraffic() {
  const root = join(trafficRoot, "relay");
  const gatewayBaseUrl = "http://127.0.0.1:7677";
  const executionBaseUrl = "http://127.0.0.1:7678";
  const gatewayMcpUrl = `${gatewayBaseUrl}/mcp`;
  const gatewayConfigDir = join(root, "gateway", "config");
  const gatewayStateDir = join(root, "gateway", "state");
  const gatewayWorktreeRoot = join(root, "gateway", "worktrees");
  const gatewayProjectRoot = join(root, "gateway-projects");
  const executionConfigDir = join(root, "execution", "config");
  const executionStateDir = join(root, "execution", "state");
  const executionWorktreeRoot = join(root, "execution", "worktrees");
  const executionProjectRoot = join(root, "execution-projects");
  const executionCheckout = join(executionProjectRoot, "checkout");
  const gatewayLog = join(root, "gateway.jsonl");
  const executionLog = join(root, "execution.jsonl");
  const gatewayOwnerToken = randomBytes(32).toString("base64url");
  const executionOwnerToken = randomBytes(32).toString("base64url");

  mkdirSync(gatewayProjectRoot, { recursive: true });
  mkdirSync(executionCheckout, { recursive: true });
  writeFileSync(join(executionCheckout, "sentinel.txt"), "relay traffic audit\n");
  writeAuthFile(gatewayConfigDir, gatewayOwnerToken, "traffic-audit-gateway");
  writeAuthFile(executionConfigDir, executionOwnerToken, "traffic-audit-execution");

  const executionEnv = instanceEnv({
    port: 7678,
    baseUrl: executionBaseUrl,
    configDir: executionConfigDir,
    stateDir: executionStateDir,
    worktreeRoot: executionWorktreeRoot,
    allowedRoot: executionProjectRoot,
    ownerToken: executionOwnerToken,
    widgets: "off",
  });
  const gatewayEnv = instanceEnv({
    port: 7677,
    baseUrl: gatewayBaseUrl,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
    worktreeRoot: gatewayWorktreeRoot,
    allowedRoot: gatewayProjectRoot,
    ownerToken: gatewayOwnerToken,
    widgets: "off",
  });

  const execution = spawnServer(executionEnv, "Execution 7678", executionLog);
  let gateway;
  try {
    await waitForHealth(execution, executionBaseUrl);
    const authenticated = runCli(
      ["auth", "127.0.0.1:7678", "--token", executionOwnerToken, "--alias", "execution"],
      { ...cleanProductEnv(), FORGERELAY_CONFIG_DIR: gatewayConfigDir },
    );
    assert.equal(authenticated.status, 0, authenticated.stderr || authenticated.stdout);

    gateway = spawnServer(gatewayEnv, "Gateway 7677", gatewayLog);
    await waitForHealth(gateway, gatewayBaseUrl);
    const host = authorizeHost(gatewayBaseUrl, gatewayMcpUrl, gatewayOwnerToken);
    const sessionId = initializeSession(gatewayMcpUrl, host.accessToken, 1, "traffic-audit-relay");
    const meta = { "openai/session": "traffic-audit-relay-conversation" };
    let id = 100;

    const opened = callToolMeasured(gatewayMcpUrl, host.accessToken, sessionId, id++, "open_workspace", {
      path: executionCheckout,
      relay: "execution",
      context: "none",
    }, meta);
    const workspaceId = opened.result.structuredContent.workspaceId;
    const panel = callToolMeasured(gatewayMcpUrl, host.accessToken, sessionId, id++, "activity_panel", { workspaceId }, meta);
    const turnId = panel.result.structuredContent.turnId;
    callToolMeasured(gatewayMcpUrl, host.accessToken, sessionId, id++, "read", {
      workspaceId,
      path: "sentinel.txt",
    }, meta);

    await delay(100);
    const before = requestLogEntries(executionLog).length;
    const beforeLog = jsonLogEntries(executionLog).length;
    const snapshots = [];
    let knownRevision;
    for (let index = 0; index < 3; index += 1) {
      const snapshot = callToolMeasured(
        gatewayMcpUrl,
        host.accessToken,
        sessionId,
        id++,
        "activity_snapshot",
        { turnId, ...(knownRevision === undefined ? {} : { knownRevision }) },
        meta,
      );
      knownRevision = snapshot.result.structuredContent.revision;
      snapshots.push(snapshot);
    }
    await delay(150);
    const afterEntries = requestLogEntries(executionLog).slice(before);
    const snapshotLogs = jsonLogEntries(executionLog).slice(beforeLog);
    const mcpEntries = afterEntries.filter((entry) => entry.path === "/mcp");
    const methods = countBy(mcpEntries, (entry) => entry.method ?? "?");
    const executionRequestBodyBytes = mcpEntries.reduce((sum, entry) => {
      const value = Number(entry.contentLength ?? 0);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    const clientDownload = snapshots.reduce((sum, item) => sum + item.http.sizeDownload, 0);
    const relaySessionsCreated = snapshotLogs.filter(
      (entry) => entry.event === "mcp_transport_session_created",
    ).length;
    const relayConnectionChurn = relaySessionsCreated > 0 || mcpEntries.length > snapshots.length;
    addFinding(
      relayConnectionChurn ? "HIGH" : "LOW",
      "Relay activity_snapshot connection churn (7677 -> 7678)",
      {
        "Gateway snapshots": String(snapshots.length),
        "Execution /mcp HTTP requests": String(mcpEntries.length),
        "Execution requests per Gateway snapshot": (mcpEntries.length / snapshots.length).toFixed(2),
        "Execution methods": JSON.stringify(methods),
        "Execution request bodies": formatBytes(executionRequestBodyBytes),
        "Host <- Gateway snapshot bodies": formatBytes(clientDownload),
        "Execution transport sessions created": String(relaySessionsCreated),
      },
      relayConnectionChurn,
    );

    const compositeMeta = { "openai/session": "traffic-audit-composite-conversation" };
    const composite = callToolMeasured(gatewayMcpUrl, host.accessToken, sessionId, id++, "open_workspace", {
      kind: "composite",
      name: "Traffic audit composite",
    }, compositeMeta);
    const compositeWorkspaceId = composite.result.structuredContent.workspaceId;
    callToolMeasured(gatewayMcpUrl, host.accessToken, sessionId, id++, "open_workspace", {
      action: "member",
      workspaceId: compositeWorkspaceId,
      memberAction: "add",
      member: {
        name: "remote",
        purpose: "measure Relay Activity fanout",
        workspaceId,
      },
    }, compositeMeta);
    const compositePanel = callToolMeasured(
      gatewayMcpUrl,
      host.accessToken,
      sessionId,
      id++,
      "activity_panel",
      { workspaceId: compositeWorkspaceId },
      compositeMeta,
    );
    const compositeTurnId = compositePanel.result.structuredContent.turnId;
    callToolMeasured(gatewayMcpUrl, host.accessToken, sessionId, id++, "read", {
      workspaceId: compositeWorkspaceId,
      member: "remote",
      path: "sentinel.txt",
    }, compositeMeta);
    await delay(100);

    const compositeLogStart = jsonLogEntries(executionLog).length;
    const compositeFirst = callToolMeasured(
      gatewayMcpUrl,
      host.accessToken,
      sessionId,
      id++,
      "activity_snapshot",
      { turnId: compositeTurnId },
      compositeMeta,
    );
    const compositeRevision = compositeFirst.result.structuredContent.revision;
    const compositeSecond = callToolMeasured(
      gatewayMcpUrl,
      host.accessToken,
      sessionId,
      id++,
      "activity_snapshot",
      { turnId: compositeTurnId, knownRevision: compositeRevision },
      compositeMeta,
    );
    await delay(150);
    const compositeLogs = jsonLogEntries(executionLog).slice(compositeLogStart);
    const remoteSnapshotRequests = requestBodiesForRpc(compositeLogs, "activity_snapshot");
    const remoteSnapshotCalls = compositeLogs.filter(
      (entry) => entry.event === "activity_snapshot_call",
    );
    const repeatedMemberReadsUseRevision = remoteSnapshotCalls.length < 2 || remoteSnapshotCalls
      .slice(1)
      .every((entry) => Number.isInteger(entry.knownRevision));
    const compositeHttpRequests = compositeLogs.filter(
      (entry) => entry.event === "http_request" && entry.path === "/mcp",
    );
    const compositeFullReadRegression =
      compositeSecond.result.structuredContent.changed === false && !repeatedMemberReadsUseRevision;
    addFinding(
      compositeFullReadRegression ? "HIGH" : "LOW",
      "Composite member snapshot delta reuse",
      {
        "Gateway second snapshot changed": String(compositeSecond.result.structuredContent.changed),
        "Execution activity_snapshot tool calls": String(remoteSnapshotRequests.length),
        "Execution activity_snapshot known revisions": remoteSnapshotCalls
          .map((entry) => String(entry.knownRevision ?? "none"))
          .join(" -> "),
        "Execution activity_snapshot request body sizes": remoteSnapshotRequests.map((value) => `${value} B`).join(" -> "),
        "Execution /mcp HTTP requests for 2 Composite snapshots": String(compositeHttpRequests.length),
        note: "Repeated member state reads must carry the member revision or be skipped entirely.",
      },
      compositeFullReadRegression,
    );

    const compositeIndexLogStart = jsonLogEntries(executionLog).length;
    const compositeIndexFirst = callToolMeasured(
      gatewayMcpUrl,
      host.accessToken,
      sessionId,
      id++,
      "activity_index",
      { turnId: compositeTurnId },
      compositeMeta,
    );
    const compositeIndexRevision = compositeIndexFirst.result.structuredContent.revision;
    const compositeIndexSecond = callToolMeasured(
      gatewayMcpUrl,
      host.accessToken,
      sessionId,
      id++,
      "activity_index",
      { turnId: compositeTurnId, knownRevision: compositeIndexRevision },
      compositeMeta,
    );
    await delay(150);
    const compositeIndexLogs = jsonLogEntries(executionLog).slice(compositeIndexLogStart);
    const remoteIndexRequests = requestBodiesForRpc(compositeIndexLogs, "activity_index");
    const remoteIndexCalls = compositeIndexLogs.filter(
      (entry) => entry.event === "activity_index_call",
    );
    const repeatedIndexReadsUseRevision = remoteIndexCalls.length < 2 || remoteIndexCalls
      .slice(1)
      .every((entry) => Number.isInteger(entry.knownRevision));
    const compositeIndexRegression =
      compositeIndexSecond.result.structuredContent.changed !== false || !repeatedIndexReadsUseRevision;
    addFinding(
      compositeIndexRegression ? "HIGH" : "LOW",
      "Composite member Activity index delta reuse",
      {
        "Gateway first index rows": String(compositeIndexFirst.result.structuredContent.activities?.length ?? 0),
        "Gateway second index changed": String(compositeIndexSecond.result.structuredContent.changed),
        "Gateway second index rows": String(compositeIndexSecond.result.structuredContent.activities?.length ?? 0),
        "Execution activity_index tool calls": String(remoteIndexRequests.length),
        "Execution activity_index known revisions": remoteIndexCalls
          .map((entry) => String(entry.knownRevision ?? "none"))
          .join(" -> "),
        "Execution activity_index request body sizes": remoteIndexRequests.map((value) => `${value} B`).join(" -> "),
        note: "Expanded-panel member index reads must reuse member revisions instead of retransmitting unchanged rows.",
      },
      compositeIndexRegression,
    );
  } finally {
    if (gateway) await stopServer(gateway);
    await stopServer(execution);
  }
}

function auditActivityAssets() {
  const manifestPath = join(repoRoot, "dist", "ui", ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    return { status: "dist/ui manifest missing; run npm run build:app to measure assets" };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest["activity-panel-app.html"];
  if (!entry) return { status: "activity-panel-app.html missing from manifest" };
  const files = new Set();
  collectManifestFiles(manifest, "activity-panel-app.html", files);
  const bytes = [...files].reduce((sum, file) => sum + readFileSync(join(repoRoot, "dist", "ui", file)).byteLength, 0);
  return {
    files: String(files.size),
    "uncompressed bytes": formatBytes(bytes),
    note: "content-hashed assets are served immutable for one year",
  };
}

function collectManifestFiles(manifest, key, files) {
  const entry = manifest[key];
  if (!entry) return;
  if (entry.file) files.add(entry.file);
  for (const css of entry.css ?? []) files.add(css);
  for (const imported of entry.imports ?? []) collectManifestFiles(manifest, imported, files);
}

function addFinding(level, name, metrics, red) {
  findings.push({ level, name, metrics });
  if (red) highTrafficFinding = true;
}

function cleanProductEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    name !== "HOST"
    && name !== "PORT"
    && !name.startsWith("FORGERELAY_")
  ));
}

function instanceEnv({ port, baseUrl, configDir, stateDir, worktreeRoot, allowedRoot, ownerToken, widgets }) {
  return {
    ...cleanProductEnv(),
    HOST: "127.0.0.1",
    PORT: String(port),
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_PUBLIC_BASE_URL: baseUrl,
    FORGERELAY_ALLOWED_ROOTS: allowedRoot,
    FORGERELAY_STATE_DIR: stateDir,
    FORGERELAY_WORKTREE_ROOT: worktreeRoot,
    FORGERELAY_OAUTH_OWNER_TOKEN: ownerToken,
    FORGERELAY_TOOL_MODE: "full",
    FORGERELAY_WIDGETS: widgets,
    FORGERELAY_SKILLS: "1",
    FORGERELAY_SUBAGENTS: "0",
    FORGERELAY_ARTIFACTS: "0",
    FORGERELAY_LOG_LEVEL: "debug",
    FORGERELAY_LOG_FORMAT: "json",
    FORGERELAY_LOG_REQUESTS: "1",
    FORGERELAY_LOG_ASSETS: "1",
    FORGERELAY_LOG_TOOL_CALLS: "0",
  };
}

function writeAuthFile(configDir, ownerToken, instanceId) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "auth.json"), `${JSON.stringify({ ownerToken, instanceId }, null, 2)}\n`, { mode: 0o600 });
}

function spawnServer(env, label, logPath) {
  mkdirSync(resolve(logPath, ".."), { recursive: true });
  writeFileSync(logPath, "");
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => appendFileSync(logPath, chunk);
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("exit", (code, signal) => {
    if (code && code !== 0) console.error(`${label} exited with code ${code}${signal ? ` (${signal})` : ""}`);
  });
  return child;
}

function runCli(args, env) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

function authorizeHost(baseUrl, mcpUrl, ownerToken) {
  const metadata = jsonRequest(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(metadata.status, 200);
  const redirectUri = `${baseUrl}/debug/traffic-audit-callback`;
  const registration = jsonRequest(metadata.json.registration_endpoint, {
    method: "POST",
    body: JSON.stringify({
      client_name: "ForgeRelay traffic audit",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(registration.status, 201);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = curlRequest({
    method: "POST",
    url: metadata.json.authorization_endpoint,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: registration.json.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "forgerelay",
      resource: mcpUrl,
      state: "traffic-audit",
      owner_token: ownerToken,
    }).toString(),
  });
  assert.equal(authorization.status, 302);
  const redirect = new URL(authorization.headers.get("location"));
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  const token = jsonRequest(metadata.json.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.json.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: mcpUrl,
    }).toString(),
  });
  assert.equal(token.status, 200);
  assert.ok(token.json.access_token);
  return { accessToken: token.json.access_token };
}

function initializeSession(mcpUrl, accessToken, id, clientName) {
  const initialized = mcpRequest(mcpUrl, accessToken, undefined, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  });
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  const notification = curlRequest({
    method: "POST",
    url: mcpUrl,
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notification.status, 202);
  return sessionId;
}

function callToolMeasured(mcpUrl, accessToken, sessionId, id, name, args, meta) {
  const request = {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      ...(meta ? { _meta: meta } : {}),
    },
  };
  const measured = mcpRequest(mcpUrl, accessToken, sessionId, request);
  assert.equal(measured.message.id, id);
  assert.ok(measured.message.result, `tool ${name} did not return a result`);
  if (measured.message.result.isError) {
    throw new Error(`tool ${name} failed: ${JSON.stringify(measured.message.result.content)}`);
  }
  return { result: measured.message.result, http: measured.response };
}

function mcpRequest(mcpUrl, accessToken, sessionId, request) {
  const response = curlRequest({
    method: "POST",
    url: mcpUrl,
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200, response.body);
  return { response, message: parseMcpMessage(response.body, request.id) };
}

function mcpHeaders(accessToken, sessionId) {
  return {
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
}

function parseMcpMessage(body, expectedId) {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const messages = dataLines.length > 0
    ? dataLines.map((line) => JSON.parse(line))
    : [JSON.parse(body)];
  return messages.find((message) => message.id === expectedId) ?? messages[0];
}

