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
- Direct upstream `ImageContent` for PNG, JPEG, WebP, and GIF is forwarded as transient Media content after MIME/base64 validation and the configured aggregate media budget. Image base64 exists only in the live MCP result; structured/Activity state keeps bounded MIME/byte metadata.
- Audio and arbitrary binary-resource forwarding are outside this Media contract. A path, URL, `resource_link`, or other non-media reference is not upgraded into an image automatically.
- ForgeRelay does not autonomously chain external MCP tools or retry through another configured server.
- External MCP processes/services keep the operating-system and network authority with which the user configured them. Routing through ForgeRelay does not make them a ForgeRelay filesystem sandbox.
- Hook policy may inspect or block Capability calls. Server/tool-specific transforms use the explicit `ExternalMcpBeforeForward` / `ExternalMcpAfterForward` contract; ordinary Hook stdout never rewrites MCP data.

## Optional transform Hooks

Transform Hooks are opt-in user policy for one configured external MCP server/tool. Match them with `tool: "capability"`, `capability: "mcp.external"`, `externalServer`, and `externalTool`. ForgeRelay passes the current transform value over stdin as versioned JSON and accepts one structured stdout envelope only.

- Before forward: stdout must be `{"version":1,"request":{"arguments":{...}}}`. Only arguments can change; the configured server/tool target cannot.
- After forward: stdout must be `{"version":1,"result":{...}}`. The transformed result is revalidated as an MCP result and any ImageContent is rechecked against the normal MIME/base64/media-budget rules.
- A transform command may deliberately read a renderer-owned path or perform other work using the command's own OS authority. That is explicit Hook behavior, not an implicit ForgeRelay `read`, fetch, or Artifact operation.
- Activity/log state records only bounded transform identity/status metadata. Transform stdin/stdout, arbitrary upstream payloads, credentials, and image base64 are not persisted by ForgeRelay.
