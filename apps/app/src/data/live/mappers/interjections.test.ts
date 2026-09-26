// toInterjectionItems over sample list_interjections outputs (#3839): the
// question, its run and its window carried through, a null agent kept null,
// and the answer fields of the contract left behind.
import type { agentInterjectionList } from "@oxagen/oxagen/contracts/agent.interjection.list";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InterjectionItem } from "@/data/contracts/interjections";
import type { ContractOutput } from "@/server/kernel";
import { toInterjectionItems } from "./interjections";

type Item = ContractOutput<typeof agentInterjectionList>["items"][number];

const open: Item = {
  id: "inj_q8t1",
  runId: "tse_7k2m9q",
  agentKey: "acme.core.release-bot",
  question: "Which branch should the release cut from?",
  raisedAt: "2026-09-25T09:00:00.000Z",
  expiresAt: "2026-09-25T09:30:00.000Z",
  answeredAt: null,
  answer: null,
  answeredBy: null,
};

describe("toInterjectionItems", () => {
  it("carries the question, its run, its agent and its window", () => {
    expect(toInterjectionItems({ items: [open], nextCursor: null })).toEqual([
      {
        id: "inj_q8t1",
        runId: "tse_7k2m9q",
        agentKey: "acme.core.release-bot",
        question: "Which branch should the release cut from?",
        raisedAt: "2026-09-25T09:00:00.000Z",
        expiresAt: "2026-09-25T09:30:00.000Z",
      },
    ]);
  });

  it("keeps a null agent null and parses through the view", () => {
    const items = toInterjectionItems({
      items: [{ ...open, agentKey: null }],
      nextCursor: null,
    });
    expect(items[0]?.agentKey).toBeNull();
    expect(z.array(InterjectionItem).parse(items)).toEqual(items);
  });

  it("leaves the answer fields behind: the port reads open questions (negative)", () => {
    const [item] = toInterjectionItems({
      items: [
        {
          ...open,
          answeredAt: "2026-09-25T09:04:00.000Z",
          answer: "main",
          answeredBy: "usr_marcusbell",
        },
      ],
      nextCursor: null,
    });
    expect(item).not.toHaveProperty("answer");
    expect(item).not.toHaveProperty("answeredBy");
  });

  it("maps an empty page to an empty list", () => {
    expect(toInterjectionItems({ items: [], nextCursor: null })).toEqual([]);
  });
});
