import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConfigSourceRuntime,
  fingerprintSourceUnits,
  type ConfigSourceRefreshIssue,
} from "./source-refresh.js";

const invalidJson: ConfigSourceRefreshIssue = {
  code: "invalid_source",
  message: "Configuration source is not valid JSON.",
};

function parseJson(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

test("Config source refresh is content-fingerprint driven and keeps LKG only for invalid replacements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-config-source-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  const runtime = new ConfigSourceRuntime();

  await writeFile(path, '{"value":"first"}\n', "utf8");
  const first = runtime.refreshFile({ key: "config:user", path, parse: parseJson, parseIssue: invalidJson });
  assert.equal(first.status.state, "valid");
  assert.equal(first.status.changed, true);
  assert.equal(first.status.usingLastKnownGood, false);
  assert.deepEqual(first.value, { value: "first" });

  const same = runtime.refreshFile({ key: "config:user", path, parse: parseJson, parseIssue: invalidJson });
  assert.equal(same.status.changed, false);
  assert.equal(same.status.observedFingerprint, first.status.observedFingerprint);

  await writeFile(path, '{"value":', "utf8");
  const invalid = runtime.refreshFile({ key: "config:user", path, parse: parseJson, parseIssue: invalidJson });
  assert.equal(invalid.status.state, "invalid");
  assert.equal(invalid.status.usingLastKnownGood, true);
  assert.equal(invalid.status.diagnosticChanged, true);
  assert.deepEqual(invalid.value, { value: "first" });
  assert.equal(invalid.status.effectiveFingerprint, first.status.effectiveFingerprint);

  const sameInvalid = runtime.refreshFile({ key: "config:user", path, parse: parseJson, parseIssue: invalidJson });
  assert.equal(sameInvalid.status.changed, false);
  assert.equal(sameInvalid.status.diagnosticChanged, false);
  assert.deepEqual(sameInvalid.value, { value: "first" });

  await writeFile(path, '{"value":"second"}\n', "utf8");
  const repaired = runtime.refreshFile({ key: "config:user", path, parse: parseJson, parseIssue: invalidJson });
  assert.equal(repaired.status.state, "valid");
  assert.deepEqual(repaired.value, { value: "second" });
  assert.notEqual(repaired.status.effectiveFingerprint, first.status.effectiveFingerprint);

  await unlink(path);
  const deleted = runtime.refreshFile({ key: "config:user", path, parse: parseJson, parseIssue: invalidJson });
  assert.equal(deleted.status.state, "missing");
  assert.equal(deleted.value, undefined);
  assert.equal(deleted.status.usingLastKnownGood, false);
  assert.equal(deleted.status.effectiveFingerprint, undefined);

  await writeFile(path, '{"value":', "utf8");
  const invalidAfterDeletion = runtime.refreshFile({ key: "config:user", path, parse: parseJson, parseIssue: invalidJson });
  assert.equal(invalidAfterDeletion.status.state, "invalid");
  assert.equal(invalidAfterDeletion.status.usingLastKnownGood, false);
  assert.equal(invalidAfterDeletion.value, undefined);
});

test("directory refresh fingerprints sorted source units and retains LKG per independent file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-config-directory-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "hooks");
  await mkdir(directory, { recursive: true });
  const runtime = new ConfigSourceRuntime();

  assert.equal(
    fingerprintSourceUnits([
      { name: "b.json", fingerprint: "b" },
      { name: "a.json", fingerprint: "a" },
    ]),
    fingerprintSourceUnits([
      { name: "a.json", fingerprint: "a" },
      { name: "b.json", fingerprint: "b" },
    ]),
  );

  await writeFile(join(directory, "b.json"), '{"command":"b"}\n', "utf8");
  await writeFile(join(directory, "a.json"), '{"command":"a"}\n', "utf8");
  const first = runtime.refreshDirectory({
    key: "hooks:user",
    directory,
    include: (name) => name.endsWith(".json"),
    parse: (_name, content) => parseJson(content),
    parseIssue: invalidJson,
  });
  assert.deepEqual(first.units.map((unit) => unit.name), ["a.json", "b.json"]);
  assert.deepEqual(first.units.map((unit) => unit.value?.command), ["a", "b"]);

  await writeFile(join(directory, "a.json"), "{ invalid", "utf8");
  const invalidA = runtime.refreshDirectory({
    key: "hooks:user",
    directory,
    include: (name) => name.endsWith(".json"),
    parse: (_name, content) => parseJson(content),
    parseIssue: invalidJson,
  });
  assert.equal(invalidA.units[0]?.status.state, "invalid");
  assert.equal(invalidA.units[0]?.status.usingLastKnownGood, true);
  assert.equal(invalidA.units[0]?.value?.command, "a");
  assert.equal(invalidA.units[1]?.value?.command, "b");
  assert.notEqual(invalidA.observedFingerprint, first.observedFingerprint);
  assert.equal(invalidA.effectiveFingerprint, first.effectiveFingerprint);

  await unlink(join(directory, "a.json"));
  const deletedA = runtime.refreshDirectory({
    key: "hooks:user",
    directory,
    include: (name) => name.endsWith(".json"),
    parse: (_name, content) => parseJson(content),
    parseIssue: invalidJson,
  });
  assert.deepEqual(deletedA.units.map((unit) => unit.name), ["b.json"]);

  await writeFile(join(directory, "a.json"), "{ invalid", "utf8");
  const recreatedInvalidA = runtime.refreshDirectory({
    key: "hooks:user",
    directory,
    include: (name) => name.endsWith(".json"),
    parse: (_name, content) => parseJson(content),
    parseIssue: invalidJson,
  });
  const a = recreatedInvalidA.units.find((unit) => unit.name === "a.json");
  assert.equal(a?.status.usingLastKnownGood, false);
  assert.equal(a?.value, undefined);
});
