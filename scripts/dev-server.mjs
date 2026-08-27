import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync, watch } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const watchRoots = ["src"].map((entry) => join(repoRoot, entry));
const uiRoot = join(repoRoot, "src", "ui");
const restartDelayMs = 750;
const crashDelayMs = 1500;

let child;
let restartTimer;
let stoppingForRestart = false;
let shuttingDown = false;
let uiBuildDirty = false;

function log(message) {
  console.error(`[forgerelay:dev] ${message}`);
}

function buildUi() {
  log("building MCP App UI");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "build:app"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status === 0) {
    uiBuildDirty = false;
    return true;
  }
  log(`MCP App UI build failed (${result.signal ?? result.status ?? "unknown"})`);
  return false;
}

function isUiSourcePath(path) {
  return path === uiRoot || path.startsWith(`${uiRoot}${sep}`);
}

function start() {
  stoppingForRestart = false;
  child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    child = undefined;
    if (shuttingDown) return;
    if (stoppingForRestart) return;

    log(`server exited (${signal ?? code ?? "unknown"}); restarting in ${crashDelayMs}ms`);
    scheduleRestart(crashDelayMs);
  });
}

function scheduleRestart(delayMs = restartDelayMs) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restart, delayMs);
}

function restart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);

  if (uiBuildDirty && !buildUi()) {
    scheduleRestart(crashDelayMs);
    return;
  }

  if (!child) {
    start();
    return;
  }

  stoppingForRestart = true;
  child.once("exit", () => {
    if (!shuttingDown) start();
  });
  child.kill("SIGTERM");

  setTimeout(() => {
    if (child && stoppingForRestart) child.kill("SIGKILL");
  }, 3000).unref();
}

function watchDirectory(root) {
  const watchers = [];
  const seen = new Set();

  function addDirectory(dir) {
    if (seen.has(dir)) return;
    seen.add(dir);

    const watcher = watch(dir, (event, filename) => {
      if (!filename) {
        scheduleRestart();
        return;
      }

      const path = join(dir, filename.toString());
      if (event === "rename") maybeAddDirectory(path);
      if (isUiSourcePath(path)) uiBuildDirty = true;
      scheduleRestart();
    });
    watchers.push(watcher);

    for (const entry of readdirSync(dir)) {
      maybeAddDirectory(join(dir, entry));
    }
  }

  function maybeAddDirectory(path) {
    try {
      const stats = statSync(path);
      if (stats.isDirectory()) addDirectory(path);
    } catch {
      // The file may have been deleted between the watch event and stat call.
    }
  }

  addDirectory(root);
  return watchers;
}

function shutdown() {
  shuttingDown = true;
  clearTimeout(restartTimer);
  if (!child) return process.exit(0);

  child.once("exit", () => process.exit(0));
  child.kill("SIGTERM");
  setTimeout(() => process.exit(1), 3000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, shutdown);
}

for (const root of watchRoots) {
  watchDirectory(root);
}

log("watching src; UI changes rebuild MCP App assets before server restart");
if (!buildUi()) process.exit(1);
start();
