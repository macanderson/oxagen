// toApprovalItems over sample list_approvals outputs: the chain's agent key
// lifted onto the item, and a null run, agent or requester kept null.
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
    });
    expect(z.array(ApprovalItem).safeParse(items).success).toBe(true);
  });
});
