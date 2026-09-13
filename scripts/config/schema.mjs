#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DEFINITION_CATALOG } from "../../src/runtime/config/definition/catalog.ts";
import { generateConfigSchemaFiles } from "../../src/runtime/config/definition/schema.ts";
import { generatedSchemaTextMatches } from "./schema-text.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const command = process.argv[2] ?? "check";
const generated = generateConfigSchemaFiles(CONFIG_DEFINITION_CATALOG)
  .map((entry) => ({
    ...entry,
    content: `${JSON.stringify(entry.schema, null, 2)}\n`,
  }))
  .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

if (command === "write") {
  for (const entry of generated) {
    const path = resolve(repoRoot, entry.relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.content, "utf8");
  }
  await removeStaleCurrentMajorSchemas();
  console.log(`Generated ${generated.length} Config System v1 schema files.`);
} else if (command === "check") {
  const mismatches = [];
  for (const entry of generated) {
    const path = resolve(repoRoot, entry.relativePath);
    let actual;
    try {
      actual = await readFile(path, "utf8");
    } catch {
      actual = undefined;
    }
    if (!generatedSchemaTextMatches(actual, entry.content)) mismatches.push(entry.relativePath);
  }
  const expected = new Set(generated.map((entry) => entry.relativePath));
  for (const path of await currentMajorSchemaPaths()) {
    if (!expected.has(path)) mismatches.push(path);
  }
  if (mismatches.length > 0) {
    console.error("Generated Config schemas are out of date:");
    for (const path of [...new Set(mismatches)].sort()) console.error(`- ${path}`);
    console.error("Run: npm run config:schema:generate");
    process.exit(1);
  }
  console.log(`Config schema check passed: ${generated.length} generated v1 schema files are current.`);
} else {
  throw new Error(`Unknown schema command ${JSON.stringify(command)}; expected check or write.`);
}

async function removeStaleCurrentMajorSchemas() {
  const expected = new Set(generated.map((entry) => entry.relativePath));
  const { rm } = await import("node:fs/promises");
  for (const relativePath of await currentMajorSchemaPaths()) {
    if (!expected.has(relativePath)) await rm(resolve(repoRoot, relativePath));
  }
}

async function currentMajorSchemaPaths() {
  const directory = resolve(repoRoot, "schemas/v1");
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".schema.json"))
    .map((name) => `schemas/v1/${name}`)
    .sort();
}
