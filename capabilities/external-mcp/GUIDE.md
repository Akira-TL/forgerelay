# External MCP

Use `mcp.external` only for MCP servers the user has already configured in ForgeRelay. The Host remains the orchestrator: discover the configured server/tool surface, then explicitly choose the server, tool, and arguments for each call.

## Operations

- `servers` — list configured server names and transport kinds. Connection details and credentials are not returned.
- `tools` — list the tools advertised by one configured server.
- `call` — invoke one tool that the selected configured server currently advertises.

## Boundaries

- A capability call cannot supply a new MCP command, URL, credential, or connection target. Those belong to user configuration.
- ForgeRelay forwards the upstream MCP result. A path, URL, resource identifier, or textual file reference stays a reference; ForgeRelay does not automatically fetch it, call `read`, infer that it is an image, or create an Artifact.
- When an upstream result names an accessible Workspace file and you need its contents, make an explicit ForgeRelay `read` call.
- Direct image/media forwarding is governed by the Media content contract. If the current ForgeRelay version reports that upstream media forwarding is unavailable, do not convert it through shell/base64 workarounds.
- ForgeRelay does not autonomously chain external MCP tools or retry through another configured server.
- External MCP processes/services keep the operating-system and network authority with which the user configured them. Routing through ForgeRelay does not make them a ForgeRelay filesystem sandbox.
- Hook policy may inspect or block Capability calls. Server/tool-specific request/result transformation is available only when the installed ForgeRelay version explicitly advertises that Hook contract; do not assume ordinary Hook stdout rewrites MCP data.
