# ForgeRelay fish Instructions

ForgeRelay executes Agent commands and Hooks with fish for this runtime. Write fish syntax, not Bash or zsh syntax.

- Set shell variables with `set NAME value`; export environment variables with `set -gx NAME value` or another scope appropriate to the command.
- Inspect the previous command status with `$status`. Save it before another command runs if later logic depends on it.
- fish does not use Bash-style `VAR=value command`, `export NAME=value`, `$(...)`, or `[[ ... ]]` syntax. Use fish-native variable assignment, command substitution `(command)`, and conditionals.
- Use `and` / `or` or fish control flow deliberately; do not emit Bash-only chaining syntax when compatibility with the selected fish runtime matters.
- fish list variables and expansions differ from Bash arrays. Do not copy Bash array syntax.
- Quote paths and expansions when whitespace or wildcard interpretation would change the intended argument boundaries.
- ForgeRelay already inherits the server process environment. Do not source the user's interactive fish configuration, prompt, or plugins merely to recover PATH, aliases, or abbreviations.
