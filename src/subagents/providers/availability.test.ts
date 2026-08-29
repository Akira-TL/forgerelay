import assert from "node:assert/strict";
import {
  checkSubagentProviderAvailability,
  formatSubagentProviderAvailabilitySummary,
  getSubagentProviderAvailabilitySnapshot,
} from "./availability.js";

assert.equal(checkSubagentProviderAvailability("codex").available, true);

{
  const availability = checkSubagentProviderAvailability("pi", {
    ...process.env,
    PI_COMMAND: "/definitely/missing/devspace-pi",
  });
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /executable not found/);
}

{
  const snapshot = getSubagentProviderAvailabilitySnapshot({
    ...process.env,
    PI_COMMAND: "/definitely/missing/devspace-pi",
  });
  assert.deepEqual(
    snapshot.map((provider) => provider.name),
    ["codex", "claude", "opencode", "pi", "cursor", "copilot"],
  );
  assert.equal(snapshot.find((provider) => provider.name === "pi")?.available, false);
}

assert.equal(
  formatSubagentProviderAvailabilitySummary([
    { name: "codex", available: true },
    { name: "pi", available: false, reason: "pi executable not found" },
  ]),
  "available: codex; unavailable: pi (pi executable not found)",
);
