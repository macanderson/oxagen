# ADR-115: Run discovery uses recorded place and harness

Date: 2026-09-19
Status: Accepted

## Context

Bisect required a public run ID that an operator had to find elsewhere. Run lists omitted existing place metadata. Telemetry could create a session with Claude Code as its default harness before Codex supplied its identity, and late context did not reach the session row.

## Decision

Extend `list_runs` with literal substring search, repository, harness and status filters, and current-run exclusion. Apply filters in the tenant-scoped source queries before keyset pagination. The same recorded harness and repository facts appear in list and detail responses. Unknown facts remain absent or null; neither a model provider nor an agent label identifies a harness.

Capture the working directory and Git root, branch and baseline commit locally. Fill missing session metadata from later accepted frames while preserving start facts. A verified sequence of consistent explicit hooks can repair an ambient harness label; stored evidence frames remain unchanged. Historical sealed sessions without such evidence are not relabelled by guessing.

Expose retained diff content through an explicit `get_run` detail request. Capture a bounded tracked-worktree patch against the first observed baseline commit in the existing content store, under the tool-call retention policy and redaction pipeline. Read it through tenant-scoped references and verify its digest. A missing, expired or incomplete recording never means an empty diff. This snapshot can include changes that predate the run and omits untracked file contents; the interface states this scope.

## Consequences

Operators can find and preview a comparison run without copying its ID. Existing APIs keep their unfiltered behavior and avoid patch reads unless requested. No new database columns are required. Older records gain visibility into facts already stored, but missing local metadata and expired patch content cannot be reconstructed. Local collector changes take effect when the updated collector is installed and running.
