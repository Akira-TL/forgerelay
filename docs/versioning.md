# Versioning and Release Management

ForgeRelay is published as `@akira-tl/forgerelay` from the
`Akira-TL/forgerelay` GitHub repository.

## Version format

ForgeRelay uses standard Semantic Versioning:

```text
MAJOR.MINOR.PATCH
```

The initial independent release is:

```text
0.1.0
```

The old temporary fork version format (`X.Y.Z-akira.N`) is no longer used.
Upstream DevSpace provenance and baseline information belong in Git history,
`NOTICE.md`, and release notes rather than ForgeRelay's public version number.

While the project is below `1.0.0`:

- patch releases are backward-compatible fixes and small refinements;
- minor releases may add substantial runtime capabilities and may include
  explicitly documented pre-1.0 interface changes;
- `1.0.0` marks the first stable public runtime/tool contract.

## Changelog policy

All user-visible changes first land under:

```text
## [Unreleased]
```

Use the usual categories when relevant:

- Added
- Changed
- Fixed
- Security
- Removed
- Compatibility

The release helper promotes `Unreleased` into a dated release section. It
refuses to bump a version when `Unreleased` is empty.

## Release commands

Check package, lockfile, repository, changelog, and attribution metadata:

```bash
npm run release:check
```

Prepare the next patch release:

```bash
npm run release:patch
```

`npm run release:next` is an alias for a patch release.

Prepare a minor or major release:

```bash
npm run release:minor
npm run release:major
```

The bump commands update:

- `package.json`
- root package metadata in `package-lock.json`
- `CHANGELOG.md`

They do not commit, tag, push, or publish.

Run the full local release gate with:

```bash
npm run release:verify
```

`release:verify` checks the current development runtime and then runs a focused
`release:parity` gate in an isolated Node 22.19.0 sandbox. The parity sandbox
performs its own `npm ci` so native addons use the same Node ABI as cloud CI,
then reruns the LSP/release tests most sensitive to event-loop timing, process
lifecycle, path canonicalization, executable discovery, and cleanup behavior.
It also tests that a command which exists on `PATH` but fails its `--version`
preflight is treated as unavailable rather than as an installed Language server.

Cloud verification and the publication job are both pinned to Node 22.19.0, the
minimum supported Node release, so local parity and the release runners use the
same runtime instead of drifting across separate Node 22/24 variants.

Validate a specific tag with:

```bash
npm run release:tag-check -- v0.1.0
```

A release tag must exactly equal `v` followed by the package version, and
`Unreleased` must be empty.

## CI and tag-triggered publishing

`.github/workflows/ci.yml` is a reusable workflow with only a `workflow_call`
entry point. It does not run on ordinary branch pushes, pull-request updates, or
manual dispatches. Day-to-day development therefore does not consume cloud CI.

`.github/workflows/release.yml` is the single GitHub Actions entry point. It runs
only for stable SemVer tags matching `v[0-9]+.[0-9]+.[0-9]+` in the
`Akira-TL/forgerelay` repository. The release helper then requires the tag to
exactly equal `v` plus the package version. Ordinary branch pushes never enter
cloud CI or publication.

For a valid tag, the workflow:

1. invokes `.github/workflows/ci.yml` for the cloud multi-platform verification;
2. waits for every CI matrix job to pass;
3. checks out the tagged commit with full Git history;
4. verifies the tagged commit is contained in `origin/main`;
5. installs dependencies and checks the tag against `package.json` and `CHANGELOG.md`;
6. rebuilds the publish artifact on the publication runner;
7. runs `npm pack --dry-run`;
8. checks whether the exact npm version is already published;
9. publishes `@akira-tl/forgerelay` when necessary;
10. creates the matching GitHub Release after npm publication succeeds.

The npm existence check makes the workflow safely restartable when npm
publication succeeds but GitHub Release creation fails afterward.

## First public npm release

Before the first public release, rename the GitHub repository to:

```text
Akira-TL/forgerelay
```

and update the local `origin` remote if Git does not update it automatically.
The package metadata and release workflow intentionally target the final
ForgeRelay repository name.

If `@akira-tl/forgerelay` does not yet exist on npm, GitHub Actions can bootstrap
it with a temporary npm publishing token:

1. create an npm token that can publish packages in the `@akira-tl` scope;
2. add it to `Akira-TL/forgerelay` as the Actions secret `NPM_TOKEN`;
3. push the first verified ForgeRelay release tag;
4. let the tag workflow publish the package;
5. configure npm Trusted Publishing for the package using:
   - owner: `Akira-TL`
   - repository: `forgerelay`
   - workflow filename: `release.yml`
6. delete the `NPM_TOKEN` GitHub secret.

After Trusted Publishing is configured, normal releases use GitHub Actions OIDC
through the workflow's `id-token: write` permission and do not need a long-lived
npm publishing token.

## Normal release procedure

1. Put all intended user-visible changes under `Unreleased`.
2. Run `npm run release:check`.
3. Run the appropriate `release:patch`, `release:minor`, or `release:major`
   command.
4. Review the generated version and changelog diff.
5. Run `npm run release:verify` locally. This full local gate includes the isolated
   Node 22.19.0 parity sandbox and is a release-time operation; ordinary development
   pushes do not need to run the full release gate.
6. Commit the release-ready code and metadata and push `main`.
7. Create the exact version tag, for example:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

The tag push is the publication action. The release workflow publishes npm only after cloud CI passes, then extracts the matching `CHANGELOG.md` release section as the GitHub Release body. Keep `Unreleased` user-facing and structured (`Added`, `Changed`, `Fixed`, `Security`) because those notes are what users see on the Release page.

Project release Hooks match the stable tag-push command as a substring of the ForgeRelay shell request. A compound command is allowed: when `commandRegex` matches `git push origin vX.Y.Z`, the Hook receives that matched command as `FORGERELAY_HOOK_PAYLOAD.command` and retains the complete shell request as `originalCommand` when they differ.

## Attribution guardrails

`release:check` intentionally verifies that public packages keep the required
upstream provenance:

- `LICENSE` must preserve `Copyright (c) 2026 Waishnav`;
- `LICENSE` records Akira-TL's modifications without replacing the upstream
  notice;
- `NOTICE.md` must identify `https://github.com/Waishnav/devspace`;
- `NOTICE.md` must state that ForgeRelay is independently maintained by Akira-TL;
- the npm package must include `NOTICE.md`.

Do not weaken these checks as part of ordinary branding or release work.

## Compatibility identifiers

The ForgeRelay rename does not require destructive migration of internal state.
Some persisted identifiers deliberately keep historical DevSpace names when
changing them would orphan existing data, including older SQLite schema/file
identifiers and review Git refs. These are storage compatibility details, not
public product branding.

New user-facing configuration, managed branches, CLI output, package metadata,
and release names use ForgeRelay.
