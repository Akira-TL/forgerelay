import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { publicEndpointUrl } from "../mcp/oauth/public-url.js";
import { expandHomePath } from "../mcp/filesystem/roots.js";
import {
  installManagedLanguageServers,
  installedManagedLanguageServers,
  managedLanguageServerOptions,
  type ManagedLanguageServerId,
} from "../lsp/runtime/managed-language-servers.js";
import {
  generateInstanceId,
  generateOwnerToken,
  loadForgeRelayFiles,
  resolveSubagentsFlag,
  writeForgeRelayAuth,
  writeForgeRelayConfig,
  type ForgeRelayUserConfig,
} from "../runtime/config/user-config.js";
import {
  classifyClientFacingBaseUrl,
  compactPublicBaseUrlConfig,
  hasInsecureLanBaseUrl,
  isLoopbackBindAddress,
  normalizePublicBaseUrlsInput,
  setupBindAddress,
  SetupCancelledError,
  textPrompt,
  validateHttpsProxyBaseUrls,
  validateLanClientFacingBaseUrls,
  validatePort,
  type SetupNetworkMode,
} from "./setup-support.js";

export async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadForgeRelayFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`ForgeRelay is already configured at ${files.dir}`);
    prompts.log.info("Run `forgerelay init --force` to update it.");
    return;
  }

  try {
    prompts.intro("ForgeRelay setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should ForgeRelay use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    const existingPublicBaseUrls = Array.isArray(files.config.publicBaseUrl)
      ? files.config.publicBaseUrl
      : files.config.publicBaseUrl ? [files.config.publicBaseUrl] : [];
    const defaultNetworkMode: SetupNetworkMode = !isLoopbackBindAddress(files.config.host ?? "127.0.0.1")
      ? "lan"
      : existingPublicBaseUrls.some((baseUrl) => new URL(baseUrl).protocol === "https:")
        ? "proxy"
        : "local";
    const selectedMode = await prompts.select({
      message: "How should clients reach this ForgeRelay instance?",
      initialValue: defaultNetworkMode,
      options: [
        {
          value: "local",
          label: "Local only",
          hint: "Bind to loopback; local clients only. Client-facing URL is derived automatically.",
        },
        {
          value: "ssh",
          label: "SSH relay",
          hint: "Bind to loopback; another ForgeRelay reaches it through an SSH tunnel.",
        },
        {
          value: "lan",
          label: "Direct LAN",
          hint: "Bind to 0.0.0.0; clients connect directly over a trusted private LAN.",
        },
        {
          value: "proxy",
          label: "HTTPS reverse proxy / tunnel",
          hint: "Bind to 127.0.0.1; a local trusted proxy publishes the HTTPS endpoint.",
        },
      ],
    });
    if (prompts.isCancel(selectedMode)) throw new SetupCancelledError();
    const networkMode = selectedMode as SetupNetworkMode;

    const host = setupBindAddress(networkMode);
    let publicBaseUrl: ForgeRelayUserConfig["publicBaseUrl"] = null;
    let clientFacingBaseUrls = [`http://127.0.0.1:${port}`];
    const trustedProxies = networkMode === "proxy" ? ["loopback"] : undefined;

    if (networkMode === "lan" || networkMode === "proxy") {
      const validateBaseUrls = networkMode === "lan"
        ? validateLanClientFacingBaseUrls
        : validateHttpsProxyBaseUrls;
      const existingClientFacing = existingPublicBaseUrls.join(", ");
      const defaultClientFacing = existingClientFacing && validateBaseUrls(existingClientFacing) === undefined
        ? existingClientFacing
        : "";
      if (networkMode === "proxy") {
        prompts.note(
          [
            "The public URL may include a path prefix, for example https://example.com/forgerelay/debug.",
            "That prefix is the deployment route boundary, so MCP, OAuth, health, and App assets are served below it.",
          ].join("\n"),
          "Routed public URL",
        );
      }
      clientFacingBaseUrls = normalizePublicBaseUrlsInput(await textPrompt({
        message: defaultClientFacing
          ? `What client-facing base URLs should clients use? Press Enter to keep ${defaultClientFacing}`
          : networkMode === "lan"
            ? "What direct LAN base URL should clients use?"
            : "What HTTPS public base URL should clients use?",
        placeholder: defaultClientFacing || (networkMode === "lan"
          ? `http://192.168.1.20:${port}`
          : "https://example.com/forgerelay/debug"),
        defaultValue: defaultClientFacing,
        validate: validateBaseUrls,
      }));
      for (const baseUrl of clientFacingBaseUrls) classifyClientFacingBaseUrl(baseUrl);
      if (networkMode === "lan" && hasInsecureLanBaseUrl(clientFacingBaseUrls)) {
        prompts.note(
          [
            "Plain HTTP does not encrypt the ForgeRelay Owner approval flow or MCP bearer tokens.",
            "Use this only on a trusted private LAN. Prefer SSH relay or HTTPS when the network is not fully trusted.",
          ].join("\n"),
          "Unencrypted LAN access",
        );
        const approved = await prompts.confirm({
          message: "Allow unencrypted HTTP access on this private network?",
          initialValue: false,
        });
        if (prompts.isCancel(approved) || approved !== true) throw new SetupCancelledError();
      }
      publicBaseUrl = compactPublicBaseUrlConfig(clientFacingBaseUrls);
    }

    const installedManaged = installedManagedLanguageServers(files.dir);
    const selectedManaged = await prompts.multiselect({
      message: "Which Language Servers should ForgeRelay manage with npm?",
      options: managedLanguageServerOptions(),
      initialValues: installedManaged,
      required: false,
    });
    if (prompts.isCancel(selectedManaged)) throw new SetupCancelledError();
    const managedIds = selectedManaged as ManagedLanguageServerId[];
    const allowAgentInstallAnswer = await prompts.confirm({
      message: "Allow Agents to install or update ForgeRelay-managed Language Servers on demand?",
      initialValue: files.config.allowAgentLanguageServerInstall === true,
    });
    if (prompts.isCancel(allowAgentInstallAnswer)) throw new SetupCancelledError();
    const allowAgentLanguageServerInstall = allowAgentInstallAnswer === true;
    if (managedIds.length > 0) {
      prompts.note(
        [
          "ForgeRelay installs these optional Language Servers into its private config directory, not global npm.",
          "Rust Analyzer, gopls, and clangd remain external toolchain/system installations and are auto-detected when available.",
        ].join("\n"),
        "Managed Language Servers",
      );
      const spinner = prompts.spinner();
      spinner.start("Installing managed Language Servers with npm");
      try {
        const installed = await installManagedLanguageServers(managedIds, files.dir);
        spinner.stop(`Installed ${installed.installed.join(", ")} under ${installed.root}`);
      } catch (error) {
        spinner.stop("Managed Language Server installation failed");
        throw error;
      }
    }

    const config: ForgeRelayUserConfig = {
      host,
      port,
      allowedRoots,
      publicBaseUrl,
      allowedHosts: files.config.allowedHosts,
      trustedProxies,
      workflowInstructions: files.config.workflowInstructions,
      appendInstructions: files.config.appendInstructions,
      subagents: resolveSubagentsFlag(files.config),
      languageServers: files.config.languageServers,
      allowAgentLanguageServerInstall,
    };
    const auth = {
      ...files.auth,
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
      instanceId: files.auth.instanceId ?? generateInstanceId(),
    };

    const configPath = writeForgeRelayConfig(config);
    const authPath = await writeForgeRelayAuth(auth);
    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Bind: http://${config.host}:${config.port}`,
      ...clientFacingBaseUrls.map((baseUrl, index) =>
        `${index === 0 ? "Client-facing MCP URL" : "Client-facing MCP alias"}: ${publicEndpointUrl(baseUrl, "mcp").toString()}`
      ),
    ];
    if (networkMode === "ssh") {
      lines.push(`SSH relay: forgerelay auth -J <ssh-host> 127.0.0.1:${port} --ssh-auth`);
    }
    prompts.note(lines.join("\n"), "ForgeRelay configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve ForgeRelay access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `forgerelay serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}
