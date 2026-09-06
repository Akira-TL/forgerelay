# ForgeRelay cmd.exe Instructions

ForgeRelay executes Agent commands and Hooks with `cmd.exe` for this runtime. Write cmd syntax, not PowerShell or Bash syntax.

- Environment variables use `%NAME%`; mutate them with cmd syntax such as `set NAME=value`.
- Preserve and inspect native process status with `%ERRORLEVEL%` when correctness depends on success.
- Command chaining, redirection, `%` expansion, `^` escaping, and parentheses are cmd-specific. Do not reuse Bash or PowerShell escaping rules.
- In compound or parenthesized command blocks, `%NAME%` may be expanded before later commands run. Use delayed expansion (`setlocal EnableDelayedExpansion` with `!NAME!`) only when needed, and remember that enabling it changes how literal `!` characters are handled.
- Quote executable paths and arguments using cmd semantics, especially when paths contain spaces or metacharacters.
- Do not emit PowerShell cmdlets such as `Get-ChildItem`, `$env:NAME`, or `&` unless explicitly launching PowerShell as a child process.
- Do not assume Unix aliases or utilities exist. Cross-platform executables such as `git`, `node`, `npm`, or `rg` may be invoked directly when installed.
- Do not silently switch to another shell merely because a command is easier there. The effective ForgeRelay command language remains cmd unless the owner changes the runtime configuration.
