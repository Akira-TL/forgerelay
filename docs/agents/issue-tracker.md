# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `Akira-TL/forgerelay`.
Use the `gh` CLI from this checkout so repository resolution follows the current
`origin` remote.

## Conventions

- Create: `gh issue create --title "..." --body "..."`.
- Read: `gh issue view <number> --comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`.
- Comment: `gh issue comment <number> --body "..."`.
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill conventions

When a skill says to publish to the issue tracker, create a GitHub issue. When a
skill says to fetch a ticket, read the corresponding GitHub issue and its
comments. GitHub issue dependencies are preferred for blocking relationships
when available.
