---
name: test-completeness-judge
description: LLM judge agent that audits test completeness for all new and changed features from multiple perspectives; blocks PR opening until all test requirements are satisfied
---

# Test Completeness Judge

**Purpose:** Comprehensively audit whether all code changes (new features, bug fixes, refactors) have adequate test coverage across unit, integration, and E2E layers. This judge gates PR opening.

**When to use:** BEFORE opening any pull request. Dispatch this judge to verify that all changed code has test coverage matching its scope, layers, and user-facing impact. Do not open a PR until the judge approves.

## Completeness Checklist

The judge evaluates code changes against these dimensions:

### 1. **Coverage by Layer**

- **Logic layer** (pure functions, utilities, algorithms): Unit test required
  - Tests behavior with various inputs
  - Tests error handling and edge cases
  - Tests all conditional branches
- **Database layer** (migrations, schemas, queries): Integration/E2E test required
  - Verifies schema changes with real database
  - Tests constraints, triggers, RLS
  - Verifies rollback behavior
- **API layer** (routes, handlers, contracts): Integration/E2E test required
  - Tests all endpoints (happy path + errors)
  - Tests request validation
  - Tests response contracts match schema
- **UI layer** (components, forms, pages): E2E test required
  - Tests rendering and visual correctness
  - Tests user interactions (click, submit, navigate)
  - Tests form submission without errors
  - Tests error states are visible to users
- **Integration** (cross-layer flows): E2E test required
  - Tests entire user workflow end-to-end
  - Tests data flows from UI through API to database
  - Tests side effects (webhooks, jobs, events)

### 2. **Coverage by Change Type**

- **New feature**: Unit + E2E required
  - All new functions/handlers have unit tests
  - All user-facing flows have E2E tests
  - All database changes verified with migrations
- **Bug fix**: Unit or E2E based on scope (see regression criteria)
  - Regression test prevents recurrence
  - Edge cases from bug analysis are tested
- **Refactor (no behavior change)**: Unit tests matching original behavior
  - Existing tests still pass
  - No new test coverage required (but may improve)
- **Schema/migration**: E2E test required
  - Migration applies cleanly forward and backward
  - Data integrity maintained
  - RLS policies updated if needed

### 3. **Edge Cases & Error Paths**

Judge verifies tests cover:
- **Boundary conditions** (limits, minimums, maximums)
- **Error scenarios** (network failures, validation errors, constraint violations)
- **Race conditions** (concurrent requests, debouncing, locking)
- **State transitions** (before/after state, side effects)
- **User inputs** (invalid, missing, malicious data)

### 4. **Verification Evidence Required**

Before approving, judge requires:
- **Unit tests**: Test code assertions proving behavior
- **E2E tests**: Screenshot directory exists, forms submit without error, DB queries verify state
- **Coverage metrics**: `pnpm test:coverage` output showing no regression
- **CI gate pass**: `pnpm gate` passes locally (lint, typecheck, coverage, test, build)

## Judge Prompt

When invoked, the judge receives:
- **Changed files**: List of all modified/new files in the PR
- **Feature description**: What was added/fixed/refactored and why
- **Affected layers**: Which packages/modules touched (logic, DB, API, UI, etc.)
- **User-facing impact**: Is this visible/interactive to users?

And responds with:
- **Completeness verdict**: APPROVED (all requirements met) | INCOMPLETE (missing tests, gaps)
- **Missing coverage**: Specific test types and user flows not yet covered
- **Required test plan**: Detailed test cases to add
- **Evidence checklist**: What proof (test output, screenshots, coverage metrics) must be provided
- **Blocking issues**: Tests that failed, coverage below threshold, CI gates not passing

## Example Invocation

**Feature:** New "export as PDF" capability for conversations.

**Files changed:** 
- `apps/app/src/components/conversation/ExportButton.tsx` (new)
- `apps/app/src/api/conversations/export.ts` (new route)
- `packages/oxagen/src/contracts/document.ts` (updated contract)
- `apps/api/src/routes/v1/document.ts` (new route)

