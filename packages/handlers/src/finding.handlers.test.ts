/**
 * Unit tests for the finding handlers: list_findings, get_finding_evidence,
 * record_finding_fix and dismiss_finding.
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so a refusal below comes from the handler alone. The role
 * gate runs for real against a tx double that answers the principal and
 * role-assignment tables; the finding reads and the decision write are
 * injected, so a test states the rows and asserts what the caller is told.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingEvidence as StoredEvidence } from "@oxagen/billing";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { createFindingDismissHandler } from "./finding.dismiss";
import { createFindingEvidenceHandler } from "./finding.evidence.get";
import { createFindingFixRecordHandler } from "./finding.fix.record";
import { createFindingListHandler } from "./finding.list";
import type { FindingDecisionDeps, FindingRow } from "./finding.shared";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const FINDING_ID = "fnd_0123456789abcdefghjkmn";
const DAY_MS = 86_400_000;
const START = new Date("2026-08-16T00:00:00.000Z");
const END = new Date(START.getTime() + 30 * DAY_MS);

const ctx = () =>
  makeCTX({
    orgId: ORG,
    workspaceId: WS,
    userId: USER,
    requestId: "req_apply_1",
  });

/** Answers the role gate by the table asked for, so query order does not matter. */
function stubRole(roleName: string | null) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.apiKeys) return [{ createdByUserId: USER }];
    if (table === schema.principals) return [{ id: "prn_1" }];
    if (table === schema.principalRoleAssignments)
      return roleName ? [{ roleName }] : [];
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

function evidence(over: Partial<StoredEvidence> = {}): StoredEvidence {
  return {
    calls: 4,
    coveredCalls: 4,
    measuredTokens: 20_000,
    counterfactualTokens: 0,
    measuredMicros: "60000",
    counterfactualMicros: "0",
    operatorKeys: ["prn_aaaaaaaaaaaaaaaaaaaaaa"],
    runs: [
      {
        runId: "tse_0000000000000000000001",
        startedAt: "2026-09-10T12:00:00.000Z",
        calls: 4,
        measuredTokens: 20_000,
        counterfactualTokens: 0,
        measuredMicros: "60000",
        counterfactualMicros: "0",
      },
    ],
    ...over,
  };
}

function findingRow(over: Partial<FindingRow> = {}): FindingRow {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000f0001",
    publicId: FINDING_ID,
    orgId: ORG,
    workspaceId: WS,
    kind: "repeated_shell_commands",
    level: "tool",
    subject: "Bash",
    fingerprint: "repeated_shell_commands|tool|Bash",
    windowStart: START,
    windowEnd: END,
    estimatedSavingMicros: 60_000n,
    currency: "USD",
    savingBasis: "gateway_observed",
    confidence: "high",
    why: "4 calls on 1 run re-ran a shell command.",
    fix: "Serve an identical command from the run's earlier result.",
    citedRuns: ["tse_0000000000000000000001"],
    citedFrames: evidence(),
    status: "open",
    detectedAt: END,
    decidedAt: null,
    decidedByUserId: null,
    appliedActionId: null,
    ...over,
  };
}

