## Self-Evaluation — adversarial review of PR #3055 (in-app agent on stella-serve) — 2026-09-16

### What I set out to do
Adversarially review 169 changed files on `app-rebuild-g2968-be` (head 9cf009134) for genuine
defects, ranked P0/P1/P2, without running suites.

### What I actually did (measurable deltas)
Read the full diff stat, then read in full: assistant-turn.ts, assistant-run.ts, assistant-stream.ts,
tool-belt.ts, governed-turn.ts diff, approval.ts diff, materialize-tools.ts execute path,
plugin-entitlement.ts, chat.stream.ts (new), chat-stream-translator.ts diff, the six new contracts,
grants.ts / spend-budget-gate.ts, the notification migration + schema, org.create.ts, register.ts,
handlers/index.ts resolver. Verified the `agent_runs.surface` NOT NULL question against the schema,
the `notification.notifications` policy class against tenant-policy.manifest.ts, and the
`get_assistant_engine` resolver collision by simulating resolveHandler's export filter in node.
Produced 1 P0, 2 P1, 6 P2.

### Quality of my decisions
- Best decision: reading `packages/agent/src/handlers/index.ts`'s `resolveHandler` heuristic before
  trusting that a new LOADERS entry works. That is where the P0 lives, and nothing in the diff
  points at it — the defect is in a file the PR only added four lines to.
- Weakest decision: I spent a long pass on billing/money before checking handler registration, even
  though the money change (`grantSignupCredits`) was BigInt-only and obviously clean from the first
  read. Registration/parity should have been the first sweep on a PR that adds six capabilities.

### What I could have done better
1. I never checked `docs/capabilities/` ↔ contract parity or ran `check:manifest --json` mentally for
   the six new capabilities; I inferred parity from file existence in the diff stat. A missing MCP
   tool for one of them would have slipped past me.
2. I did not read `packages/handlers/src/chat.message.execution.ts` before calling the dropped
   execution record a P1 — I inferred the blast radius from grep hits for `projectToolUsageBestEffort`
   and `list_executions` rather than confirming what the app actually renders from it. The finding is
   real but its severity is less well-evidenced than the other two.
3. I noted but did not chase the `Recorder.seal` / `append` interleaving (seal reads `this.chain`
   once; an append queued after that await could take a seq past the terminal event). I left it out
   rather than proving it, which is the right call for a report but leaves a real question unanswered.

### What surprised me about this codebase/product
`@oxagen/agent` resolves its handlers by a *heuristic over module export names* (unique `*Handler`
function) rather than an explicit export reference, while `@oxagen/handlers` next door uses explicit
`m.fooHandler`. Two registration mechanisms with different failure modes, and only one of them can be
broken by adding a well-named factory function to a handler module.

### Risks I am leaving behind (untouched on purpose, and why)
- The `Recorder.seal` interleaving above — unproven, and proving it needs a running rig.
- `packages/oxagen/capabilities.manifest.json` / `contracts.generated.ts` — generated; a drift there
  would be caught by `check:contracts`, which CI ran green.
- `apps/mcp/src/tools/*` new tools read only in outline; they are 25-line thin adapters matching a
  template I verified once on `assistant.ask.ts`.

### Confidence in the result: high for P0/P1, medium for P2
P0 reproduced by simulating the exact resolver logic against the module's real export set
(2 `*Handler` function exports -> `named.length !== 1` -> throw). P1 #1 verified by reading the live
`invoke("update_user_preferences", …)` call site in app_deprecated plus its removal from
`register.ts` and `contracts/index.ts`. The P2s are read-verified but their severity is judgement.
