# ForgeRelay Agent Profile Schema

ForgeRelay agent profiles are user-owned Markdown files with YAML frontmatter.
ForgeRelay owns provider invocation; the profile describes which local coding
runtime to use and what prompt prefix/configuration to apply.

## Locations

New locations:

```text
~/.forgerelay/agents/*.md
.forgerelay/agents/*.md
```

Rename-era DevSpace profile discovery has ended. `~/.devspace/agents/*.md` and
`.devspace/agents/*.md` are not scanned automatically. Move older profiles into
a canonical ForgeRelay location, or temporarily point `FORGERELAY_CONFIG_DIR`
at the old global config directory while migrating.

## Example

```markdown
---
schema: forgerelay-agent/v1
name: reviewer
description: Review changes for correctness and regressions.
provider: codex
model: gpt-5.6-codex
thinking: high
---

Review the requested implementation. Focus on correctness, regression risk,
and missing tests. Return concrete findings before optional suggestions.
```

The `schema` field is descriptive/versioning metadata for profile authors. The
current parser focuses on the supported operational fields below.

## Fields

### `name`

Optional. Use lowercase kebab-case when practical. If omitted, ForgeRelay uses
the filename without `.md`.

### `description`

Optional but recommended. This is shown in the compact profile catalog returned
to the MCP host.

### `provider`

Required. Currently supported provider identifiers are:

```text
codex
claude
opencode
pi
cursor
copilot
```

Custom provider strings are rejected. ForgeRelay maps these identifiers through
its local provider adapter registry.

### `model`

Optional provider-specific model value. If omitted, the provider default
applies.

### `thinking`

Optional provider-specific reasoning/thinking control. ForgeRelay passes through
supported values rather than translating names between providers.

### `disabled`

Optional boolean. `true` excludes the profile from the active catalog.

## Prompt body

The Markdown body after frontmatter is the profile prompt prefix ForgeRelay
prepends when launching the provider-backed worker.

Keep reusable worker policy here; keep task-specific instructions in the prompt
supplied to the `run` command/tool.

## Current CLI workflow

```bash
forgerelay agents ls
forgerelay agents run <profile-or-provider-or-id> "<prompt>"
forgerelay agents show <id>
```

Optional provider overrides include:

```bash
forgerelay agents run <profile> --model <model> "<prompt>"
forgerelay agents run <profile> --thinking <level> "<prompt>"
```

`agents ls` lists existing subagent sessions for the current workspace; it is
not the profile-definition catalog. The compact profile catalog is returned by
`open_workspace` when subagents are enabled.

## MCP direction

Profiles and provider execution are intentionally independent of the current
CLI transport. A planned first-class MCP subagent tool will wrap the same
provider adapter/session registry rather than introducing a second agent
runtime.
