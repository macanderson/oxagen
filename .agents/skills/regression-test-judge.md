---
name: regression-test-judge
description: LLM judge agent that determines appropriate test type (unit vs E2E) for regression testing based on bug scope and fix characteristics
---

# Regression Test Judge

**Purpose:** Determine whether a bug fix requires a unit test, E2E test, or both by analyzing the bug's scope, layers touched, and user-facing impact.

**When to use:** After every bug fix, invoke this judge to decide the regression test type before writing tests.

## Decision Tree

The judge analyzes these dimensions:

### 1. **Scope** (single module vs multiple files)
- **Single module**: pure logic, utility, no side effects → **unit test**
- **Multiple files**: cross-module dependencies, contracts between layers → **unit test** (integration-style)
- **Package-level**: touches API, storage, or external services → **E2E test**

### 2. **Layers Touched** (identify which layers the fix affects)
- **Logic only** (pure functions, algorithm fixes): **unit test**
- **Logic + Database** (schema, RLS, migrations): **E2E test**
- **Logic + API** (routes, contracts): **E2E test**
- **Logic + UI** (forms, state, rendering): **E2E test**
- **UI only** (layout, styling, CSS): **E2E test** (visual regression)

### 3. **User-Facing Impact** (does the user see/interact with this?)
- **No** (internal utility, logging, telemetry): **unit test**
- **Yes** (form submission, page navigation, data display): **E2E test**
- **Indirect** (API response affecting UI indirectly): **both** (unit for API, E2E for UI)

### 4. **Verifiability** (how can we prove it works?)
- **Code inspection** only: unit test is sufficient
- **Needs user interaction** (click, submit, navigate): E2E test required
- **Needs database state** (transaction, rollback, constraint): E2E test required
- **Needs network call** (API, webhook, external service): E2E test required

## Judge Prompt

When invoked, the judge receives:
- **Bug description**: what was broken
- **Fix summary**: what code changed and where
- **Affected layers**: which packages/modules touched
- **User impact**: is this user-facing?

And responds with:
- **Test type** (unit | e2e | both)
- **Rationale**: which dimensions drove the decision
- **Test scope**: what the test should cover (specific assertions, user flows)
- **Edge cases**: regression scenarios to verify

## Example Invocation

**Bug:** Form submission silently fails when billing credits run out.

**Fix Summary:** Added check-constraint validation in `billing.ts` and updated API route `/api/v1/billing/check` to return error on insufficient credits.

**Judge Output:**
```
Test Type: BOTH (E2E primary, unit secondary)

Rationale:
- Layers touched: Database (check-constraint) + API route + Form submission
- User-facing: YES (user sees error message on form submit)
- Verifiability: Needs database state + API response + form error handling

Test Plan:
Unit: Test the billing.checkCredits() function with mock data (sufficient/insufficient credits)
E2E: Navigate to billing form, attempt submission with zero credits, verify error toast appears and form stays open

Edge Cases to verify:
- Concurrent submissions (debounce still works)
- Credits exactly at limit (boundary condition)
- Network error during check (retry logic)
```

## Rules

1. **Default to E2E when uncertain.** If the fix touches the user-facing boundary (API, form, navigation), add an E2E test even if a unit test exists.
2. **Never skip regression tests.** Every bug fix gets at least a unit test; user-facing bugs always get E2E.
3. **Test isolation.** Unit tests must not depend on database or network; E2E tests must exercise the real flow.
4. **Coverage ratcheting.** After writing the regression test, verify the coverage metrics in CI match the test gate thresholds. Never lower the gate.

## Judge Agent Invocation (Sonnet/Opus)

```typescript
// Dispatch as a subagent in your workflow
const testDecision = await agent({
  name: "test-judge",
  description: "Determine regression test type for bug fix",
  subagent_type: "general-purpose",
  prompt: `
You are a test-type judge. A bug has been fixed; determine whether the regression test should be UNIT, E2E, or BOTH.

Bug: ${bugDescription}
Fix: ${fixSummary}
Layers touched: ${affectedLayers}
User-facing: ${userFacing}

Respond in JSON:
{
  "test_type": "unit|e2e|both",
  "rationale": "...",
  "test_scope": {
    "unit_assertions": ["..."],
    "e2e_flows": ["..."]
  },
  "edge_cases": ["..."]
}
  `
});
```

## Integration with CLAUDE.md

See CLAUDE.md → "Subagent workflows — writable agents only" for guidance on:
- When to dispatch the judge (always after bug fix, before writing tests)
- How to wire judge output into your bug-fix workflow
- Regression testing as a non-negotiable requirement
