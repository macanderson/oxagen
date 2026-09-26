// list_interjections output to the open questions Fleet's waiting tile and the
// shell's approvals drawer draw (#3839, ARCHITECTURE.md §3.4). Typed from the
// contract's output. The port reads open questions only, so the answer fields
// the contract carries for an answered question do not travel.
import type { agentInterjectionList } from "@oxagen/oxagen/contracts/agent.interjection.list";
import type { z } from "zod";
import type { InterjectionItem } from "@/data/contracts/interjections";
import type { ContractOutput } from "@/server/kernel";

export function toInterjectionItems(
  out: ContractOutput<typeof agentInterjectionList>,
): z.input<typeof InterjectionItem>[] {
  return out.items.map((item) => ({
    id: item.id,
    runId: item.runId,
    agentKey: item.agentKey,
    question: item.question,
    raisedAt: item.raisedAt,
    expiresAt: item.expiresAt,
  }));
}
