import { describe, expect, it } from "vitest";
import { steeringSearch } from "./steering.search";

const HIT = {
  lineage: "a-intel.domain.refund",
  label: "Refunds over $100",
  kind: "constraint",
  force: "must",
  always_on: true,
  source: "workspace",
  line: "- Refunds over $100 (a-intel.domain.refund)",
};

describe("search_steering contract", () => {
  it("is a scoped, unmetered read on the mcp surface", () => {
    expect(steeringSearch.name).toBe("search_steering");
    expect(steeringSearch.surfaces).toEqual(["mcp"]);
    expect(steeringSearch.scoped).toBe(true);
    expect(steeringSearch.mutates).toBe(false);
    expect(steeringSearch.noBillingGate).toBe(true);
  });

  it("lets org admins and every workspace role call it, and no one else by default", () => {
    expect(steeringSearch.defaultEffect).toBe("deny");
    expect(steeringSearch.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
    });
  });

  it("takes a query, a kind, a repository, and a limit, each optional", () => {
    expect(steeringSearch.input.parse({})).toEqual({});
    const input = {
      query: "refund",
      kind: "skill",
      repository: "github.com/a-intel/platform",
      limit: 50,
    };
    expect(steeringSearch.input.parse(input)).toEqual(input);
  });

  it("refuses a limit past 50 and a field it does not take", () => {
    expect(steeringSearch.input.safeParse({ limit: 51 }).success).toBe(false);
    expect(steeringSearch.input.safeParse({ scope: "all" }).success).toBe(false);
  });

  it("answers the versions it searched and one line per hit", () => {
    const out = { workspace_version: 21, organization_version: null, total: 1, hits: [HIT] };
    expect(steeringSearch.output.parse(out)).toEqual(out);
  });

  it("answers null versions and no hits before anything publishes", () => {
    const out = { workspace_version: null, organization_version: null, total: 0, hits: [] };
    expect(steeringSearch.output.parse(out)).toEqual(out);
  });
});
