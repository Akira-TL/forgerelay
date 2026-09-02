import assert from "node:assert/strict";
import {
  checkSubagentProviderAvailability,
  formatSubagentProviderAvailabilitySummary,
  getSubagentProviderAvailabilitySnapshot,
} from "./availability.js";

assert.deepEqual(
  {
    available: checkSubagentProviderAvailability("codex").available,
    continuationSupported: checkSubagentProviderAvailability("codex").continuationSupported,
  },
  { available: true, continuationSupported: true },
);

{
  const availability = checkSubagentProviderAvailability("pi", {
    ...process.env,
    PI_COMMAND: "/definitely/missing/forgerelay-pi",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

{
  const snapshot = getSubagentProviderAvailabilitySnapshot({
    ...process.env,
    PI_COMMAND: "/definitely/missing/forgerelay-pi",
  });
  assert.deepEqual(
    snapshot.map((provider) => provider.name),
    ["codex", "claude", "opencode", "pi", "cursor", "copilot"],
  );
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
