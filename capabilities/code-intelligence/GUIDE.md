# Code Intelligence

Use the `code.intelligence` Capability for read-only semantic code navigation backed by Language servers that are already installed on the user's machine or explicitly configured for the project.

ForgeRelay does not install Language servers. It discovers supported executables when available and accepts explicit definitions from the global ForgeRelay config or `<workspace>/.forgerelay/language-servers.json`. Project definitions override global definitions, and global definitions override built-in discovery. An explicit definition may disable discovery with `enabled: false`.

For 0.4.0, the supported operation is `definition`. Pass a workspace-relative source `path` plus 1-based `line` and `column` values. Columns are Unicode code-point positions; ForgeRelay converts them to the position encoding negotiated with the Language server.

Code-intelligence results use ForgeRelay-normalized locations rather than raw LSP wire types. A result may identify an External code location outside the Workspace, but that does not expand ForgeRelay's allowed roots or grant the file tools permission to read that path.

Language-server definitions use structured process configuration rather than shell command strings. A project configuration entry may contain `command`, `args`, `env`, `languages`, `extensions`, `languageIdByExtension`, `projectMarkers`, and `enabled` fields. Use `languageIdByExtension` when one server definition covers multiple language IDs whose extensions do not map one-to-one by array position. The server command is launched directly without a shell.
