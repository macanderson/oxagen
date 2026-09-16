## Self-Evaluation — adversarial review of PR #3025 (tools lane: classification, connections, kill switches) — 2026-09-16

### What I set out to do
Adversarially review 106 changed files on `G2958-be` (head `40b58f60b`, base `origin/app-rebuild`
`d847ffc9b`) for genuine defects, focused on kill-switch fail-open, tenancy/RLS, capability parity,
and gate ordering in `materialize-tools.ts`.

### What I actually did (measurable deltas)
Read the diff in a detached worktree (`/tmp/claude-0/pr3025`), traced the kill-switch write path
(`kill_switch.set.ts` → `packages/iam/src/kill-switch.ts` → `emergency_denies` + the deny-generation
trigger in `20260813110000`) against both read paths (`packages/agent/src/runtime/kill-switch-gate.ts`
and `live-agent-run-authorization.ts`). Verified the RLS policy class of every table the new code
touches against `tenant-policy.manifest.ts` and `gen-rls-migration.ts`. Produced 3 P1 and 8 P2
findings; found no P0.

### Quality of my decisions
- Best decision I made and why: chasing the *tag vocabulary* instead of the gate's control flow.
  The gate's ordering and fail-closed behaviour are correct and well tested; the actual fail-open is
  that `readClassificationIndex` reads only `tool_versions.classification->consequenceTags` while
  `publish_tool_declaration`/`import_tools` write the same tags to the `consequence_tags` *column*.
  No amount of staring at `check()` would have found that.
- Weakest decision I made and why: I spent several tool calls proving the Postgres `ON CONFLICT`
  inference predicate matched the partial unique index, which was never plausibly wrong and which CI's
  `atlas-validate` + the handler's own 643-line test file already covered. That budget should have gone
  to the `apps/api/src/routes/v1/chat.stream.ts` call site, which I only confirmed existed.

### What I could have done better
1. I asserted the "delete + re-add rotates the UUID a kill switch is bound to" finding from reading
   `deleteWorkspaceSecret` and `plugin.org.uninstall`, but never traced the *re-add* path to confirm a
   fresh `mcp.credentials` / `mcp.mcp_servers` row is minted rather than an existing row revived. The
   conclusion follows from `idMixin`'s `$defaultFn`, but I inferred it instead of reading the insert.
2. I did not read a single one of the ~2,900 added test lines closely. A test that asserts the wrong
   invariant is a defect too, and `kill_switch.set.test.ts` (643 lines) is exactly where a reviewer
   would find the author's own model of the feature written down. I judged the code without checking
   whether the tests agree with my reading of it.
3. I judged UI-parity compliance purely from `layers[]` not containing `app`. I never checked whether
   the paired `-fe` PR exists or whether `check:ui-parity`'s reverse advisory already flags these six
   capabilities — so "no merge blocker" is a narrower claim than it sounded.

### What surprised me about this codebase/product
The deny-generation trigger is genuinely well built — `iam.bump_deny_generation` is SECURITY DEFINER
with a pinned `search_path`, saves and restores `app.rls_bypass`, and the new migration reuses it for
`tool_versions.classification` rather than inventing a second invalidation path. The `workspace_nullable`
policy class is also what makes org-wide switches readable from inside a workspace scope; a `standard`
class there would have been a silent P0, and the author got it right.

### Risks I am leaving behind (untouched on purpose, and why)
- I did not verify any finding by execution. Per the task I preferred reading, and the repo bans broad
  test runs; every finding is a code-reading claim with a stated file:line, not an observed failure.
- I did not review the ~2,900 added test lines, the six MCP tool files, or the seven new
  `docs/capabilities/*.md` beyond confirming they exist.
- I did not evaluate whether `mcp.credential_grants` should have an FK to `mcp.mcp_servers`; I only
  noted that the absent FK is what lets the orphan-row P1 happen.

### Confidence in the result: medium-high
High on P1-1 (two same-named tag sets, one unread by the gate — every file in the chain read directly)
and P1-2 (`toItem` throws unconditionally on a null LEFT JOIN, and `plugin.org.uninstall.ts:37` hard-
deletes the joined row). Medium on P1-3, which rests on the inferred re-add path above. No P0 found,
and I believe that: the gate is fail-closed on read error at every call site I traced.
