import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { agentList, agentListItem } from "./agent.list";

const item = {
  id: "agt_0123456789abcdefghjkmn",
  slug: "release-bot",
  name: "Release bot",
  description: "Cuts releases and opens their pull requests.",
  agentKey: "acme.core.release-bot",
  harness: "stella",
  principalId: "prn_0123456789abcdefghjkmn",
  operatorId: "usr_0123456789abcdefghjkmn",
  operatorName: "Marcus Bell",
  status: "enrolled",
  tier: null,
  enforcementTier: null,
  beltSize: null,
  runs30d: 12,
  spend30d: { micros: "1250000", currency: "USD", basis: "client_attested" },
  tokens30d: null,
  proven30d: null,
  mandates: null,
  incidents: 1,
  tamperIncidents: 0,
  tamperIncidentsRecorded: 0,
  credentials: 1,
  hosts: 2,
  host: null,
  registeredAt: "2026-09-13T10:00:00.000Z",
};

describe("list_agents contract", () => {
  it("is a console read: scoped, non-mutating, unmetered, Owner/Admin/Member and workspace Owner/Member", () => {
    expect(getCapability("list_agents")).toBe(agentList);
    expect(agentList.scoped).toBe(true);
    expect(agentList.mutates).toBe(false);
    expect(agentList.noBillingGate).toBe(true);
    expect(agentList.defaultEffect).toBe("deny");
    expect(agentList.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow", Member: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
    expect(agentList.surfaces).toEqual(["api", "mcp"]);
    expect(agentList.layers).not.toContain("e2e");
  });

  it("defaults the page size, accepts a cursor, and refuses the rest", () => {
    expect(agentList.input.parse({})).toEqual({ limit: 50 });
    expect(agentList.input.parse({ limit: 5, cursor: "c" })).toEqual({
      limit: 5,
      cursor: "c",
    });
    expect(agentList.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(agentList.input.safeParse({ limit: 101 }).success).toBe(false);
    expect(agentList.input.safeParse({ status: "enrolled" }).success).toBe(
      false,
    );
  });

  it("carries a row with every unrecorded figure null and a priced spend with its basis", () => {
    const parsed = agentListItem.parse(item);
    expect(parsed.tier).toBeNull();
    expect(parsed.beltSize).toBeNull();
    expect(parsed.proven30d).toBeNull();
    expect(parsed.mandates).toBeNull();
    expect(parsed.tokens30d).toBeNull();
    expect(parsed.spend30d).toEqual(item.spend30d);
  });

  it("carries the wrapped-session token rollup and refuses a cache rate above one", () => {
    const tokens30d = {
      total: 1_200_000,
      input: 1_000_000,
      cacheRead: 640_000,
      cacheReadRate: 0.64,
      sessions: 9,
    };
    expect(agentListItem.parse({ ...item, tokens30d }).tokens30d).toEqual(
      tokens30d,
    );
    expect(
      agentListItem.safeParse({
        ...item,
        tokens30d: { ...tokens30d, cacheReadRate: 1.2 },
      }).success,
    ).toBe(false);
    expect(
      agentListItem.safeParse({
        ...item,
        tokens30d: { ...tokens30d, cacheReadRate: null },
      }).success,
    ).toBe(true);
  });

  it("carries the recorded enforcement tier, the mandate count and the live host, and refuses a tier off the ladder", () => {
    const parsed = agentListItem.parse({
      ...item,
      enforcementTier: "gateway",
      mandates: 2,
      tamperIncidents: 1,
      host: "build-01",
    });
    expect(parsed.enforcementTier).toBe("gateway");
    expect(parsed.mandates).toBe(2);
    expect(parsed.tamperIncidents).toBe(1);
    expect(parsed.host).toBe("build-01");
    expect(
      agentListItem.safeParse({ ...item, enforcementTier: "enforced" }).success,
    ).toBe(false);
    expect(
      agentListItem.safeParse({ ...item, tamperIncidents: -1 }).success,
    ).toBe(false);
  });

  it("refuses a spend without a basis and a spend as a float", () => {
    expect(
      agentListItem.safeParse({
        ...item,
        spend30d: { micros: "1250000", currency: "USD" },
      }).success,
    ).toBe(false);
    expect(
      agentListItem.safeParse({
        ...item,
        spend30d: { micros: "1.25", currency: "USD", basis: "client_attested" },
      }).success,
    ).toBe(false);
  });

  it("refuses an id outside the agt_ prefix and a status outside the four", () => {
    expect(agentListItem.safeParse({ ...item, id: "agent-1" }).success).toBe(
      false,
    );
    expect(agentListItem.safeParse({ ...item, status: "active" }).success).toBe(
      false,
    );
  });

  it("answers with items, a cursor and the workspace tiles, holdingMandate null", () => {
    const out = agentList.output.parse({
      items: [item],
      nextCursor: null,
      totals: {
        identities: 3,
        enrolled: 1,
        unenrolled: 2,
        holdingMandate: null,
        mandateHolders: [],
        tamperIncidents: 0,
        tamper: { recorded: 0, open: 0, newest: null },
      },
    });
    expect(out.totals.holdingMandate).toBeNull();
    const newest = {
      agentKey: "acme.core.release-bot",
      kind: "hooks_removed",
      detectedAt: "2026-09-11T09:16:04.000Z",
    };
    expect(
      agentList.output.parse({
        items: [item],
        nextCursor: null,
        totals: {
          identities: 3,
          enrolled: 1,
          unenrolled: 2,
          holdingMandate: 1,
          mandateHolders: ["acme.core.release-bot"],
          tamperIncidents: 1,
          tamper: { recorded: 2, open: 1, newest },
        },
      }).totals.tamper.newest,
    ).toEqual(newest);
    expect(
      agentList.output.safeParse({
        items: [item],
        nextCursor: null,
        totals: {
          identities: 3,
          enrolled: 1,
          tamperIncidents: 0,
          tamper: { recorded: 0, open: 0, newest: null },
        },
      }).success,
    ).toBe(false);
  });
});
