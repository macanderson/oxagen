import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { runtimeList, runtimeListItem } from "./runtime.list";

const item = {
  id: "rtm_0123456789abcdefghjkmn",
  name: "Mac's laptop",
  slug: "macs-laptop",
  createdAt: "2026-09-25T12:00:00.000Z",
  agents: [
    {
      id: "agt_0123456789abcdefghjkmn",
      name: "Mac's Claude Code",
      slug: "macs-claude-code",
      harness: "claude-code",
    },
  ],
  liveHosts: 1,
  lastSeenAt: null,
};

describe("list_runtimes contract", () => {
  it("is a console read on api and mcp that workspace members can make", () => {
    expect(getCapability("list_runtimes")).toBe(runtimeList);
    expect(runtimeList.mutates).toBe(false);
    expect(runtimeList.noBillingGate).toBe(true);
    expect(runtimeList.surfaces).toEqual(["api", "mcp"]);
    expect(runtimeList.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    });
  });

  it("takes no input", () => {
    expect(runtimeList.input.parse({})).toEqual({});
    expect(runtimeList.input.safeParse({ limit: 5 }).success).toBe(false);
  });

  it("carries each runtime's live agents with their harness", () => {
    expect(runtimeListItem.parse(item)).toEqual(item);
    expect(
      runtimeListItem.safeParse({
        ...item,
        agents: [{ ...item.agents[0], harness: "langchain" }],
      }).success,
    ).toBe(false);
  });
});
