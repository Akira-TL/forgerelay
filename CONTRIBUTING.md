# Contributing

Thanks for your interest in improving ForgeRelay.

Bug reports, reliability problems, performance issues, documentation improvements, design feedback, and feature suggestions are all welcome. If something is confusing, broken, inefficient, or could be improved, please open an issue.

Pull requests are welcome as well, but ForgeRelay maintains a high bar for changes that become part of the project. A change being useful or necessary does not by itself mean that a particular implementation will be merged.

## Before You Start

For small, well-understood bug fixes or maintenance changes, a focused pull request is usually fine.

For non-trivial changes, new features, architectural work, public API changes, or anything that substantially changes product behavior, please open an issue first.

This gives us a chance to agree on the problem, scope, and direction before significant implementation work is done.

ForgeRelay has an existing roadmap, domain model, architecture decisions, and project documentation. Please read the relevant material before proposing substantial changes. Suggestions that challenge the current direction are welcome, but implementations should not silently replace established project decisions without discussing them first.

## Issues

Please feel free to open issues for:

- bugs and regressions;
- performance or memory problems;
- reliability and cross-platform problems;
- confusing behavior or documentation;
- feature requests and product improvements;
- architectural or implementation suggestions.

You do not need to arrive with a complete solution.

A useful issue explains what you observed, what you expected, and why the problem or improvement matters. Reproduction steps, logs, examples, measurements, or screenshots are especially helpful when applicable.

Opening an issue does not guarantee that the proposed solution or feature will be adopted, but good reports and suggestions are valuable even when the final implementation takes a different form.

## Pull Requests

Keep pull requests focused and independently understandable.

A PR should clearly explain what problem it solves, why the change belongs in ForgeRelay, and how the behavior was verified. Do not combine unrelated fixes, opportunistic rewrites, formatting churn, or broad refactors with the change being proposed.

Changes are evaluated on more than whether the underlying idea is useful. The implementation also needs to fit the project's architecture, scope, security boundaries, compatibility requirements, maintainability standards, and testing expectations.

This means a PR may be declined even when the problem it addresses is real and worth fixing. In that case, the idea may be implemented differently, reduced in scope, or incorporated later as part of the project's planned work.

That is not a rejection of the contribution itself; it is part of keeping the codebase coherent.

## Follow the Project Direction

For planned areas of work, prefer the interfaces, terminology, release direction, and architectural boundaries documented by the project.

In particular, check the roadmap, relevant ADRs, domain documentation, and contributor-facing guidance before starting substantial work.

If you think the documented direction is wrong, incomplete, or unnecessarily restrictive, open an issue and make the case. The project is open to changing its decisions when there is a good reason, but those decisions should be changed explicitly rather than bypassed in implementation.

## Quality Expectations

Changes should be as small as the problem reasonably allows while still being complete.

New behavior should have appropriate regression coverage. Bug fixes should demonstrate the failure being fixed when practical. Performance work should include evidence that the relevant behavior improves. Public behavior and compatibility changes should be tested through the same interfaces users actually consume.

Avoid unnecessary abstractions, speculative infrastructure, unrelated cleanup, and large rewrites when a smaller change solves the problem.

For UI changes, include clear before-and-after images. If the change depends on motion, timing, transitions, or interaction behavior, include a short recording as well.

## Review and Maintainer Decisions

Submitting a pull request starts a review; it does not create an obligation to merge the change.

Maintainers may ask for changes, reduce the scope, suggest another implementation, defer the work to a planned release, or close a PR that does not fit the project.

When a contribution is declined, the goal is to give a concrete reason whenever possible: scope, architecture, quality, compatibility, duplication, project direction, or another identifiable constraint.

The project welcomes contributions and ideas, while retaining a deliberately high bar for what becomes part of ForgeRelay.
