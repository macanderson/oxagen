import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { mandateList } from "./mandate.list";
import { mandateRequest } from "./mandate.request";

describe("list_mandates contract", () => {
  it("is a console read: scoped, non-mutating, unmetered, for the accountable office by default", () => {
    expect(getCapability("list_mandates")).toBe(mandateList);
    expect(mandateList.scoped).toBe(true);
    expect(mandateList.mutates).toBe(false);
    expect(mandateList.noBillingGate).toBe(true);
    expect(mandateList.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
    });
    expect(mandateList.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
    });
  });

  // #3138 (ADR-107): whoever may draft a mandate must be able to read the
  // draft they just made, or `readerFilter`'s creator-narrowing branch
  // (`packages/handlers/src/_mandate.ts`) can never run — IAM refuses the
  // call before the handler starts. `list_mandates` admits every role
  // `request_mandate` admits (plus the accountable-office-only roles, which
  // read every mandate rather than only their own).
  it("admits every role request_mandate admits, so a requester can read the draft they just created", () => {
    const org = mandateList.defaultRoles.org;
    const workspace = mandateList.defaultRoles.workspace;
    for (const [role, effect] of Object.entries(
      mandateRequest.defaultRoles.org,
    ) as [keyof typeof org, string][]) {
      expect(org[role]).toBe(effect);
    }
    for (const [role, effect] of Object.entries(
      mandateRequest.defaultRoles.workspace,
    ) as [keyof typeof workspace, string][]) {
      expect(workspace[role]).toBe(effect);
    }
  });

  it("defaults the page size and narrows by agent or status", () => {
    expect(mandateList.input.parse({})).toEqual({ limit: 50 });
    expect(
      mandateList.input.parse({
        agentId: "agt_0123456789abcdefghjkmn",
        status: "active",
        limit: 5,
      }),
    ).toEqual({
      agentId: "agt_0123456789abcdefghjkmn",
      status: "active",
      limit: 5,
    });
    expect(mandateList.input.safeParse({ status: "suspended" }).success).toBe(
      false,
    );
    expect(mandateList.input.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      mandateList.input.safeParse({ agentId: "invoice-bot" }).success,
    ).toBe(false);
  });
});
