import { resolve } from "node:path";

export type ConfigCliScope =
  | { mode: "global" }
  | { mode: "project"; projectRoot: string };

export function parseConfigScopeArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { scope: ConfigCliScope; rest: string[] } {
  let global = false;
  let projectRoot: string | undefined;
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--global") {
      if (global || projectRoot) throw new Error("--global and --project cannot be used together or repeated.");
      global = true;
      continue;
    }
    if (arg === "--project") {
      if (global || projectRoot) throw new Error("--global and --project cannot be used together or repeated.");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--project requires a project path.");
      projectRoot = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--project-local") {
      throw new Error("--project-local is not a public configuration scope.");
    }
    rest.push(arg);
  }

  return {
    scope: global
      ? { mode: "global" }
      : { mode: "project", projectRoot: projectRoot ?? resolve(env.FORGERELAY_WORKSPACE_ROOT ?? process.cwd()) },
    rest,
  };
}
