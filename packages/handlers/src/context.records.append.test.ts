import { describe, expect, it } from "vitest";
import { contextRecordsAppend } from "@oxagen/oxagen/contracts/context.records.append";
import { createAppendRecordHandler } from "./context.records.append";
import { AUTHOR, ctx, harness } from "./context.steering.test-support";

const input = (over: Record<string, unknown> = {}) =>
  contextRecordsAppend.input.parse({
    kind: "observation",
    lineageId: "ctx.platform.safari-e2e-flake",
    statement: "The checkout suite flaked on Safari through August.",
    sourceRefs: ["frame:run_01K5RH3G8K5PAS7D/12"],
    ...over,
  });

describe("append_record", () => {
  it("refuses a directive with directive_requires_context_pr and stores nothing", async () => {
    const h = harness();
    await expect(
      createAppendRecordHandler(h)(input({ kind: "directive" }), ctx()),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "directive_requires_context_pr",
    });
    expect(h.store.appends).toHaveLength(0);
  });

  it("appends a content-addressed record and answers the same record on a repeat", async () => {
    const h = harness();
    const handler = createAppendRecordHandler(h);
    const first = await handler(input(), ctx());
    expect(first.appended).toBe(true);
    expect(first.recordHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.proposalId).toBeNull();
    const again = await handler(
      input(),
      ctx({ userId: null, apiKeyId: "key_2" }),
    );
    expect(again).toEqual({ ...first, appended: false });
    expect(h.store.appends).toHaveLength(1);
    expect(h.store.appends[0]?.createdByUserId).toBe(AUTHOR);
    const changed = await handler(
      input({ statement: "It stopped flaking in September." }),
      ctx(),
    );
    expect(changed.recordHash).not.toBe(first.recordHash);
    expect(h.store.appends).toHaveLength(2);
  });

  it("opens a proposal for a record_proposal and refuses one without its fields", async () => {
    const h = harness();
    const handler = createAppendRecordHandler(h);
    await expect(
      handler(input({ kind: "record_proposal" }), ctx()),
    ).rejects.toMatchObject({
      reason: "proposal_fields_required",
    });
    const out = await handler(
      input({
        kind: "record_proposal",
        lineageId: "ctx.triage.reproduce-first",
        statement: "Reproduce before labelling.",
        proposal: {
          kind: "rule",
          force: "should",
          rationale: "14 unsatisfied runs in 30 days.",
        },
      }),
      ctx({ userId: null, apiKeyId: "key_agent" }),
    );
    expect(out.kind).toBe("record_proposal");
    expect(out.proposalId).toMatch(/^prp_/);
    const proposal = h.store.proposals[0]!;
    expect(proposal).toMatchObject({
      lineageId: "ctx.triage.reproduce-first",
      kind: "rule",
      force: "should",
      constraintEffect: null,
      status: "proposed",
      source: "api_key:key_agent",
    });
    expect(h.store.appends[0]?.proposalId).toBe(proposal.id);
    // A repeat of the same proposal reads the first proposal back, never a second.
    const repeat = await handler(
      input({
        kind: "record_proposal",
        lineageId: "ctx.triage.reproduce-first",
        statement: "Reproduce before labelling.",
        proposal: {
          kind: "rule",
          force: "should",
          rationale: "14 unsatisfied runs in 30 days.",
        },
      }),
      ctx(),
    );
    expect(repeat.appended).toBe(false);
    expect(repeat.proposalId).toBe(out.proposalId);
    expect(h.store.proposals).toHaveLength(1);
  });

  it("refuses proposal fields on any other kind, and a constraint without an effect", async () => {
    const h = harness();
    const handler = createAppendRecordHandler(h);
    await expect(
      handler(
        input({ proposal: { kind: "rule", force: "must", rationale: "x" } }),
        ctx(),
      ),
    ).rejects.toMatchObject({ reason: "proposal_fields_refused" });
    await expect(
      handler(
        input({
          kind: "record_proposal",
          proposal: { kind: "constraint", force: "must", rationale: "x" },
        }),
        ctx(),
      ),
    ).rejects.toMatchObject({ reason: "constraint_effect_mismatch" });
    expect(h.store.proposals).toHaveLength(0);
    expect(h.store.appends).toHaveLength(0);
  });
});
