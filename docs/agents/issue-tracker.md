# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `Akira-TL/forgerelay`.
Always pass `-R Akira-TL/forgerelay` (or the command's equivalent explicit repository selector) to `gh` operations so automation never depends on Git remote inference.

## Conventions

- Create: `gh issue create -R Akira-TL/forgerelay --title "..." --body "..."`.
- Read: `gh issue view -R Akira-TL/forgerelay <number> --comments`.
- List: `gh issue list -R Akira-TL/forgerelay --state open --json number,title,body,labels,comments`.
- Comment: `gh issue comment -R Akira-TL/forgerelay <number> --body "..."`.
- Label: `gh issue edit -R Akira-TL/forgerelay <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close -R Akira-TL/forgerelay <number> --comment "..."`.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill conventions

When a skill says to publish to the issue tracker, create a GitHub issue. When a
skill says to fetch a ticket, read the corresponding GitHub issue and its
comments. GitHub issue dependencies are preferred for blocking relationships
when available.
