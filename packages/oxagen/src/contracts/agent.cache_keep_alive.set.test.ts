import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { agentCacheKeepAliveSet } from "./agent.cache_keep_alive.set";

describe("set_agent_cache_keep_alive contract", () => {
  it("is a workspace-scoped settings write: mutates, unmetered, Owner/Admin", () => {
    expect(getCapability("set_agent_cache_keep_alive")).toBe(
      agentCacheKeepAliveSet,
    );
    expect(agentCacheKeepAliveSet.scoped).toBe(true);
    expect(agentCacheKeepAliveSet.mutates).toBe(true);
    expect(agentCacheKeepAliveSet.noBillingGate).toBe(true);
    expect(agentCacheKeepAliveSet.surfaces).toEqual(["api", "mcp"]);
    expect(agentCacheKeepAliveSet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("names the agent by slug and takes the setting as a boolean", () => {
    expect(
      agentCacheKeepAliveSet.input.parse({
        agent: "release-bot",
        cacheKeepAlive: false,
      }),
    ).toEqual({ agent: "release-bot", cacheKeepAlive: false });
    expect(
      agentCacheKeepAliveSet.input.safeParse({ agent: "release-bot" }).success,
    ).toBe(false);
    expect(
      agentCacheKeepAliveSet.input.safeParse({
        agent: "",
        cacheKeepAlive: true,
      }).success,
    ).toBe(false);
    expect(
      agentCacheKeepAliveSet.input.safeParse({
        agent: "release-bot",
        cacheKeepAlive: "off",
      }).success,
    ).toBe(false);
  });

  it("refuses a field the contract does not name (negative)", () => {
    expect(
      agentCacheKeepAliveSet.input.safeParse({
        agent: "release-bot",
        cacheKeepAlive: true,
        workspaceId: "wrk_1",
      }).success,
    ).toBe(false);
  });

  it("answers with the agent's public id and the setting it now holds", () => {
    const out = agentCacheKeepAliveSet.output.parse({
      agentId: "agt_0123456789abcdefghjkmn",
      cacheKeepAlive: false,
    });
    expect(out).toEqual({
      agentId: "agt_0123456789abcdefghjkmn",
      cacheKeepAlive: false,
    });
    expect(
      agentCacheKeepAliveSet.output.safeParse({
        agentId: "release-bot",
        cacheKeepAlive: false,
      }).success,
    ).toBe(false);
  });
});
