# ADR-137: Standing decisions are workspace context records, stored once

- Status: accepted. ADR-181 (2026-09-25) removed `.oxagen/` from this repository. The standing decisions now live in the `AGENTS.md` block.
- Date: 2026-09-22
- Related: ADR-038 (the replicated markdown corpus this supersedes), ADR-039 (the centralized check), ADR-091 (a record steers through the bundle), ADR-099 (a linked repository is steered from the workspace's main repository)

## Context

ADR-038 put the same six standing decisions in `docs/scr/` in five repositories: oxagen, context-graph-protocol, cgp-website, arenabench, and stella. The copies were supposed to be byte-identical. They were not. SCR-006 landed in oxagen and stella and not in the other three, and stella's compiled summary titled it differently. The drift check then filed #3702.

The maintainer's decision on that issue is that these are not documents to copy. They are context records. A connected repository does not carry them. It connects to a workspace, and the workspace steers it.

## Decision

The six standing decisions are context records in `context-record/v0.1` TOML, one file per lineage, under `.oxagen/rules/` in the oxagen repository only:

| Record | File |
|---|---|
| SCR-001 | `.oxagen/rules/ctx.scr.001-no-full-suite-builds.toml` |
| SCR-002 | `.oxagen/rules/ctx.scr.002-durability-first.toml` |
| SCR-003 | `.oxagen/rules/ctx.scr.003-dod-verified-close.toml` |
| SCR-004 | `.oxagen/rules/ctx.scr.004-fix-over-file.toml` |
| SCR-005 | `.oxagen/rules/ctx.scr.005-triage-separation.toml` |
| SCR-006 | `.oxagen/rules/ctx.scr.006-schema-change-labelled.toml` |

`sharing_scope` is `workspace` and `force` is `must`. The statement is the directive an agent follows. Oxagen's `AGENTS.md` keeps a compiled summary, because Codex, Cursor, Claude Code, and Stella read that file when they work in this repository. The summary cites the TOML files. It is not a second corpus.

`docs/scr/` is removed from all five repositories. `scr-corpus-check` no longer compares copies. It fails when any of the five still has a file under `docs/scr/`.

Enforcement that was never the corpus stays where ADR-039 put it: the DoD workflows, the triage guard, and the scoped-test hook.

## Why durable

A workspace already has one place for a rule that must reach every repository it steers: a context record on the main repository, compiled into the session. Copying the same markdown into each repository made five sources of truth and a job whose only purpose was to notice that they disagreed. One file per directive, in the repository the workspace already reads, is the record. A later change is a new revision of that file, not a five-repository rollout.
