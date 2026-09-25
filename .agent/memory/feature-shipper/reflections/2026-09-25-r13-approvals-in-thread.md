## Self-Evaluation — R13 approvals inside the assistant thread — 2026-09-25

### What I set out to do
Let a person approve or deny a parked write from the assistant flyout, run it
once approved, post the outcome into the thread, and keep Fleet and the flyout
on one state. Find and fix why #3127 says an approved call never runs.

### What I actually did (measurable deltas)
- Root cause for #3127: ADR-118 names the periodic worker as the fallback
  "after request-process failure", but the request-process delivery was never
  built. `resolve_approval` only set `queued`, so every approved call waited up
  to a minute for the cron, and one approved in the last minute of its
  five-minute window was expired unrun by the worker. Nothing reported back.
- `resolve_approval` now delivers the queued call in the deciding request
  through `resumeApprovedCall`, wrapped in `runOutsideGovernedAction` so the
  call is metered as its own governed action. It answers the row's execution.
- Parked cards now carry the public id the `ask_assistant` contract promises
  (they carried the row uuid).
- New flyout cards with Approve and Deny through Fleet's own action, state read
  from the approval row, bounded re-reads.
- Tests: 42 handler, 13 approval, 24 assistant-turn, 96 materialize-tools,
  17 contract, 28 Fleet action, 23 card, 4 read action, 86 flyout, 117
  import-graph. Four mutation probes each failed the test meant to catch them.

### Quality of my decisions
- Best: checking whether in-request delivery changed metering before writing
  it. A nested invoke never reaches the usage recorder, and the kernel already
  had `runOutsideGovernedAction`. A kernel test with a usage recorder proves it.
- Weakest: I first planned a `features/fleet/client` import from lint's
  allowlist alone. `import-graph.test.ts` would have refused it. I caught it by
  reading `layers.ts`, not by design.

### What I could have done better
1. Read `apps/app/src/test/arch/layers.ts` and ADR-167 before designing the app
   side. The two allowances shaped the design and cost a second pass.
2. I could not read the issues (#4162, #3127, #3848) or PR #4198. I should have
   said so before starting, so the coordinator could paste their DoD in.
3. The card posts outcomes inside the card rather than as separate thread
   entries, and nothing tells the model on its next turn. A server-side
   conversation message would make the outcome part of the record.
4. I used `capability-ui-map.json` round-tripping before checking its mixed
   escaping, and had to revert.

### What surprised me about this codebase/product
The ask_assistant contract documented `approvalId` as `apr_…` while the turn
sent the row uuid. `resolve_approval` accepts both, so nothing failed loudly.

### Risks I am leaving behind (untouched on purpose, and why)
- The worker still expires a queued approval once `expires_at` passes. With
  in-request delivery that only bites when delivery itself fails late.
- Until #4198 merges, the in-app assistant can still call `resolve_approval`
  on the agent surface. With this change such a call would now run the write
  at once instead of within a minute. #4198 closes that path.
- No production verification: delivery inside a Next.js server action is
  unproven outside unit tests.

### Confidence in the result: medium
Unit and component tests pass locally, with mutation probes. Typecheck, the
full suites and a real database run are CI's.
