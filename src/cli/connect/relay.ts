import { stdin as input, stdout as output } from "node:process";
import * as prompts from "@clack/prompts";
import {
  ensureForgeRelayInstanceId,
  loadForgeRelayFiles,
  removeForgeRelayRemote,
  renameForgeRelayRemote,
  writeForgeRelayRemote,
} from "../../runtime/config/user-config.js";
import {
  authenticateRemote,
  defaultRemoteAlias,
  isRemoteMcpUnauthorized,
  normalizeRemoteServiceTarget,
  refreshRemoteAuthentication,
  verifyRemoteMcp,
} from "../../workspaces/relay/auth/remote-auth.js";
import {
  defaultSshRouteAlias,
  parseSshRoute,
  readRemoteOwnerToken,
  withRemoteServiceEndpoint,
} from "../../workspaces/relay/transport/remote-transport.js";

interface RelayCommandArgs {
  target?: string;
  alias?: string;
  ownerToken?: string;
  sshRoute?: string[];
  sshAuth: boolean;
}

export async function runRelayCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "__owner-token") {
    if (rest.length > 0) throw new Error("Internal owner-token command does not accept arguments.");
    process.stdout.write(`${localOwnerToken()}\n`);
    return;
  }
  if (subcommand === "list") {
    if (rest.length > 0) throw new Error("forgerelay connect relay list does not accept additional arguments.");
    printRemoteList();
    return;
  }
  if (subcommand === "status") {
    if (rest.length > 1) throw new Error("Usage: forgerelay connect relay status [alias]");
    printRemoteStatus(rest[0]);
    return;
  }
  if (subcommand === "rename") {
    const [fromAlias, toAlias, ...extra] = rest;
    if (!fromAlias || !toAlias || extra.length > 0) {
      throw new Error("Usage: forgerelay connect relay rename <old-alias> <new-alias>");
    }
    await renameForgeRelayRemote(fromAlias, toAlias);
    console.log(`Renamed remote ${fromAlias} to ${toAlias}.`);
    return;
  }
  if (subcommand === "remove") {
    const [alias, ...extra] = rest;
    if (!alias || extra.length > 0) {
      throw new Error("Usage: forgerelay connect relay remove <alias>");
    }
    await removeForgeRelayRemote(alias);
    console.log(`Removed remote ${alias}.`);
    return;
  }
  if (subcommand === "test") {
    const [alias, ...extra] = rest;
    if (!alias || extra.length > 0) throw new Error("Usage: forgerelay connect relay test <alias>");
    await testRemote(alias);
    return;
  }
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printRelayHelp();
    return;
  }

  let parsed = parseRelayCommandArgs(args);
  if (!parsed.target) {
    if (!input.isTTY || !output.isTTY) {
      throw new Error(
        "Missing remote service target in non-interactive mode. Pass a target or run `forgerelay connect relay` in an interactive terminal.",
      );
    }
    parsed = await completeInteractiveRelaySetup(parsed);
  }

  await authenticateAndPersist(parsed);
}

