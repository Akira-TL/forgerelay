import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRuntimePrivilegeAllowed,
  detectRuntimePrivilege,
  elevatedRuntimeWarning,
  formatRuntimePrivilege,
} from "./runtime-privilege.js";

test("POSIX privilege detection uses effective uid", () => {
  assert.equal(detectRuntimePrivilege({ platform: "linux", geteuid: () => 1000 }).level, "standard");
  assert.equal(detectRuntimePrivilege({ platform: "darwin", geteuid: () => 0 }).level, "elevated");
});

test("Windows privilege detection identifies an actually elevated high-integrity token", () => {
  const state = detectRuntimePrivilege({
    platform: "win32",
    runWindowsWhoami(args) {
      if (args[0] === "/user") {
        return { status: 0, stdout: '"DESKTOP\\Akira","S-1-5-21-1-2-3-1001"\n', stderr: "" };
      }
      return {
        status: 0,
        stdout: [
          '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"',
          '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""',
        ].join("\n"),
        stderr: "",
      };
    },
  });

  assert.equal(state.level, "elevated");
  assert.match(state.detail ?? "", /12288/);
});

test("Windows privilege detection does not treat Administrators membership alone as elevation", () => {
  const state = detectRuntimePrivilege({
    platform: "win32",
    runWindowsWhoami(args) {
      if (args[0] === "/user") {
        return { status: 0, stdout: '"DESKTOP\\Akira","S-1-5-21-1-2-3-1001"\n', stderr: "" };
      }
      return {
        status: 0,
        stdout: [
          '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"',
          '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
        ].join("\n"),
        stderr: "",
      };
    },
  });

  assert.equal(state.level, "standard");
});

test("Windows privilege detection identifies LocalSystem", () => {
  const state = detectRuntimePrivilege({
    platform: "win32",
    runWindowsWhoami(args) {
      if (args[0] === "/user") {
        return { status: 0, stdout: '"NT AUTHORITY\\SYSTEM","S-1-5-18"\n', stderr: "" };
      }
      return {
        status: 0,
        stdout: '"Mandatory Label\\System Mandatory Level","Label","S-1-16-16384",""\n',
        stderr: "",
      };
    },
  });

  assert.equal(state.level, "elevated");
  assert.match(state.detail ?? "", /LocalSystem/);
});

test("Windows privilege detection fails closed when token inspection is unavailable", () => {
  const state = detectRuntimePrivilege({
    platform: "win32",
    runWindowsWhoami: () => ({ status: 1, stdout: "", stderr: "access denied" }),
  });

  assert.equal(state.level, "unknown");
  assert.match(state.detail ?? "", /access denied/);
  assert.throws(() => assertRuntimePrivilegeAllowed(state, false), /could not safely determine/);
  assert.doesNotThrow(() => assertRuntimePrivilegeAllowed(state, true));
});

test("elevated startup is denied without an invocation-scoped acknowledgement", () => {
  const state = detectRuntimePrivilege({ platform: "linux", geteuid: () => 0 });
  assert.throws(
    () => assertRuntimePrivilegeAllowed(state, false),
    /forgerelay serve --allow-elevated/,
  );
  assert.doesNotThrow(() => assertRuntimePrivilegeAllowed(state, true));
  assert.equal(formatRuntimePrivilege(state), "elevated");
  assert.match(elevatedRuntimeWarning(state), /system-wide or irreversible changes/);
});