describe("list_findings", () => {
  it("answers nulls and zero counts, without reading spend, when nothing is listed", async () => {
    const readPricedSpend = vi.fn();
    const handler = createFindingListHandler({
      readFindings: async () => [],
      readPricedSpend,
    });
    const out = await handler({ status: "open" }, ctx());
    expect(out).toEqual({
      status: "open",
      window: null,
      saving: null,
      spend: null,
      share: null,
      annualised: null,
      counts: { findings: 0, high: 0, medium: 0, operators: 0 },
      findings: [],
    });
    expect(readPricedSpend).not.toHaveBeenCalled();
  });

  it("sums the savings with their bases, annualises each over its own window, and divides by the spend over the findings' span", async () => {
    const readFindings = vi.fn(async () => [
      findingRow(),
      findingRow({
        publicId: "fnd_bbbbbbbbbbbbbbbbbbbbbb",
        kind: "unpaged_results",
        subject: "mcp__aws__cost",
        windowStart: new Date(START.getTime() + DAY_MS),
        estimatedSavingMicros: 30_000n,
        savingBasis: "client_attested",
        confidence: "medium",
        citedFrames: evidence({
          operatorKeys: [
            "prn_aaaaaaaaaaaaaaaaaaaaaa",
            "prn_bbbbbbbbbbbbbbbbbbbbbb",
          ],
        }),
      }),
    ]);
    const readPricedSpend = vi.fn(async () => ({
      micros: 900_000n,
      currency: "USD",
      basis: "gateway_observed" as const,
    }));
    const handler = createFindingListHandler({ readFindings, readPricedSpend });
    const out = await handler({ status: "open" }, ctx());

    expect(readFindings).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      "open",
    );
    expect(readPricedSpend).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      { start: START, end: END },
    );
    expect(out.window).toEqual({
      from: START.toISOString(),
      to: END.toISOString(),
    });
    expect(out.saving).toEqual({
      micros: "90000",
      currency: "USD",
      basis: "mixed",
    });
    expect(out.spend).toEqual({
      micros: "900000",
      currency: "USD",
      basis: "gateway_observed",
    });
    // Each finding annualises over its own window: 60,000 micros over 30 days
    // is 730,000 over 365, and 30,000 over 29 days is 377,586.
    expect(out.annualised).toEqual({
      micros: "1107586",
      currency: "USD",
      basis: "mixed",
    });
    // 900,000 micros of spend over the 30-day span is 10,950,000 over 365.
    expect(out.share).toBeCloseTo(1_107_586 / 10_950_000, 12);
    expect(out.counts).toEqual({
      findings: 2,
      high: 1,
      medium: 1,
      operators: 2,
    });
    expect(out.findings.map((f) => f.id)).toEqual([
      FINDING_ID,
      "fnd_bbbbbbbbbbbbbbbbbbbbbb",
    ]);
    expect(out.findings[0]).toMatchObject({
      saving: { micros: "60000", currency: "USD", basis: "gateway_observed" },
      runs: 1,
      calls: 4,
      window: { from: START.toISOString(), to: END.toISOString() },
    });
  });

  it("annualises a finding decided minutes ago over seven days, so its saving does not scale minutes to a year", async () => {
    const fiveMinutes = 5 * 60_000;
    const handler = createFindingListHandler({
      readFindings: async () => [
        findingRow(),
        findingRow({
          publicId: "fnd_bbbbbbbbbbbbbbbbbbbbbb",
          windowStart: new Date(END.getTime() - fiveMinutes),
          estimatedSavingMicros: 10_000n,
        }),
      ],
      readPricedSpend: async () => ({
        micros: 100_000_000n,
        currency: "USD",
        basis: "gateway_observed" as const,
      }),
    });
    const out = await handler({ status: "open" }, ctx());

    // 60,000 micros over 30 days is 730,000 over 365. 10,000 over its own
    // 5 minutes would be 1,051,200,000; over the 7-day minimum it is 521,429.
    expect(out.annualised?.micros).toBe("1251429");
    // The span is 30 days, so the share is 1,251,429 over 1,216,666,667 of
    // annualised spend: within the 30/7 minimum's factor of the plain 70,000
    // over 100,000,000.
    const share = out.share!;
    expect(share).toBeCloseTo((1_251_429 * 30) / (100_000_000 * 365), 12);
    expect(share).toBeLessThan((70_000 / 100_000_000) * (30 / 7));
  });

  it("scales the spend of a span shorter than seven days by the same minimum as the saving", async () => {
    const hour = 3_600_000;
    const handler = createFindingListHandler({
      readFindings: async () => [
        findingRow({
          windowStart: new Date(END.getTime() - hour),
          estimatedSavingMicros: 10_000n,
        }),
      ],
      readPricedSpend: async () => ({
        micros: 50_000n,
        currency: "USD",
        basis: "gateway_observed" as const,
      }),
    });
    const out = await handler({ status: "open" }, ctx());

    // 10,000 over the 7-day minimum is 521,429 a year, and the share is the
    // hour's plain 10,000 over 50,000.
    expect(out.annualised?.micros).toBe("521429");
    expect(out.share).toBeCloseTo(0.2, 6);
  });

  it("answers no share when nothing in the span was priced", async () => {
    const handler = createFindingListHandler({
      readFindings: async () => [findingRow()],
      readPricedSpend: async () => null,
    });
    const out = await handler({ status: "open" }, ctx());
    expect(out.spend).toBeNull();
    expect(out.share).toBeNull();
    expect(out.saving).not.toBeNull();
  });
});

describe("get_finding_evidence", () => {
  it("answers the stored arithmetic as money in the finding's currency", async () => {
    const handler = createFindingEvidenceHandler({
      read: async () => findingRow(),
    });
    const out = await handler({ findingId: FINDING_ID }, ctx());
    expect(out.evidence).toMatchObject({
      calls: 4,
      coveredCalls: 4,
      measured: { micros: "60000", currency: "USD" },
      counterfactual: { micros: "0", currency: "USD" },
    });
    expect(out.evidence.runs[0]).toMatchObject({
      runId: "tse_0000000000000000000001",
      measured: { micros: "60000", currency: "USD" },
    });
  });

  it("refuses an id with no finding in the workspace as not found", async () => {
    const read = vi.fn(async () => null);
    const handler = createFindingEvidenceHandler({ read });
    await expect(
      handler({ findingId: FINDING_ID }, ctx()),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "finding_not_found",
    });
    expect(read).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      FINDING_ID,
    );
  });
});

