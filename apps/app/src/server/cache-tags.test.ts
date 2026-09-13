import { describe, expect, it } from "vitest";
import { tags } from "./cache-tags";
import { CacheTagScopeError } from "./errors";
import { ORG_ONLY_WS, type Scope } from "./tenant-scope";

const acme: Scope = {
  orgId: "6f1d2c3a-0000-4000-8000-00000000ac01",
  workspaceId: "6f1d2c3a-0000-4000-8000-00000000c001",
};
const globex: Scope = {
  orgId: "7a2e3d4b-0000-4000-8000-00000000610b",
  workspaceId: "7a2e3d4b-0000-4000-8000-00000000c002",
};
const acmeOrgOnly: Scope = { orgId: acme.orgId, workspaceId: ORG_ONLY_WS };

const workspaceTags = [
  "runs",
  "approvals",
  "agents",
  "tools",
  "ontology",
  "steering",
  "spend",
  "budgets",
] as const;
const orgTags = [
  "organization",
  "members",
  "workspaces",
  "roles",
  "apiKeys",
  "billing",
  "audit",
] as const;

describe("cache tags", () => {
  it("builds stable, tenant-qualified strings", () => {
    expect(tags.tools(acme)).toBe(`ws:${acme.workspaceId}:tools`);
    expect(tags.run(acme, "arun_01K5RS")).toBe(
      `ws:${acme.workspaceId}:run:arun_01K5RS`,
    );
    expect(tags.agent(acme, "acme.core.release-manager")).toBe(
      `ws:${acme.workspaceId}:agent:acme.core.release-manager`,
    );
    expect(tags.apiKeys(acme)).toBe(`org:${acme.orgId}:api-keys`);
    expect(tags.notifications("usr_marcusbell")).toBe(
      "user:usr_marcusbell:notifications",
    );
  });

  it("never gives two tenants the same tag", () => {
    const all = [
      ...workspaceTags.map((n) => tags[n](acme)),
      ...workspaceTags.map((n) => tags[n](globex)),
      ...orgTags.map((n) => tags[n](acme)),
      ...orgTags.map((n) => tags[n](globex)),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("gives an organization tag from a workspace scope and an org-only scope the same value", () => {
    for (const n of orgTags) expect(tags[n](acme)).toBe(tags[n](acmeOrgOnly));
  });

  it.each(workspaceTags)(
    "refuses workspace tag %s for the organization-only sentinel",
    (name) => {
      expect(() => tags[name](acmeOrgOnly)).toThrow(CacheTagScopeError);
    },
  );

  it("refuses ids that are empty or carry the separator", () => {
    expect(() => tags.tools({ ...acme, workspaceId: "" })).toThrow(
      CacheTagScopeError,
    );
    expect(() => tags.billing({ ...acme, orgId: "a:b" })).toThrow(
      CacheTagScopeError,
    );
    expect(() => tags.run(acme, "arun_1:tools")).toThrow(CacheTagScopeError);
    expect(() => tags.notifications("")).toThrow(CacheTagScopeError);
  });

  it("refuses a tag longer than Next accepts", () => {
    expect(() => tags.run(acme, "a".repeat(300))).toThrow(/256/);
  });
});
