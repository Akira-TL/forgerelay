# Lifecycle hooks run only from user-controlled configuration

ForgeRelay Hooks v1 runs local command handlers configured by the user, not hook files discovered automatically inside a repository. `Before*` events are blocking and stop the operation when a handler fails or times out; completed operations are never rolled back because an `After*` handler fails. This keeps repository contents from gaining implicit local-command execution authority while still providing a general lifecycle policy surface; repository-local hooks can be reconsidered later only with an explicit trust/approval model.
