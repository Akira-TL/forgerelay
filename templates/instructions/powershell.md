# ForgeRelay Windows PowerShell 5.1 Instructions

ForgeRelay executes Agent commands and Hooks with Windows PowerShell 5.1 (`powershell.exe`) for this runtime. Use Windows PowerShell syntax, not Bash syntax and not PowerShell 7-only syntax.

- Environment variables use `$env:NAME`; do not use `export NAME=...`.
- Prefer explicit PowerShell cmdlets when semantics matter. Do not pass Unix flags to aliases such as `rm`, `ls`, or `cat`.
- Use `Get-Command` for command discovery and an explicit `.exe` name when native executable semantics matter.
- Use the call operator `&` for an executable stored in a variable or a quoted executable path.
- Windows PowerShell 5.1 does **not** support PowerShell 7 pipeline-chain operators `&&` and `||`. Use explicit control flow and inspect status instead.
- Native process success/failure is represented by `$LASTEXITCODE`; cmdlet errors use PowerShell error semantics. Do not conflate them.
- When cmdlet failure must stop execution, use terminating-error behavior deliberately rather than assuming every error terminates.
- Windows PowerShell 5.1 native argument parsing differs from modern PowerShell. Quote Windows paths and native arguments deliberately; do not copy Bash escaping rules.
- PowerShell pipelines pass objects between cmdlets. Be explicit when crossing into native executables.
- ForgeRelay inherits the server environment. Do not source the user's PowerShell profile merely to recover PATH, aliases, modules, or prompt configuration.
