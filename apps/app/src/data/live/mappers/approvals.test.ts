// toApprovalItems over sample list_approvals outputs: both chain hops lifted
// onto the item, the mandate the parked call drew on and the recorded
// auto-approval evaluation carried through, and a null run, agent, requester,
// mandate, rule or evaluation kept null.
import type { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalItem } from "@/data/contracts/approvals";
import type { ContractOutput } from "@/server/kernel";
import { toApprovalItems } from "./approvals";

type Item = ContractOutput<typeof agentApprovalList>["items"][number];

const parked: Item = {
  id: "apr_q8t1",
  runId: "arun_7k2m9q",
  tool: "create_release",
  requester: "usr_marcusbell",
  createdAt: "2026-09-15T08:57:30.000Z",
  expiresAt: "2026-09-15T09:07:30.000Z",
  // Parked by the approval rule, not by a mandate: `list_approvals` carries
  // the mandate that parked the call, and null is the common case.
  mandateId: null,
  // No auto-approval rule covered the call, so nothing was recorded for the
  // eligibility line (ADR-070).
  autoEligibility: null,
  chain: { agentKey: "acme.core.release-bot", rule: "rule_release" },
};

describe("toApprovalItems", () => {
  it("carries the approval's ids, tool, requester, instants and the chain's agent key", () => {
    const items = toApprovalItems({ items: [parked], nextCursor: null });
    expect(items).toEqual([
      {
        id: "apr_q8t1",
        runId: "arun_7k2m9q",
        tool: "create_release",
        agentKey: "acme.core.release-bot",
        requester: "usr_marcusbell",
        mandateId: null,
        rule: "rule_release",
        autoEligibility: null,
        createdAt: "2026-09-15T08:57:30.000Z",
        expiresAt: "2026-09-15T09:07:30.000Z",
      },
    ]);
    expect(z.array(ApprovalItem).safeParse(items).success).toBe(true);
  });

  it("keeps a run, agent and requester the store did not record null", () => {
    const items = toApprovalItems({
      items: [
        {
          ...parked,
          runId: null,
          requester: null,
          chain: { agentKey: null, rule: null },
        },
      ],
      nextCursor: "c2",
    });
    expect(items[0]).toMatchObject({
      runId: null,
      agentKey: null,
      requester: null,
      mandateId: null,
      rule: null,
      autoEligibility: null,
    });
    expect(z.array(ApprovalItem).safeParse(items).success).toBe(true);
  });
});

describe("the mandate hop", () => {
  it("carries the mandate a parked call drew on", () => {
    const items = toApprovalItems({
      items: [{ ...parked, mandateId: "mnd_4f2a9c" }],
      nextCursor: null,
    });
    expect(items[0]?.mandateId).toBe("mnd_4f2a9c");
    expect(z.array(ApprovalItem).safeParse(items).success).toBe(true);
  });
});

// The fourth hop of the chain and the line under it. Both were recorded on the
// row and dropped here, so every card drew three hops and said nothing about
// what the auto-approval clause decided.
describe("the rule hop and the recorded evaluation", () => {
  it("carries the rule that parked the call and what the clause said about it", () => {
    const items = toApprovalItems({
      items: [
        {
          ...parked,
          mandateId: "mnd_4f2a9c",
          chain: {
            agentKey: null,
            rule: "mandate:mnd_4f2a9c:human_above:amount",
          },
          autoEligibility: {
            ruleId: "small-vendor-payments",
            ok: false,
            reasons: ["measure_above_ceiling:amount", "tainted_input"],
            floor: true,
          },
        },
      ],
      nextCursor: null,
    });
    expect(items[0]).toMatchObject({
      rule: "mandate:mnd_4f2a9c:human_above:amount",
      autoEligibility: {
        ruleRef: "small-vendor-payments",
        ok: false,
        reasons: ["measure_above_ceiling:amount", "tainted_input"],
        floor: true,
      },
    });
    expect(z.array(ApprovalItem).safeParse(items).success).toBe(true);
  });

  // §6.9 part 3: a mandate's own approval rule outranks any workspace rule, so
  // an `ok` evaluation on a parked call is a legitimate record, not a bug.
  it("carries an evaluation that qualified on a call a mandate parked anyway", () => {
    const items = toApprovalItems({
      items: [
        {
          ...parked,
          autoEligibility: {
            ruleId: "small-vendor-payments",
            ok: true,
            reasons: [],
            floor: false,
          },
        },
      ],
      nextCursor: null,
    });
    expect(items[0]?.autoEligibility).toMatchObject({ ok: true, reasons: [] });
    expect(z.array(ApprovalItem).safeParse(items).success).toBe(true);
  });
});
