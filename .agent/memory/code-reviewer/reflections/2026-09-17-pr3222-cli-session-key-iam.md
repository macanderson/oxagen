## Self-Evaluation — adversarial review of PR #3222 (CLI session key acts for its creator) — 2026-09-17

### What I set out to do
First adversarial review of a 4-file, security-adjacent IAM change that exempts
`cli_session_v1` keys from `machineKeyDenial`.

### What I actually did (measurable deltas)
Enumerated all 5 minted scope purposes and all 5 sites that map an API key to a
principal (`packages/auth/src/resolvers/api-key.ts`, `packages/iam/src/fetch-authz.ts:180`,
`packages/iam/src/org-role.ts:214`, `packages/handlers/src/lib/api-key-authz.ts:69`,
`packages/handlers/src/lib/capability-role-guard.ts:150`). Found one surface-
dependent authorization divergence (MCP drops `resolution.userId`), one stale
docblock/test comment pair, one dependency-direction nit, two pre-existing
adjacent defects (`rotate_api_key` has no reserved-purpose guard and reassigns
`created_by_id`). Confirmed the new test genuinely pins the guard by mutation
reasoning. No suites run (no vitest in flight; avoided an install).

### Quality of my decisions
- Best: refusing to stop at the diff. The diff is 15 lines; the finding is in
  `apps/mcp/src/context.ts:170`, a file the PR never touches.
- Weakest: I did not empirically run the mutation (delete the guard, re-run the
  file). Static reasoning was conclusive here, but I asserted it rather than
  proved it.

### What I could have done better
1. Built a worktree + narrow vitest run to *prove* the mutation claim instead of
   reasoning it, and to prove the MCP divergence with a written probe.
2. Checked whether `mcp.oxagen.sh` is actually reachable by a `cli_session_v1`
   key in production config (rate-limit / allowlist) before sizing the finding
   as P1 — I sized on code reachability alone.
3. Not chased `rotate_api_key`/`tacho_hosts.api_key_id` as far as I did before
   confirming it was out of blast radius; it cost context for a P2.

### What surprised me about this codebase/product
Four independent implementations of "who does this API key act as", two of which
(`fetch-authz`, `org-role`) ignore the scope purpose entirely and one of which
(`api-key-authz`) treats *any* purpose as a machine. The security property is
whichever one the calling handler happens to reach.

### Risks I am leaving behind
- Did not audit whether any `assertCallerRole`-only capability is high-value
  enough to make the MCP divergence a P0 rather than a P1.
- Did not verify #3182's `gatewayMandateTools` etag behaviour; out of scope.

### Confidence in the result: medium-high
Evidence: read every principal-resolution site end to end; purpose inventory is
exhaustive (5/5 accounted for). Lower than high because nothing was executed.
