import { normalizeAllowedRootPath } from "../../runtime/config/validation/paths.js";
import {
  normalizePublicBaseUrlsInput,
  validateBindAddress,
  validateClientFacingBaseUrls,
  validatePort,
} from "../setup-support.js";

export interface ServeCommandOptions {
  allowElevated: boolean;
  runtimeOverrides: Record<string, unknown>;
}

export function parseServeCommandArgs(args: readonly string[]): ServeCommandOptions {
  let allowElevated = false;
  let host: string | undefined;
  let port: number | undefined;
  const roots: string[] = [];
  const publicBaseUrls: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-elevated") {
      if (allowElevated) throw new Error("--allow-elevated may only be supplied once.");
      allowElevated = true;
      continue;
    }
    if (arg === "--host") {
      if (host !== undefined) throw new Error("--host may only be supplied once.");
      const value = args[++index];
      if (value === undefined) throw new Error("Missing value for --host.");
      const validation = validateBindAddress(value);
      if (validation) throw new Error(`Invalid --host: ${validation}`);
      host = value.trim();
      continue;
    }
    if (arg === "--port") {
      if (port !== undefined) throw new Error("--port may only be supplied once.");
      const value = args[++index];
      if (value === undefined) throw new Error("Missing value for --port.");
      const validation = validatePort(value);
      if (validation) throw new Error(`Invalid --port: ${validation}`);
      port = Number(value);
      continue;
    }
    if (arg === "--root") {
      const value = args[++index];
      if (value === undefined) throw new Error("Missing value for --root.");
      roots.push(normalizeAllowedRootPath(value));
      continue;
    }
    if (arg === "--public-url") {
      const value = args[++index];
      if (value === undefined) throw new Error("Missing value for --public-url.");
      const validation = validateClientFacingBaseUrls(value);
      if (validation) throw new Error(`Invalid --public-url: ${validation}`);
      publicBaseUrls.push(...normalizePublicBaseUrlsInput(value));
      continue;
    }
    throw new Error(`Unknown serve option: ${arg}`);
  }

  return {
    allowElevated,
    runtimeOverrides: {
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port }),
      ...(roots.length === 0 ? {} : { allowedRoots: roots }),
      ...(publicBaseUrls.length === 0
        ? {}
        : { publicBaseUrl: Array.from(new Set(publicBaseUrls)) }),
    },
  };
}
