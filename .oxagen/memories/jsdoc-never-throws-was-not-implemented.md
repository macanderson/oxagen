---
name: jsdoc-never-throws-was-not-implemented
type: observation
domain: billing
severity: P1
github: 2786
date: 2026-09-11
---

**Observation:** `recordGovernedAction` in `packages/billing/src/action-metering.ts`
carried the docstring "Never throws on a billing failure. The kernel calls this
after the action has already happened and the customer's response is already
correct; a throw here could only turn a missed charge into a broken request."
The `await consumeCredits(...)` inside it had no `try`/`catch`. The promise it
described was never implemented.

**Why it matters:** the kernel's usage recorder awaits this after the handler
has succeeded and the output has validated. A credit-ledger outage would have
rejected on a request whose work was done and whose response was correct —
turning a missed charge into a 500, which is exactly the trade the comment says
must never be made.

**How it was found:** writing tests FROM the comments. The docstrings in this
file state invariants precisely, so each claim became a test, and the claim with
no code behind it failed immediately.

**How to apply:** when a comment states a guarantee — "never throws", "always
idempotent", "cannot be negative", "fires exactly once" — write the test that
would fail if it stopped being true, before trusting it. In this repo the
best-written files are the highest-risk for this, because a confident docstring
reads like verification and is not. Related:
[[recordgovernedaction-billing-failure-must-not-break-request]].
