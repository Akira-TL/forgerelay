# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through ForgeRelay.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- a supported Command Shell Runtime: Bash/zsh/POSIX sh on Unix-like systems, or PowerShell 7 / Windows PowerShell 5.1 / `cmd.exe` on Windows
- a public HTTPS URL when the MCP host cannot connect directly to localhost

ForgeRelay does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

## Install and configure

Run:

```bash
npx @akira-tl/forgerelay init
```

Basic setup asks only for the allowed project roots and how clients reach this ForgeRelay instance (local, SSH relay, direct LAN, or HTTPS proxy/tunnel). It asks connection-specific details only when that mode requires them.

Use `npx @akira-tl/forgerelay init --advanced` for the small set of common advanced choices: port, Command Shell Runtime, Runtime Shell Instructions opt-in, ForgeRelay-managed Language Servers, and whether Agents may install managed Language Servers on demand. Runtime Shell Instructions are disabled unless explicitly enabled.

`init --force` updates setup-owned fields only. It does not migrate legacy configuration or erase unrelated advanced settings.

### Project roots

Choose only the folders the connected MCP host should be able to open.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

### Local port

The default is `7676`.

```text
http://127.0.0.1:7676/mcp
```

### Public base URL

Point your tunnel or reverse proxy at:

```text
http://127.0.0.1:7676
```

Enter one or more public base URLs. Each URL may include its own route prefix;
the first URL is canonical:

```text
https://your-tunnel-host.example.com/forgerelay/main
```

For multiple public entries, separate them with commas during setup:

```text
https://forge.example.com/forgerelay/main, https://forge-alt.example.com/relay
```

Configure the MCP client with the canonical base URL plus `/mcp`:

```text
https://your-tunnel-host.example.com/forgerelay/main/mcp
```

## Start the server

```bash
npx @akira-tl/forgerelay serve
```

For a one-run public deployment override:

```bash
FORGERELAY_PUBLIC_BASE_URL="https://new-tunnel.example.com/forgerelay/main" \
npx @akira-tl/forgerelay serve
```

For multiple one-run URLs, use a comma-separated list:

```bash
FORGERELAY_PUBLIC_BASE_URL="https://forge.example.com/forgerelay/main,https://forge-alt.example.com/relay" \
npx @akira-tl/forgerelay serve
```

For a stable public deployment:

```bash
npx @akira-tl/forgerelay config set publicBaseUrl https://forge.example.com/forgerelay/main,https://forge-alt.example.com/relay
npx @akira-tl/forgerelay serve
```

## Approve the client

When ChatGPT, Claude, or another MCP client connects, ForgeRelay displays an
Owner-password approval page. Enter the Owner password printed during setup.

New installations use:

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

Keep `auth.json` private.

## Check the setup

```bash
npx @akira-tl/forgerelay doctor
npx @akira-tl/forgerelay config check
npx @akira-tl/forgerelay config sources
npx @akira-tl/forgerelay config explain <logical-path>
```

`doctor` reports the runtime and deployment summary. Config v2's `check`, `sources`, and `explain` commands validate the selected scope and show provenance without executing Hooks, starting Language Servers/stdio MCP servers, or exposing resolved sensitive values.

ForgeRelay never rewrites old configuration during startup. Preview an explicit migration with `forgerelay config migrate --dry-run --global` or `--project <path>` before applying it. ForgeRelay-owned legacy sources remain compatible in v1.2.x and are removed in v1.4.0.

## Running from a local checkout

For ForgeRelay development itself:

```bash
npm install --include=dev
npm run dev
```
