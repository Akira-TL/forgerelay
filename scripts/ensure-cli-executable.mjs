import { chmodSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const currentMode = statSync(cliPath).mode;
  chmodSync(cliPath, currentMode | 0o111);

  if ((statSync(cliPath).mode & 0o111) === 0) {
    throw new Error(`ForgeRelay CLI is not executable after build: ${cliPath}`);
  }
}
