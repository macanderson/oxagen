// Rows the mockup hard-codes in its markup rather than in a collection (plan
// W5), hand-ported from mc.html @ mc-baseline-w1 in the mockup's own words.
// Like mc-baseline-w1.json, this file is read only by ../mapping.ts.

/** mc.html `REGISTRY_VERSIONS` and `FULL_BELT_LIMIT` (the toolbelt tab). */
export const REGISTRY = { versions: 3182, fullBeltLimit: 40 } as const;

/** pMandate(): "The ledger" table. */
export const MANDATE_LEDGER_ROWS = [
  {
    mandate: "mnd_7K2ETQ4",
    when: "08:40:19",
    call: "stripe__create_payment@4",
    amount: "2,450.00",
    state: "reserved",
    external: null,
    note: "awaiting approval",
    receipt: null,
  },
  {
    mandate: "mnd_7K2ETQ4",
    when: "2026-09-04 10:22:41.908Z",
    call: "stripe__create_payment@4",
    amount: "884.60",
    state: "settled",
    external: "pi_3QaL8f2Xk",
    note: null,
    receipt: "rcp_01K4X8M2E",
  },
  {
    mandate: "mnd_7K2ETQ4",
    when: "2026-09-02",
    call: "aws_billing__purchase_savings_plan@2",
    amount: "400.00",
    state: "settled",
    external: "sp-0a4f91c",
    note: null,
    // "rcp_01K4W2…" is truncated in the markup and has no RECEIPTS row.
    receipt: null,
  },
  {
    mandate: "mnd_7K2ETQ4",
    when: "2026-09-01",
    call: "stripe__create_payment@4",
    amount: "0.00",
    state: "released",
    external: null,
    note: "dispatch failed · released",
    receipt: null,
  },
] as const;

/** pSteering() effect tab. */
export const STEERING_EFFECT_ROWS = [
  {
    lineage: "ctx.release.notes-format",
    kind: "rule",
    rendered: 212,
    cited: 188,
    violated: 3,
    before: 0.41,
    after: 0.58,
    verdict: "keep",
  },
  {
    lineage: "ctx.release.never-merge",
    kind: "constraint",
    rendered: 212,
    cited: 212,
    violated: 0,
    before: null,
    after: null,
    verdict: "keep",
  },
  {
    lineage: "ctx.mobile.no-codegen",
    kind: "constraint",
    rendered: 84,
    cited: 71,
    violated: 1,
    before: 0.3,
    after: 0.33,
    verdict: "keep",
  },
  {
    lineage: "ctx.platform.changelog-once",
    kind: "fact",
    rendered: 212,
    cited: 96,
    violated: 0,
    before: 0.44,
    after: 0.45,
    verdict: "watch",
  },
] as const;

/** pSteering() retirement tab. */
export const RETIREMENT_ROWS = [
  {
    lineage: "ctx.platform.retry-budget",
    kind: "rule",
    published: "2026-03-11",
    rendered: 0,
    cited: 0,
    why: "Superseded by the hard budget on the agent definition. Nothing has rendered it in 90 days.",
    archived: "2026-09-01",
  },
] as const;

/** pOrganization() funding tab. */
export const FUNDING = {
  source: "platform",
  cap: "2,000.00",
  used: "1,082.45",
  routes: [
    {
      tier: "complex",
      route: "z-ai/glm-latest",
      resolves: "GLM 5.3 · 1.3M context",
      fallback: "z-ai/glm-4.7",
    },
    {
      tier: "light",
      route: "z-ai/glm-flash-latest",
      resolves: "GLM 5.3 Flash",
      fallback: null,
    },
    {
      tier: "embed",
      route: "Voyage AI, direct",
      resolves: "voyage-4, voyage-code-3, voyage-context-3",
      fallback: null,
    },
    {
      tier: "rerank",
      route: "Voyage AI",
      resolves: "rerank-2.5",
      fallback: null,
    },
  ],
} as const;

/** pOrganization() plane tab. */
export const DATA_PLANE_ROWS = [
  {
    store: "postgres",
    isolation: "partitioned by org_id · row-level policies enforced",
  },
  { store: "neo4j", isolation: "one database per organization · acme" },
  {
    store: "objects",
    isolation:
      "object lock, compliance mode · per-organization key-encryption key",
  },
] as const;
