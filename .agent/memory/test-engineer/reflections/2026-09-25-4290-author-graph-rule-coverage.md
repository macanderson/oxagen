## Self-Evaluation — PR #4290 author_graph_rule coverage audit — 2026-09-25
### What I set out to do
Judge whether each behavior of the new author_graph_rule contract, handler, route and MCP tool has a test that fails when it breaks; add the missing ones.
### What I actually did (measurable deltas)
Handler test 9 -> 13 cases, contract test 6 -> 15, new MCP tool test (5). Two handler mutants (role check against ctx instead of the resolved user; turnId always set) were each caught by exactly one new case. Commit 7b5ce65ae. The #4285 port the coordinator asked for was edited and passed 4/4 and lint, but the permission classifier denied its commit; left uncommitted in the worktree.
### Quality of my decisions
- Best: spotting that the role test's CTX.userId equalled the resolved id, so `assertOrgRole(ctx, ...)` survived; the API-key-shaped case closes it and was mutation-proven.
- Weakest: I wrote the port edits before checking whether a cross-lane app change would be allowed to commit; the edits now sit dirty in the worktree.
### What I could have done better
- Probe the contract bound tests with a mutant (e.g. widen LABEL_PATTERN) rather than trusting the 63/64 pairs by construction.
- Verify typecheck-staged actually covered the three files (it printed nothing) with a deliberate error, instead of trusting exit 0.
### What surprised me about this codebase/product
The kernel checks a surface only against opts.surface, so a nested invoke with no opts is never surface-denied. And resolveActingUserId makes this role-gated capability reachable from MCP, unlike older role-gated MCP tools.
### Risks I am leaving behind (untouched on purpose, and why)
The same-source refinement compares strings, so start `hubspot` and end `oxagen/hubspot` pass though they may name one connector. Deciding source identity needs a maintainer, so I reported it and did not pin it.
### Confidence in the result: high — each file run alone green (13, 15, 5), two mutants killed, lint and typecheck exit 0.
