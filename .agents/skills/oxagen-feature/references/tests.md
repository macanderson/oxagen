# Tests

Two layers: Vitest for unit/logic, Playwright for end-to-end. Cover the happy path, batch, validation failure, and tenant isolation. Do not test only the happy path.

## Vitest (unit)

```ts
// packages/oxagen/src/capabilities/<capability-name>.test.ts
import { describe, it, expect } from "vitest";
import { <camelName>Input } from "./<capability-name>";
import { run<PascalName> } from "./lib/<capability-name>";
import { fakeCaller } from "../../test/fixtures";

describe("<capability>", () => {
  it("accepts a valid batch input", () => {
    expect(<camelName>Input.safeParse({ items: [/* ... */] }).success).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(<camelName>Input.safeParse({ items: [] }).success).toBe(false);
  });

  it("processes each item and returns per-item results", async () => {
    const out = await run<PascalName>(fakeCaller(), { items: [/* two items */] });
    expect(out.results).toHaveLength(2);
  });

  it("never returns rows from another tenant", async () => {
    const out = await run<PascalName>(fakeCaller({ tenantId: "A" }), { items: [/* ... */] });
    expect(out.results.every((r) => r.tenantId === "A")).toBe(true);
  });
});
```

## Playwright (E2E)

```ts
// e2e/<capability-name>.spec.ts
import { test, expect } from "@playwright/test";
import { authedRequest } from "./helpers";

test("POST /v1/<capability> returns results", async ({ request }) => {
  const res = await authedRequest(request).post("/v1/<capability>", {
    data: { items: [/* ... */] },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.results.length).toBeGreaterThan(0);
});

test("rejects invalid input with 400", async ({ request }) => {
  const res = await authedRequest(request).post("/v1/<capability>", { data: { items: [] } });
  expect(res.status()).toBe(400);
});
```

For async/batch capabilities, also assert the 202 + job handle, then poll the status route to completion.

## Rules

- Every capability ships both unit and E2E tests. The gate runs both.
- Always include a tenant-isolation assertion. A capability that can leak across tenants is a bug, not an edge case.
- Test batch and error paths, not just one happy item.
