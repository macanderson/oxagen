---
name: a-comment-claiming-a-fix-is-a-silent-failure
type: observation
domain: ci
severity: P1
linear: n/a (GitHub macanderson/oxagen#2556, #2559)
date: 2026-09-11
---

**Observation:** Epic #2556 hunts "a CI step whose own log says it failed while GitHub shows green." The same defect class has a second, unlabelled medium: **a code comment or PR body that names an issue it did not fix.** Both leave a reader holding a belief the evidence does not support, and the comment version is worse, because it actively redirects the next investigator away.

**Concrete instance:** PR #2857 raised Playwright's `expect: { timeout: 10_000 }` and its comment said "that mismatch is #2559's rotating navigation timeout." It is not. #2559's failures are `page.waitForURL`, a navigation primitive rather than an assertion, so `expect.timeout` never governed them — and each call already passed an explicit LARGER timeout (15 s in `account-nav.spec.ts`, 20 s in `agent-rbac-builder.spec.ts`). The raise could not have moved those waits in either direction. Left uncorrected, the next clean nightly would have been read as confirmation and the issue closed on a bug still present.

**How to apply:** In Playwright specifically, `expect.timeout` governs ONLY bare `await expect(locator)…` calls that omit their own `timeout` option. It does not govern `page.waitForURL`, `page.goto`, `locator.click`, or any call passing an explicit timeout. Before crediting a timeout change with fixing a flake, check which timeout actually bounds the failing call.

Generally: when a change claims to fix an issue, verify the mechanism reaches the failure, not just that both concern "timeouts." And when a fix is real but targets a different failure class than the issue it cites — as #2857 genuinely was — say both things, rather than letting the citation stand.
