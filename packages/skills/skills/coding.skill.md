---
name: coding
description: How to write code well as an agent — understand the codebase first, match its conventions, make small reviewable changes, cover them with tests, and never weaken security or performance.
metadata:
  weight: high
  category: engineering
---

# Writing code

Load this skill before adding or changing code. The goal is a change a
human reviewer accepts on the first pass: it fits the project, does one
thing, and proves it works.

## Understand before you write

Read the surrounding code before you touch it. Find how the project
already solves the problem — its naming, its file layout, its error
handling, its test style — and follow that, even when your personal
preference differs. A change that reads like the rest of the codebase is
the change that gets merged.

If a utility, component, or helper already exists, reuse it. Adding a
second way to do something the project already does is the most common
reason a change is rejected.

## Keep changes small and focused

One change should do one thing. Resist the urge to refactor unrelated
code in the same edit — separate concerns into separate changes so each
is easy to review and easy to revert. If a change grows past what a
reviewer can hold in their head, split it.

## Types, validation, and errors

- Prefer explicit types at boundaries (function signatures, API inputs,
  stored records). They are the cheapest documentation a reader gets.
- Validate untrusted input where it enters the system, not deep inside.
- Handle the failure path. Surface a clear error; never swallow one
  silently or leave a `catch` block empty.

## Test what you write

New behavior needs a new test. Cover the happy path and at least one
failure or edge case. A bug fix lands with a test that fails before the
fix and passes after, so the bug cannot return unnoticed. Run the test
suite before declaring the work done.

## Security defaults

- Never hard-code secrets, tokens, or credentials. Read them from
  configuration or environment.
- Treat all external input as hostile until validated.
- Scope every data access to the current user, tenant, or workspace.
  A query that can read another tenant's data is a security defect, not
  just a bug.

## Performance defaults

- No queries inside a loop over rows — batch or join instead.
- Paginate anything that lists records; no endpoint returns "all rows".
- Stream or chunk anything that could grow large rather than buffering
  it whole in memory.

## Comments

Comment the *why*, not the *what*. Explain a non-obvious decision, a
trade-off, or a constraint a future reader would otherwise have to
rediscover. Never write a comment that just restates the next line.