function decisionDeps(over: Partial<FindingDecisionDeps> = {}) {
  const now = new Date("2026-09-15T09:00:00.000Z");
  return {
    now: () => now,
    decide: vi.fn(async (_s, _id, d) =>
      findingRow({
        status: d.status,
        decidedAt: d.decidedAt,
        decidedByUserId: d.decidedByUserId,
        appliedActionId: d.appliedActionId,
      }),
    ),
    read: vi.fn(async () => findingRow()),
    ...over,
  } satisfies FindingDecisionDeps;
}

describe("record_finding_fix", () => {
  beforeEach(() => {
    mocks.withTenantDb.mockReset();
  });

  it("records the fix as applied with this invocation's request id and the deciding user", async () => {
    stubRole("Owner");
    const deps = decisionDeps();
    const out = await createFindingFixRecordHandler(deps)(
      { findingId: FINDING_ID },
      ctx(),
    );
    expect(deps.decide).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      FINDING_ID,
      {
        status: "applied",
        decidedAt: new Date("2026-09-15T09:00:00.000Z"),
        decidedByUserId: USER,
        appliedActionId: "req_apply_1",
      },
    );
    expect(out.finding).toMatchObject({
      status: "applied",
      appliedActionId: "req_apply_1",
      decidedAt: "2026-09-15T09:00:00.000Z",
    });
  });

  it("records an API-key call as the key's creator and gates on the creator's role", async () => {
    stubRole("Admin");
    const deps = decisionDeps();
    await createFindingFixRecordHandler(deps)(
      { findingId: FINDING_ID },
      makeCTX({
        orgId: ORG,
        workspaceId: WS,
        userId: null,
        apiKeyId: "key_1",
        requestId: "req_apply_1",
      }),
    );
    expect(deps.decide).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      FINDING_ID,
      expect.objectContaining({ decidedByUserId: USER }),
    );
  });

  it("refuses a Member before touching the finding", async () => {
    stubRole("Member");
    const deps = decisionDeps();
    await expect(
      createFindingFixRecordHandler(deps)({ findingId: FINDING_ID }, ctx()),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(deps.decide).not.toHaveBeenCalled();
  });

  it("refuses a call with no signed-in user", async () => {
    const deps = decisionDeps();
    await expect(
      createFindingFixRecordHandler(deps)(
        { findingId: FINDING_ID },
        makeCTX({ orgId: ORG, workspaceId: WS, userId: null }),
      ),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
    expect(deps.decide).not.toHaveBeenCalled();
  });

  it("refuses a finding someone already decided as a conflict", async () => {
    stubRole("Admin");
    const deps = decisionDeps({
      decide: vi.fn(async () => null),
      read: vi.fn(async () => findingRow({ status: "dismissed" })),
    });
    await expect(
      createFindingFixRecordHandler(deps)({ findingId: FINDING_ID }, ctx()),
    ).rejects.toMatchObject({ code: "conflict", reason: "finding_not_open" });
  });

  it("refuses an id with no finding in the workspace as not found", async () => {
    stubRole("Owner");
    const deps = decisionDeps({
      decide: vi.fn(async () => null),
      read: vi.fn(async () => null),
    });
    await expect(
      createFindingFixRecordHandler(deps)({ findingId: FINDING_ID }, ctx()),
    ).rejects.toMatchObject({ code: "not_found", reason: "finding_not_found" });
  });
});

describe("dismiss_finding", () => {
  beforeEach(() => {
    mocks.withTenantDb.mockReset();
  });

  it("dismisses an open finding with no action id", async () => {
    stubRole("Admin");
    const deps = decisionDeps();
    const out = await createFindingDismissHandler(deps)(
      { findingId: FINDING_ID },
      ctx(),
    );
    expect(deps.decide).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      FINDING_ID,
      expect.objectContaining({ status: "dismissed", appliedActionId: null }),
    );
    expect(out.finding).toMatchObject({
      status: "dismissed",
      appliedActionId: null,
    });
  });

  it("refuses a Billing member", async () => {
    stubRole("Billing");
    const deps = decisionDeps();
    await expect(
      createFindingDismissHandler(deps)({ findingId: FINDING_ID }, ctx()),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(deps.decide).not.toHaveBeenCalled();
  });
});
