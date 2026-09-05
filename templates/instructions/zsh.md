# ForgeRelay zsh Instructions

ForgeRelay executes Agent commands and Hooks with zsh for this runtime. Use zsh syntax deliberately rather than assuming every Bash-specific construct behaves identically.

- Environment variables are exported with zsh/POSIX syntax such as `export NAME=value`; shell-local variables do not need `export`.
- Inspect command success with `$?` when it is needed, and preserve the relevant status before running another command.
- Quote parameter expansions unless zsh-specific splitting or globbing is intentionally required. Do not depend on Bash-only word-splitting behavior.
- zsh arrays are 1-indexed by default and have zsh-specific expansion semantics. Do not copy Bash array expressions without checking them.
- Use zsh conditionals, glob qualifiers, and parameter-expansion features only when they make the command clearer; prefer portable command-line tools when shell-specific syntax is unnecessary.
- Do not assume Bash-only builtins or options such as `shopt` exist.
- ForgeRelay already inherits the server process environment. Do not source the user's `.zshrc`, Oh My Zsh, prompt theme, plugins, or interactive profile merely to recover PATH or aliases.
