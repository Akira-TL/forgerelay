import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function createParitySandbox(repoRoot) {
  const sandbox = mkdtempSync(join(tmpdir(), "forgerelay-release-parity-node22-"));
  copyTrackedTree(repoRoot, sandbox);
  initializeGitIndex(sandbox);
  return sandbox;
}

function initializeGitIndex(sandbox) {
  execFileSync("git", ["init", "--quiet"], {
    cwd: sandbox,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "--force", "--all", "--", "."], {
    cwd: sandbox,
    stdio: "ignore",
  });
}

function copyTrackedTree(repoRoot, destinationRoot) {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  for (const relativePath of files) {
    const source = join(repoRoot, relativePath);
    const destination = join(destinationRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true });
  }
}