**Judge Output:**
```json
{
  "verdict": "INCOMPLETE",
  "layers_covered": {
    "logic": "✓ Contract validation tested",
    "api": "✓ API routes have tests",
    "ui": "✗ ExportButton component has NO tests",
    "e2e": "✗ PDF export user flow NOT tested",
    "integration": "✗ Full export pipeline (click → API → PDF generation → download) NOT tested"
  },
  "missing_coverage": [
    {
      "type": "unit",
      "location": "apps/app/src/components/conversation/ExportButton.test.tsx",
      "cases": [
        "Renders button correctly",
        "Disables when no conversation",
        "Shows loading spinner during export",
        "Handles export errors gracefully"
      ]
    },
    {
      "type": "e2e",
      "location": "apps/app/__tests__/export-pdf.spec.ts",
      "cases": [
        "User clicks Export, PDF generates, download starts",
        "Error message shows if PDF generation fails",
        "Button disabled during generation",
        "Large conversation (>10MB) handles gracefully"
      ]
    },
    {
      "type": "integration",
      "notes": "Test the full path: UI click → API route → PDF service → blob upload → download link"
    }
  ],
  "required_test_plan": {
    "unit": {
      "component": "ExportButton.test.tsx",
      "assertions": [
        "expect(button).toBeEnabled() when conversation exists",
        "expect(button).toBeDisabled() when conversation null",
        "expect(spinner).toBeVisible() during isLoading=true"
      ]
    },
    "e2e": {
      "flow": "User initiates PDF export",
      "steps": [
        "Navigate to conversation",
        "Click Export button",
        "Verify PDF download initiated",
        "Verify success toast"
      ]
    }
  },
  "evidence_checklist": [
    "□ ExportButton.test.tsx passes with ≥80% coverage",
    "□ export-pdf.spec.ts passes; screenshot directory has export-success.png",
    "□ apps/app coverage ≥ threshold (run pnpm test:coverage)",
    "□ pnpm gate passes locally (lint, typecheck, coverage, test, build)",
    "□ All merge conflicts resolved"
  ],
  "blocking_issues": [],
  "can_open_pr": false,
  "next_steps": "Write unit tests for ExportButton, E2E test for export flow, ensure coverage threshold maintained, then re-run judge before opening PR"
}
```

## Rules

1. **Every PR must pass the judge before opening.** No exceptions. Judge blocks incomplete coverage.
2. **Default to E2E when uncertain.** If code touches user-facing boundaries (UI, forms, navigation, data display), it needs E2E.
3. **Coverage must not regress.** After adding tests, verify `pnpm test:coverage` shows coverage at or above the package's threshold.
4. **Proof over claims.** Judge requires actual test code, passing test output, and coverage metrics — not promises that "tests will be added later."
5. **CI gate is non-negotiable.** `pnpm gate` must pass locally before the judge approves for PR opening.

## Judge Agent Invocation

```typescript
// Dispatch before opening a PR
const completenessReview = await agent({
  name: "test-completeness-judge",
  description: "Audit test completeness for all code changes before PR",
  subagent_type: "general-purpose",
  prompt: `
You are a test completeness judge. Audit all code changes in this PR for test coverage.

Changed files: ${changedFiles.join(', ')}
Feature: ${featureDescription}
Layers touched: ${affectedLayers.join(', ')}
User-facing: ${isUserFacing}

Respond in JSON:
{
  "verdict": "APPROVED|INCOMPLETE",
  "missing_coverage": [
    { "type": "unit|e2e|integration", "location": "file.test.ts", "cases": [...] }
  ],
  "required_test_plan": { "unit": {...}, "e2e": {...} },
  "evidence_checklist": ["□ test passes", "□ screenshot captured", ...],
  "blocking_issues": ["coverage below threshold", ...],
  "can_open_pr": true|false,
  "next_steps": "..."
}
  `
});
```

## Integration with PR Workflow

**Before opening PR:**
1. Implement all code changes (logic, database, API, UI)
2. Write unit tests for new functions/handlers
3. Write E2E tests for user-facing flows
4. Run `pnpm gate` locally; verify all gates pass
5. **Dispatch test-completeness-judge to audit coverage**
6. Judge responds with APPROVED or INCOMPLETE
7. **If INCOMPLETE:** Add missing tests and re-run judge
8. **If APPROVED:** Safe to open PR

See CLAUDE.md → "Test gate enforcement" for coverage ratcheting rules and CI gate details.
