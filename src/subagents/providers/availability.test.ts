import assert from "node:assert/strict";
import {
  checkSubagentProviderAvailability,
  formatSubagentProviderAvailabilitySummary,
  getSubagentProviderAvailabilitySnapshot,
} from "./availability.js";

{
  const availability = checkSubagentProviderAvailability("codex", {
    ...process.env,
    CODEX_COMMAND: process.execPath,
  });
  assert.deepEqual(
    {
      available: availability.available,
      continuationSupported: availability.continuationSupported,
    },
    { available: true, continuationSupported: true },
  );
}

for (const [provider, key] of [
  ["codex", "CODEX_COMMAND"],
  ["claude", "CLAUDE_COMMAND"],
  ["opencode", "OPENCODE_COMMAND"],
  ["pi", "PI_COMMAND"],
] as const) {
  const availability = checkSubagentProviderAvailability(provider, {
    ...process.env,
    [key]: `/definitely/missing/forgerelay-${provider}`,
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

{
  const snapshot = getSubagentProviderAvailabilitySnapshot({
    ...process.env,
    CODEX_COMMAND: process.execPath,
    CLAUDE_COMMAND: process.execPath,
    OPENCODE_COMMAND: process.execPath,
    PI_COMMAND: "/definitely/missing/forgerelay-pi",
  });
  assert.deepEqual(
    snapshot.map((provider) => provider.name),
    ["codex", "claude", "opencode", "pi", "cursor", "copilot"],
  );
  assert.equal(snapshot.find((provider) => provider.name === "codex")?.available, true);
  assert.equal(snapshot.find((provider) => provider.name === "claude")?.available, true);
  assert.equal(snapshot.find((provider) => provider.name === "opencode")?.available, true);
  assert.equal(snapshot.find((provider) => provider.name === "pi")?.available, false);
  assert.equal(snapshot.find((provider) => provider.name === "pi")?.continuationSupported, true);
  assert.equal(snapshot.find((provider) => provider.name === "cursor")?.continuationSupported, false);
  assert.equal(snapshot.find((provider) => provider.name === "copilot")?.continuationSupported, false);
}

assert.equal(
  formatSubagentProviderAvailabilitySummary([
    { name: "codex", available: true, continuationSupported: true },
    { name: "pi", available: false, continuationSupported: true, reason: "pi executable not found" },
  ]),
  "available: codex; unavailable: pi (pi executable not found)",
);
