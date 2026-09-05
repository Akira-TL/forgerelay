# ForgeRelay PowerShell 7 Instructions

ForgeRelay executes Agent commands and Hooks with PowerShell 7 (`pwsh`) for this runtime. Use PowerShell syntax, not Bash syntax.

- Environment variables use `$env:NAME`; do not use `export NAME=...`.
- Prefer explicit PowerShell cmdlets when semantics matter. Do not pass Unix flags to aliases such as `rm`, `ls`, or `cat`.
- Use `Get-Command` to discover commands. Use an explicit `.exe` name when native executable semantics matter.
- Use the call operator `&` for an executable stored in a variable or for a quoted executable path.
- Quote Windows paths deliberately. Do not copy Bash escaping rules into PowerShell native-command arguments.
- Native program success/failure is represented by `$LASTEXITCODE`; PowerShell cmdlet errors use PowerShell error semantics. Do not conflate the two.
- When cmdlet failure must stop the command, use terminating-error behavior deliberately rather than assuming every error terminates execution.
- PowerShell pipelines pass objects between cmdlets. Be explicit when crossing between object pipelines and native executables.
- PowerShell 7 supports pipeline-chain operators such as `&&` and `||`, but use them only when the reported runtime version supports them.
- ForgeRelay already inherits the server process environment. Do not source the user's PowerShell profile merely to recover PATH, aliases, modules, or prompt configuration.
