import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, expandHomePath, resolveAllowedPath } from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/forgerelay"), resolve(home, "personal", "forgerelay"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/forgerelay", [join(home, "personal")]),
  resolve(home, "personal", "forgerelay"),
);

assert.equal(
  assertAllowedPath("~/personal/forgerelay", ["~/personal"]),
  resolve(home, "personal", "forgerelay"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", [home]),
  resolve(home, "file.txt"),
);
assert.throws(
  () => resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  /Path is outside allowed roots/,
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\forgerelay"]),
    /Path is outside allowed roots/,
  );
}
