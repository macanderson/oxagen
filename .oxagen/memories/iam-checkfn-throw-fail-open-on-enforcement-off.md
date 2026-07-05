---
name: iam-checkfn-throw-fail-open-on-enforcement-off
type: bug
domain: security
severity: P1
linear: OXA-2056
date: 2026-07-04
---

**Symptom:** When the kernel's registered IAM `checkFn` throws (resolver error — DB down, IAM migration missing, resolver bug) AND `IAM_ENFORCEMENT_ENABLED` is false, the kernel silently allowed the call to proceed. This affected both `invoke()`'s main dispatch path and the `authorizeExternalCapability()` helper (used for MCP-passthrough / external tool calls) in `packages/oxagen/src/kernel.ts`.

**Root cause:** Both code paths gated the fail-closed branch on `iamCheckThrew && _iamEnforced`. A throw means the IAM check could not be evaluated at all — a categorically different situation from a policy "deny" decision (which legitimately respects the enforcement flag during a rollout window). Conflating "couldn't evaluate" with "evaluated to allow" meant any transient resolver failure during the enforcement-off period silently granted access to every capability call.

**Fix:** Changed both throw-handling blocks (`packages/oxagen/src/kernel.ts`, main `invoke()` around the IAM check, and `authorizeExternalCapability()`) to `if (iamCheckThrew)` — unconditional, never gated on `_iamEnforced`. A throw always denies (`CapabilityError(code="authz_denied")` for `invoke()`, `{ allowed: false, outcome: "deny", reason: "iam_check_error" }` for the external-capability helper) and always emits the security/audit event.

**Guard:**
- `packages/oxagen/src/kernel.test.ts` — new describe block "invoke() IAM check throw — fail closed regardless of enforcement" asserts `authz_denied` for both enforcement true and false.
- Existing test "fails open (allow, no event) when the resolver throws AND enforcement is off" in the `authorizeExternalCapability` describe block was rewritten to assert fail-closed instead (it previously documented the bug as intended behavior).

**Watch-outs:** Any future IAM-adjacent gate (billing admission, capability entitlement) that distinguishes "couldn't evaluate" from "evaluated to deny" must apply the same rule: a thrown/errored check is always a hard deny, independent of any enforcement/rollout flag. Only an actual policy *decision* should ever be softened by an enforcement flag.
