export function generatedSchemaTextMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  return actual.replaceAll("\r\n", "\n") === expected;
}
