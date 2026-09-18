export type CliRootHandler =
  | "serve"
  | "init"
  | "config"
  | "connect"
  | "system"
  | "help"
  | "version";

export type CliCompatibilityHandler = "agents";

interface CliRouteMetadata {
  command: string;
  argsPrefix?: readonly string[];
  publicSummary?: string;
}

export type CliRootRoute = CliRouteMetadata & (
  | { handler: CliRootHandler; compatibilityHandler?: never }
  | { compatibilityHandler: CliCompatibilityHandler; handler?: never }
);

export const CLI_ROOT_ROUTES: readonly CliRootRoute[] = [
  { command: "serve", handler: "serve", publicSummary: "Start the ForgeRelay runtime" },
  { command: "init", handler: "init", publicSummary: "Run first-time or setup-owned configuration" },
  { command: "config", handler: "config", publicSummary: "Inspect and mutate declarative configuration" },
  { command: "connect", handler: "connect", publicSummary: "Manage remote ForgeRelay and External MCP relationships" },
  { command: "system", handler: "system", publicSummary: "Diagnose and maintain ForgeRelay" },
  { command: "help", handler: "help", publicSummary: "Show this help" },
  { command: "version", handler: "version", publicSummary: "Print the installed version" },

  // Compatibility-only routes. These remain dispatchable during the supported
  // compatibility window but never appear in generated public root help.
  { command: "start", handler: "serve" },
  { command: "doctor", handler: "system", argsPrefix: ["doctor"] },
  { command: "hooks", handler: "config", argsPrefix: ["hooks", "--compat"] },
  { command: "auth", handler: "connect", argsPrefix: ["relay"] },
  { command: "mcp", handler: "connect", argsPrefix: ["mcp"] },
  { command: "maintenance", handler: "system" },
  { command: "agents", compatibilityHandler: "agents" },
  { command: "--help", handler: "help" },
  { command: "-h", handler: "help" },
  { command: "--version", handler: "version" },
  { command: "-v", handler: "version" },
] as const;

export function resolveCliRootRoute(command: string | undefined): CliRootRoute {
  if (command === undefined) return { command: "help", handler: "help" };
  const route = CLI_ROOT_ROUTES.find((candidate) => candidate.command === command);
  if (!route) throw new Error(`Unknown command: ${command}`);
  return route;
}

export function routeArguments(route: CliRootRoute, args: readonly string[]): string[] {
  return [...(route.argsPrefix ?? []), ...args];
}

const SERVE_OPTION_HELP_LINES = [
  "--host <host>             Override the bind host for this invocation",
  "--port <port>             Override the listen port for this invocation",
  "--root <path>             Override allowed roots; repeat for multiple roots",
  "--public-url <url>        Override client-facing base URLs; repeat for multiple URLs",
  "--allow-elevated          Explicitly allow this invocation to run with elevated/unknown OS privilege",
] as const;

export function renderCliRootHelp(): string {
  const publicRoutes = CLI_ROOT_ROUTES.filter((route) => route.publicSummary !== undefined);
  const commandWidth = Math.max(...publicRoutes.map((route) => route.command.length));
  return [
    "ForgeRelay",
    "",
    "Usage:",
    "  forgerelay                         Show help",
    "  forgerelay <command> [options]     Run a command",
    "",
    "Commands:",
    ...publicRoutes.map((route) =>
      `  forgerelay ${route.command.padEnd(commandWidth)}  ${route.publicSummary}`
    ),
    "",
    "Serve options:",
    ...SERVE_OPTION_HELP_LINES.map((line) => `  forgerelay serve ${line}`),
  ].join("\n");
}

export function renderServeHelp(): string {
  return [
    "ForgeRelay serve",
    "",
    "Usage:",
    "  forgerelay serve [options]",
    "",
    "Options:",
    ...SERVE_OPTION_HELP_LINES.map((line) => `  ${line}`),
  ].join("\n");
}
