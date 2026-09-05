import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commandShellCompatibilityWarning,
  commandShellSetupOptions,
  customPinnedPreference,
  defaultCommandShellSetupChoice,
  followLauncherPreference,
  preservePinnedPreference,
} from "./setup.js";

const root = mkdtempSync(join(tmpdir(), "forgerelay-shell-setup-test-"));
const spacedExecutable = join(root, "Portable Shell", "pwsh.exe");
const zshExecutable = join(root, "zsh");
await import("node:fs/promises").then(async ({ mkdir }) => mkdir(join(root, "Portable Shell"), { recursive: true }));
writeFileSync(spacedExecutable, "test");
writeFileSync(zshExecutable, "test");

test("Windows setup offers native shell families and custom executable selection", () => {
  const values = commandShellSetupOptions("win32", undefined, {
    family: "pwsh",
    executable: spacedExecutable,
  }).map((option) => option.value);
  assert.deepEqual(values, ["follow-launcher", "pwsh", "powershell", "cmd", "bash", "custom"]);
});

test("existing pinned shell is the rerun default and can be preserved exactly", () => {
  const current = {
    mode: "pinned" as const,
    family: "pwsh" as const,
    executable: spacedExecutable,
  };
  assert.equal(defaultCommandShellSetupChoice(current), "keep-pinned");
  assert.deepEqual(preservePinnedPreference(current, "win32", {}), current);
});

test("follow-launcher records the detected launcher as the fallback", () => {
  const preference = followLauncherPreference(
    undefined,
    { family: "zsh", executable: zshExecutable },
    "linux",
    {},
  );
  assert.deepEqual(preference, {
    mode: "follow-launcher",
    family: "zsh",
    executable: zshExecutable,
  });
});

test("follow-launcher preserves an existing recorded fallback when launcher detection is unavailable", () => {
  const current = {
    mode: "follow-launcher" as const,
    family: "zsh" as const,
    executable: zshExecutable,
  };
  assert.deepEqual(followLauncherPreference(current, undefined, "linux", {}), current);
});

test("custom pinned executable paths with spaces are preserved", () => {
  assert.deepEqual(customPinnedPreference("pwsh", spacedExecutable, "win32", {}), {
    mode: "pinned",
    family: "pwsh",
    executable: spacedExecutable,
  });
});

test("unavailable custom executables fail instead of silently changing shells", () => {
  assert.throws(
    () => customPinnedPreference("pwsh", join(root, "missing pwsh.exe"), "win32", {}),
    /Configured command-shell executable is unavailable/,
  );
});

test("zsh and fish selections expose compatibility warnings", () => {
  assert.match(commandShellCompatibilityWarning("zsh") ?? "", /Bash remains ForgeRelay's primary POSIX compatibility target/);
  assert.match(commandShellCompatibilityWarning("fish") ?? "", /compatibility is less mature than Bash/);
  assert.equal(commandShellCompatibilityWarning("bash"), undefined);
});
