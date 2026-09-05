---
name: powershell
description: Deep PowerShell 7 guidance for native executables, quoting, errors, pipelines, and ForgeRelay command-runtime edge cases.
---

# PowerShell 7 Guidance

Use this Skill when a ForgeRelay runtime reports `pwsh` and the task needs more than the compact PowerShell Instructions already loaded at bootstrap.

## Native executable invocation

- Prefer an explicit executable path or `.exe` name when native semantics matter.
- Use the call operator `&` when the executable is stored in a variable or its path is quoted.
- Pass arguments as PowerShell arguments instead of constructing one nested command string whenever possible.
- Treat quoting as PowerShell quoting. Do not copy Bash backslash escaping rules into native argument strings.
- After a native executable, `$LASTEXITCODE` is the native process exit code. If the surrounding PowerShell command must preserve that exact code, use an explicit `exit $LASTEXITCODE` at the point where propagation is intended.

## PowerShell errors

- Cmdlet errors and native process failures are different channels. `$LASTEXITCODE` does not describe cmdlet failure.
- Use terminating errors deliberately when a cmdlet failure must stop the command, for example `-ErrorAction Stop` or an appropriate `$ErrorActionPreference` scope.
- Do not assume every message written to the error stream terminates execution.

## Pipelines and data

- Cmdlet pipelines carry objects, not merely text lines.
- When piping into or out of a native executable, reason explicitly about text conversion, encoding, and argument boundaries.
- Prefer PowerShell object operations over parsing formatted display text from cmdlets.

## Environment and discovery

- Environment variables use `$env:NAME`; mutation is `$env:NAME = 'value'`.
- Use `Get-Command` for discovery. Do not assume Unix aliases or flags have the same semantics as similarly named PowerShell aliases.
- ForgeRelay inherits the environment of the server process. Do not source the user's PowerShell profile to recover PATH, aliases, modules, prompts, or other interactive configuration.

## PowerShell 7 specifics

- Pipeline-chain operators `&&` and `||` are PowerShell 7 features. Use them only when the reported ForgeRelay runtime version supports them.
- Modern PowerShell native argument passing differs from Windows PowerShell 5.1. When exact native argv matters, validate the reported PowerShell version and avoid relying on legacy quoting folklore.
- For paths containing spaces or special characters, keep the path as a PowerShell value and invoke it with `&` rather than embedding it into another quoted command line.

## ForgeRelay process behavior

- The public tool remains named `bash` for compatibility; the reported Command Shell Runtime determines the command language.
- Non-TTY Agent commands and Hooks run without loading the PowerShell profile. PTY execution uses the same `pwsh` executable and still suppresses the profile.
- Timeout, background completion, process IDs, durable output, and interrupt handling are ForgeRelay process-lifecycle features; do not replace them with ad-hoc child-shell polling.
