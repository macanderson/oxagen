// feedback.test.ts: agent feedback for get_studio_server (#4678, part 4;
// ADR-234). feedbackOf is pure. The live reader's ClickHouse read and its
// Postgres read are doubles, so these cases check what each hands back and
// how a ClickHouse failure reads.
import { beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => ({
  readServedToolFeedback: vi.fn(),
  rows: [] as Array<{ toolFeedback: unknown }>,
  limit: vi.fn(),
}));

vi.mock("@oxagen/telemetry", () => ({
  readServedToolFeedback: stores.readServedToolFeedback,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (n: number) => {
      stores.limit(n);
      return Promise.resolve(stores.rows);
    },
  };
  return {
    ...real,
    withTenantDb: (fn: (tx: unknown) => unknown) => fn({ select: () => chain }),
  };
});

import {
  FEEDBACK_WINDOW_DAYS,
  feedbackOf,
  liveToolFeedbackReader,
  NOTES_PER_TOOL,
  REFLECTIONS_READ,
} from "./feedback";

const SCOPE = { orgId: "org_1", workspaceId: "ws_1" };

beforeEach(() => {
  stores.readServedToolFeedback.mockReset();
  stores.limit.mockReset();
  stores.rows = [];
});

describe("feedbackOf", () => {
  const counts = [
    { tool: "billing__create_refund", calls: 7, schemaRejections: 2, errorResults: 1, retries: 3 },
    { tool: "stripe__create_refund", calls: 99, schemaRejections: 9, errorResults: 9, retries: 9 },
  ];

  it("gives each key its own server's counts and zeros for a key with no calls", () => {
    expect(feedbackOf("billing", ["create_refund", "list_charges"], counts, [])).toEqual({
      windowDays: FEEDBACK_WINDOW_DAYS,
      tools: [
        {
          tool: "create_refund",
          counts: { calls: 7, schemaRejections: 2, errorResults: 1, retries: 3 },
          notes: [],
        },
        {
          tool: "list_charges",
          counts: { calls: 0, schemaRejections: 0, errorResults: 0, retries: 0 },
          notes: [],
        },
      ],
    });
  });

  it("reads null counts for every key when the call store did not answer", () => {
    const feedback = feedbackOf("billing", ["create_refund"], null, []);
    expect(feedback.tools).toEqual([{ tool: "create_refund", counts: null, notes: [] }]);
  });

  it("keeps each key's notes newest first, drops repeats, and stops at the cap", () => {
    const notes = [
      { tool: "billing__create_refund", problem: "Sent dollars, not cents." },
      { tool: "billing__create_refund", problem: "Sent dollars, not cents." },
      { tool: "stripe__create_refund", problem: "Another server's tool." },
      ...Array.from({ length: NOTES_PER_TOOL + 2 }, (_, i) => ({
        tool: "billing__create_refund",
        problem: `Problem ${i}.`,
      })),
    ];
    const [tool] = feedbackOf("billing", ["create_refund"], counts, notes).tools;
    expect(tool?.notes).toHaveLength(NOTES_PER_TOOL);
    expect(tool?.notes[0]).toBe("Sent dollars, not cents.");
    expect(tool?.notes).not.toContain("Another server's tool.");
  });
});

describe("liveToolFeedbackReader", () => {
  it("reads one server's counts over the window", async () => {
    const rows = [{ tool: "billing__create_refund", calls: 1, schemaRejections: 0, errorResults: 0, retries: 0 }];
    stores.readServedToolFeedback.mockResolvedValue(rows);
    await expect(liveToolFeedbackReader.counts(SCOPE, "billing", 30)).resolves.toEqual(rows);
    expect(stores.readServedToolFeedback).toHaveBeenCalledWith({ server: "billing", windowDays: 30 });
  });

  it("answers null counts when ClickHouse does not answer", async () => {
    stores.readServedToolFeedback.mockRejectedValue(new Error("clickhouse is down"));
    await expect(liveToolFeedbackReader.counts(SCOPE, "billing", 30)).resolves.toBeNull();
  });

  it("reads each reflection's well-formed notes, newest first, from a bounded read", async () => {
    stores.rows = [
      { toolFeedback: [{ tool: "billing__create_refund", problem: "Sent dollars." }] },
      { toolFeedback: [{ tool: "billing__list_charges" }, "not an entry", { tool: 3, problem: "x" }] },
      { toolFeedback: { tool: "billing__create_refund", problem: "Not a list." } },
      { toolFeedback: [{ tool: "billing__list_charges", problem: "Limit too low." }] },
    ];
    await expect(liveToolFeedbackReader.notes(SCOPE, 30)).resolves.toEqual([
      { tool: "billing__create_refund", problem: "Sent dollars." },
      { tool: "billing__list_charges", problem: "Limit too low." },
    ]);
    expect(stores.limit).toHaveBeenCalledWith(REFLECTIONS_READ);
  });
});
