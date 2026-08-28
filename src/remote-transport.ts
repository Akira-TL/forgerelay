import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";

const SSH_START_TIMEOUT_MS = 15_000;
const SSH_COMMAND_TIMEOUT_MS = 15_000;
const SSH_STOP_TIMEOUT_MS = 2_000;

export function parseSshRoute(value: string): string[] {
  const route = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (route.length === 0) throw new Error("SSH route must contain at least one target.");
  for (const entry of route) {
    if (entry.startsWith("-") || /\s/.test(entry)) {
      throw new Error(`Invalid SSH route target: ${entry}`);
    }
  }
  return route;
}

export function defaultSshRouteAlias(route: string[]): string {
  const finalTarget = route.at(-1);
  if (!finalTarget) throw new Error("SSH route must contain a final target.");
  const at = finalTarget.lastIndexOf("@");
  return (at >= 0 ? finalTarget.slice(at + 1) : finalTarget).trim();
}

export async function readRemoteOwnerToken(sshRoute: string[]): Promise<string> {
  const { prefix, target } = sshDestinationArgs(sshRoute);
  const result = await runSshCommand([
    ...prefix,
    target,
    "forgerelay",
    "auth",
    "__owner-token",
  ]);
  const token = result.stdout.trim();
  if (!token) throw new Error("SSH owner-token command returned an empty token.");
  return token;
}

export async function withRemoteServiceEndpoint<T>(
  target: string,
  sshRoute: string[] | undefined,
  operation: (endpoint: string) => Promise<T>,
): Promise<T> {
  if (!sshRoute) return operation(target);

  const url = new URL(target);
  if (url.protocol === "https:") {
    throw new Error(
      "SSH-routed HTTPS service targets are not supported because loopback forwarding breaks TLS hostname verification; use the remote ForgeRelay HTTP loopback endpoint through SSH or direct HTTPS.",
    );
  }
  const remotePort = url.port || "80";
  const localPort = await allocateLoopbackPort();
  const { prefix, target: sshTarget } = sshDestinationArgs(sshRoute);
  const forwardSpec = `127.0.0.1:${localPort}:${url.hostname}:${remotePort}`;
  const tunnel = spawn("ssh", [
    ...prefix,
    "-v",
    "-N",
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    forwardSpec,
    sshTarget,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let forwardingReady = false;
  const readyMarker = `Local forwarding listening on 127.0.0.1 port ${localPort}`;
  const stderr = collectStream(tunnel.stderr, (value) => {
    if (value.includes(readyMarker)) forwardingReady = true;
  });
  let spawnError: Error | undefined;
  tunnel.once("error", (error) => {
    spawnError = error;
  });

  try {
    await waitForLoopbackPort(tunnel, localPort, stderr, () => spawnError, () => forwardingReady);
    const mapped = new URL(url);
    mapped.hostname = "127.0.0.1";
    mapped.port = String(localPort);
    try {
      return await operation(mapped.toString().replace(/\/$/, ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Remote service request through SSH tunnel failed: ${message}`, { cause: error });
    }
  } finally {
    await stopTunnel(tunnel);
  }
}

function sshDestinationArgs(sshRoute: string[]): { prefix: string[]; target: string } {
  if (sshRoute.length === 0) throw new Error("SSH route must contain a final target.");
  const target = sshRoute[sshRoute.length - 1];
  const jumps = sshRoute.slice(0, -1);
  return {
    prefix: jumps.length > 0 ? ["-J", jumps.join(",")] : [],
    target,
  };
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to allocate a local SSH forwarding port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function waitForLoopbackPort(
  process: ChildProcess,
  port: number,
  stderr: () => string,
  spawnError: () => Error | undefined,
  forwardingReady: () => boolean,
): Promise<void> {
  const deadline = Date.now() + SSH_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const error = spawnError();
    if (error) throw new Error(`Unable to start SSH tunnel: ${error.message}`);
    if (process.exitCode !== null) {
      throw new Error(formatSshFailure("SSH tunnel exited before forwarding was ready", process.exitCode, stderr()));
    }
    if (forwardingReady() && await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("SSH tunnel did not become ready before the connection timeout.");
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function runSshCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const child = spawn("ssh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = collectStream(child.stdout);
  const stderr = collectStream(child.stderr);
  const timeout = setTimeout(() => child.kill("SIGKILL"), SSH_COMMAND_TIMEOUT_MS);
  let code: number | null;
  let signal: NodeJS.Signals | null;
  try {
    [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to start SSH command: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (code !== 0) {
    const suffix = signal ? ` (${signal})` : "";
    throw new Error(formatSshFailure(`SSH command failed${suffix}`, code, stderr()));
  }
  return { stdout: stdout(), stderr: stderr() };
}

function collectStream(
  stream: NodeJS.ReadableStream,
  observe?: (value: string) => void,
): () => string {
  let value = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk) => {
    value += String(chunk);
    observe?.(value);
    if (value.length > 16_384) value = value.slice(-16_384);
  });
  return () => value;
}

async function stopTunnel(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  const closed = once(process, "close").then(() => true).catch(() => true);
  process.kill("SIGTERM");
  const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), SSH_STOP_TIMEOUT_MS));
  if (await Promise.race([closed, timedOut])) return;
  if (process.exitCode !== null) return;
  const killed = once(process, "close").then(() => undefined).catch(() => undefined);
  process.kill("SIGKILL");
  const killTimedOut = new Promise<void>((resolve) => setTimeout(resolve, SSH_STOP_TIMEOUT_MS));
  await Promise.race([killed, killTimedOut]);
}

function formatSshFailure(prefix: string, code: number | null, stderr: string): string {
  const detail = stderr.trim();
  return `${prefix} (exit ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`;
}
