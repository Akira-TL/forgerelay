import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { repoRoot } from "../runtime.mjs";

export function curlRequest({ method = "GET", url, headers = {}, body }) {
  const marker = `__FORGERELAY_TRAFFIC_${randomUUID()}__`;
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    "20",
    "--request",
    method,
    "--dump-header",
    "-",
    "--output",
    "-",
    "--write-out",
    `\n${marker}%{http_code}|%{size_upload}|%{size_download}|%{size_request}|%{size_header}`,
  ];
  for (const [name, value] of Object.entries(headers)) args.push("--header", `${name}: ${value}`);
  if (body !== undefined) args.push("--data-binary", "@-");
  args.push(url);

  const result = spawnSync("curl", args, {
    cwd: repoRoot,
    input: body,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`curl ${method} ${url} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  const statusMarker = `\n${marker}`;
  const markerIndex = result.stdout.lastIndexOf(statusMarker);
  assert.notEqual(markerIndex, -1, `curl response did not contain status marker for ${url}`);
  const rawResponse = result.stdout.slice(0, markerIndex);
  const stats = result.stdout.slice(markerIndex + statusMarker.length).trim().split("|");
  const [status, sizeUpload, sizeDownload, sizeRequest, sizeHeader] = stats.map(Number);
  const separator = rawResponse.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const headerEnd = rawResponse.indexOf(separator);
  assert.notEqual(headerEnd, -1, `curl response did not contain headers for ${url}`);
  const headerBlock = rawResponse.slice(0, headerEnd);
  const responseBody = rawResponse.slice(headerEnd + separator.length);
  const responseHeaders = new Map();
  for (const line of headerBlock.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    responseHeaders.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return {
    status,
    headers: responseHeaders,
    body: responseBody,
    sizeUpload,
    sizeDownload,
    sizeRequest,
    sizeHeader,
  };
}

export function jsonLogEntries(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function requestLogEntries(path) {
  return jsonLogEntries(path).filter((entry) => entry.event === "http_request");
}

export function requestBodiesForRpc(entries, rpcTarget) {
  const requestIds = new Set(entries
    .filter((entry) => entry.event === "mcp_request" && entry.rpcTarget === rpcTarget)
    .map((entry) => entry.requestId)
    .filter(Boolean));
  return entries
    .filter((entry) => entry.event === "http_request" && requestIds.has(entry.requestId))
    .map((entry) => Number(entry.contentLength ?? 0))
    .filter((value) => Number.isFinite(value));
}

export function countBy(values, keyFor) {
  const result = {};
  for (const value of values) {
    const key = keyFor(value);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

export async function waitForHealth(child, baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`debug server exited before health check: ${child.exitCode}`);
    try {
      const response = jsonRequest(`${baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {
      // still starting
    }
    await delay(100);
  }
  throw new Error(`debug server did not become healthy on ${baseUrl}`);
}

export async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  await Promise.race([
    exited,
    delay(3000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

export async function assertPortsFree(ports) {
  const script = [
    "const net=require('node:net');",
    `const ports=${JSON.stringify(ports)};`,
    "let pending=ports.length; let bad=[];",
    "for(const port of ports){const s=net.connect({host:'127.0.0.1',port}); s.setTimeout(250);",
    "s.once('connect',()=>{bad.push(port);s.destroy();done();});",
    "s.once('error',()=>{s.destroy();done();}); s.once('timeout',()=>{s.destroy();done();});}",
    "function done(){if(--pending===0){if(bad.length){console.error('busy:'+bad.join(','));process.exit(2)}}}",
  ].join("");
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`reserved debug port already in use: ${result.stderr.trim()}`);
}

export function jsonBytes(value) {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return String(value);
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}


export function jsonRequest(url, options = {}) {
  const response = curlRequest({
    method: options.method ?? "GET",
    url,
    headers: options.headers,
    body: options.body,
  });
  return { ...response, json: JSON.parse(response.body) };
}
