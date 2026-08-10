# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through ForgeRelay.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL when the MCP host cannot connect directly to localhost

ForgeRelay does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

## Install and configure

Run:

```bash
npx @akira-tl/forgerelay init
```

The setup flow asks for the allowed project roots, local port, and public base
URL.

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

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with:

```text
https://your-tunnel-host.example.com/mcp
```

## Start the server

```bash
npx @akira-tl/forgerelay serve
```

For a one-run public URL override:

```bash
FORGERELAY_PUBLIC_BASE_URL="https://new-tunnel.example.com" \
npx @akira-tl/forgerelay serve
```

For a stable public URL:

```bash
npx @akira-tl/forgerelay config set publicBaseUrl https://forge.example.com
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

### Existing DevSpace configuration

During migration, if `~/.forgerelay` does not exist but `~/.devspace` does,
ForgeRelay reuses the legacy directory automatically. `FORGERELAY_CONFIG_DIR`
takes precedence over the legacy `DEVSPACE_CONFIG_DIR` environment variable.

You do not need to move a working legacy config before starting ForgeRelay.

## Check the setup

```bash
npx @akira-tl/forgerelay doctor
```

The doctor command reports the resolved config, Node runtime, platform, Git,
Bash, public URL, allowed hosts, native SQLite dependency status, and the MCP
shape ForgeRelay will expose: tool mode, widget mode, one-hop proxy trust, and
whether optional artifact, subagent, and Skill capabilities are enabled.

## Running from a local checkout

For ForgeRelay development itself:

```bash
npm install --include=dev
npm run dev
```
