import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  seedShellInstructionFiles,
  shellInstructionFamiliesToSeed,
  shellInstructionPath,
  shellInstructionTemplateUrl,
} from "./shell-instructions.js";

test("template URLs are pinned to the exact ForgeRelay release tag", () => {
  assert.equal(
    shellInstructionTemplateUrl("0.10.0", "pwsh"),
    "https://raw.githubusercontent.com/Akira-TL/forgerelay/v0.10.0/templates/instructions/pwsh.md",
  );
  assert.equal(
    shellInstructionTemplateUrl("v0.10.1", "cmd"),
    "https://raw.githubusercontent.com/Akira-TL/forgerelay/v0.10.1/templates/instructions/cmd.md",
  );
});

test("Windows seeds all native guidance families while explicit zsh/fish selections also seed their compatibility guidance", () => {
  assert.deepEqual(shellInstructionFamiliesToSeed("win32", "cmd"), ["pwsh", "powershell", "cmd"]);
  assert.deepEqual(shellInstructionFamiliesToSeed("win32", "zsh"), ["pwsh", "powershell", "cmd", "zsh"]);
  assert.deepEqual(shellInstructionFamiliesToSeed("linux", "bash"), []);
  assert.deepEqual(shellInstructionFamiliesToSeed("darwin", "zsh"), ["zsh"]);
  assert.deepEqual(shellInstructionFamiliesToSeed("linux", "fish"), ["fish"]);
});

test("seeding writes editable config-owned files and preserves user changes on rerun", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-shell-instructions-test-"));
  const requested: string[] = [];
  const first = await seedShellInstructionFiles({
    configDir: root,
    version: "0.10.0",
    families: ["pwsh", "cmd"],
    fetchText: async (url) => {
      requested.push(url);
      return `downloaded ${url}`;
    },
  });
  assert.deepEqual(first.map((entry) => entry.status), ["created", "created"]);
  assert.equal(requested.length, 2);

  const pwshPath = shellInstructionPath(root, "pwsh");
  assert.ok(pwshPath);
  await writeFile(pwshPath, "user customized\n", "utf8");
  requested.length = 0;
  const second = await seedShellInstructionFiles({
    configDir: root,
    version: "0.10.0",
    families: ["pwsh", "cmd"],
    fetchText: async (url) => {
      requested.push(url);
      return `unexpected ${url}`;
    },
  });
  assert.deepEqual(second.map((entry) => entry.status), ["preserved", "preserved"]);
  assert.equal(requested.length, 0);
  assert.equal(await readFile(pwshPath, "utf8"), "user customized\n");
});

test("explicit reset reseeds an existing customized file", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-shell-instructions-reset-test-"));
  const instructions = join(root, "instructions");
  await mkdir(instructions, { recursive: true });
  const path = join(instructions, "pwsh.md");
  await writeFile(path, "custom\n", "utf8");

  const result = await seedShellInstructionFiles({
    configDir: root,
    version: "0.10.0",
    families: ["pwsh"],
    reset: true,
    fetchText: async () => "official\n",
  });
  assert.equal(result[0]?.status, "created");
  assert.equal(await readFile(path, "utf8"), "official\n");
});

test("failed downloads are visible and do not create fake loaded content", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-shell-instructions-failure-test-"));
  const result = await seedShellInstructionFiles({
    configDir: root,
    version: "0.10.0",
    families: ["powershell"],
    fetchText: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(result[0]?.status, "failed");
  assert.match(result[0]?.error ?? "", /offline/);
  await assert.rejects(() => readFile(result[0]!.path, "utf8"), /ENOENT/);
});