function parseRelayCommandArgs(args: string[]): RelayCommandArgs {
  let target: string | undefined;
  let alias: string | undefined;
  let ownerToken: string | undefined;
  let sshRoute: string[] | undefined;
  let sshAuth = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--alias") {
      alias = args[++index];
      if (!alias) throw new Error("Missing value for --alias.");
      continue;
    }
    if (arg === "--token") {
      ownerToken = args[++index];
      if (!ownerToken) throw new Error("Missing value for --token.");
      continue;
    }
    if (arg === "-J") {
      const route = args[++index];
      if (!route) throw new Error("Missing value for -J.");
      sshRoute = parseSshRoute(route);
      continue;
    }
    if (arg === "--ssh-auth") {
      sshAuth = true;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown relay option: ${arg}`);
    if (target) throw new Error(`Unexpected relay argument: ${arg}`);
    target = arg;
  }

  if (sshAuth && !sshRoute) throw new Error("--ssh-auth requires -J <ssh-route>.");
  if (sshAuth && ownerToken) throw new Error("--ssh-auth and --token cannot be used together.");
  return { target, alias, ownerToken, sshRoute, sshAuth };
}

async function completeInteractiveRelaySetup(parsed: RelayCommandArgs): Promise<RelayCommandArgs> {
  const target = parsed.target ?? await promptText(
    "Remote service target",
    "",
    (value) => value?.trim() ? undefined : "Enter the remote service target.",
  );

  let sshRoute = parsed.sshRoute;
  if (!parsed.sshRoute) {
    const selectedRoute = await prompts.select({
      message: "Connection route",
      initialValue: "direct",
      options: [
        { value: "direct", label: "Direct" },
        { value: "ssh", label: "SSH" },
      ],
    });
    if (prompts.isCancel(selectedRoute)) throw new Error("Remote connection setup cancelled.");
    if (selectedRoute === "ssh") {
      const route = await promptText(
        "SSH route (-J)",
        "",
        (value) => value?.trim() ? undefined : "Enter the SSH route.",
      );
      sshRoute = parseSshRoute(route);
    }
  }

  const normalizedTarget = normalizeRemoteServiceTarget(target);
  const defaultAlias = sshRoute
    ? defaultSshRouteAlias(sshRoute)
    : defaultRemoteAlias(normalizedTarget);
  const alias = parsed.alias ?? await promptText("Forge alias", defaultAlias);

  let ownerToken = parsed.ownerToken;
  let sshAuth = parsed.sshAuth;
  if (!ownerToken && !sshAuth) {
    if (sshRoute) {
      const selectedAuthentication = await prompts.select({
        message: "Authentication",
        initialValue: "ssh",
        options: [
          { value: "ssh", label: "Read owner token over SSH" },
          { value: "token", label: "Enter owner token locally" },
        ],
      });
      if (prompts.isCancel(selectedAuthentication)) throw new Error("Remote connection setup cancelled.");
      if (selectedAuthentication === "ssh") sshAuth = true;
      else ownerToken = await promptOwnerToken();
    } else {
      ownerToken = await promptOwnerToken();
    }
  }

  return { target, alias, ownerToken, sshRoute, sshAuth };
}

async function authenticateAndPersist(parsed: RelayCommandArgs): Promise<void> {
  if (!parsed.target) throw new Error("Missing remote service target.");
  const target = normalizeRemoteServiceTarget(parsed.target);
  const authenticated = await withRemoteServiceEndpoint(
    target,
    parsed.sshRoute,
    async (endpoint) => {
      const ownerToken = parsed.sshAuth
        ? await readRemoteOwnerToken(parsed.sshRoute ?? [])
        : await resolveOwnerToken(parsed.ownerToken);
      return authenticateRemote(endpoint, ownerToken);
    },
  );
  const remote = {
    ...authenticated,
    target,
    ...(parsed.sshRoute ? { sshRoute: parsed.sshRoute } : {}),
  };
  const files = loadForgeRelayFiles();
  const existingAlias = Object.entries(files.auth.remotes ?? {}).find(
    ([, record]) => record.instanceId === remote.instanceId,
  )?.[0];
  const defaultAlias = parsed.sshRoute
    ? defaultSshRouteAlias(parsed.sshRoute)
    : defaultRemoteAlias(remote.target);
  const alias = parsed.alias?.trim() || existingAlias || defaultAlias;
  if (!files.auth.instanceId) await ensureForgeRelayInstanceId();
  await writeForgeRelayRemote(alias, remote);
  console.log(`Authenticated remote ${alias} (${remote.instanceId}).`);
}

async function resolveOwnerToken(ownerToken: string | undefined): Promise<string> {
  if (ownerToken) return ownerToken;
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Missing owner token. Pass --token, use --ssh-auth with -J, or run in an interactive terminal.");
  }
  return promptOwnerToken();
}

async function promptOwnerToken(): Promise<string> {
  const result = await prompts.password({
    message: "Remote ForgeRelay owner token",
    validate: (value) => value?.trim() ? undefined : "Enter the remote owner token.",
  });
  if (prompts.isCancel(result)) throw new Error("Remote connection setup cancelled.");
  return String(result);
}

async function promptText(
  message: string,
  defaultValue: string,
  validate?: (value: string | undefined) => string | Error | undefined,
): Promise<string> {
  const result = await prompts.text({
    message,
    ...(defaultValue ? { placeholder: defaultValue } : {}),
    validate: (value) => validate?.(value?.trim() ? value : defaultValue),
  });
  if (prompts.isCancel(result)) throw new Error("Remote connection setup cancelled.");
  const value = String(result).trim();
  return value || defaultValue;
}

function localOwnerToken(): string {
  const token = process.env.FORGERELAY_OAUTH_OWNER_TOKEN
    ?? loadForgeRelayFiles().auth.ownerToken;
  if (!token) throw new Error("ForgeRelay owner token is not configured on this machine.");
  return token;
}

function printRemoteList(): void {
  const remotes = loadForgeRelayFiles().auth.remotes ?? {};
  if (Object.keys(remotes).length === 0) {
    console.log("No remote ForgeRelay instances registered.");
    return;
  }
  for (const [alias, remote] of Object.entries(remotes).sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`${alias}\t${remote.target}\t${remote.instanceId}`);
  }
}

function printRemoteStatus(alias: string | undefined): void {
  const remotes = loadForgeRelayFiles().auth.remotes ?? {};
  if (alias) {
    const remote = remotes[alias];
    if (!remote) throw new Error(`Unknown remote alias: ${alias}`);
    console.log(`${alias}\tregistered\t${remote.target}\t${remote.instanceId}`);
    return;
  }
  if (Object.keys(remotes).length === 0) {
    console.log("No remote ForgeRelay instances registered.");
    return;
  }
  for (const [name, remote] of Object.entries(remotes).sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`${name}\tregistered\t${remote.target}\t${remote.instanceId}`);
  }
}

async function testRemote(alias: string): Promise<void> {
  const files = loadForgeRelayFiles();
  const storedRemote = files.auth.remotes?.[alias];
  if (!storedRemote) throw new Error(`Unknown remote alias: ${alias}`);
  let remote = storedRemote;

  await withRemoteServiceEndpoint(remote.target, remote.sshRoute, async (endpoint) => {
    let refreshed = false;
    if (remote.accessTokenExpiresAt <= Math.floor(Date.now() / 1000)) {
      remote = await refreshRemoteAuthentication(remote, endpoint);
      await writeForgeRelayRemote(alias, remote);
      refreshed = true;
    }

    try {
      await verifyRemoteMcp(remote, endpoint);
    } catch (error) {
      if (refreshed || !isRemoteMcpUnauthorized(error)) throw error;
      remote = await refreshRemoteAuthentication(remote, endpoint);
      await writeForgeRelayRemote(alias, remote);
      await verifyRemoteMcp(remote, endpoint);
    }
  });
  console.log(`${alias}\tok\t${remote.instanceId}`);
}

function printRelayHelp(): void {
  console.log([
    "ForgeRelay connect relay",
    "",
    "Usage:",
    "  forgerelay connect relay",
    "  forgerelay connect relay <target> [--alias <name>] [--token <owner-token>]",
    "  forgerelay connect relay -J <ssh-route> <target> [--ssh-auth|--token <owner-token>] [--alias <name>]",
    "  forgerelay connect relay list",
    "  forgerelay connect relay status [alias]",
    "  forgerelay connect relay test <alias>",
    "  forgerelay connect relay rename <old-alias> <new-alias>",
    "  forgerelay connect relay remove <alias>",
  ].join("\n"));
}
