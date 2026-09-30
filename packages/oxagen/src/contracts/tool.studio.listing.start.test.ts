/**
 * Contract test for start_studio_listing (ADR-233, #4756).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolStudioListingStart } from "./tool.studio.listing.start";

const DIGEST = `sha256:${"b2".repeat(32)}`;

const WAITING = {
  server: "files",
  status: "waiting_for_machine",
  machineGroups: ["dev-laptops"],
  pin: { name: "files-mcp", version: "1.4.0", digest: DIGEST, registryType: null },
  draftRevision: 3,
  requestedAt: "2026-09-30T10:00:00.000Z",
  requestedBy: null,
  claimedAt: null,
  finishedAt: null,
  machine: null,
  toolCount: null,
  error: null,
  tools: null,
} as const;

describe("start_studio_listing is registered as declared", () => {
  it("is a scoped, audited write that skips the billing gate", () => {
    const cap = getCapability("start_studio_listing");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(true);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.audit).toEqual({ targetKind: "tool_server_folder", targetIdField: "server" });
  });

  it("starts a program on a machine before review, so it is high sensitivity and an agent asks first", () => {
    const cap = getCapability("start_studio_listing");
    expect(cap?.sensitivity).toBe("high");
    expect(cap?.agent?.requiresApproval).toBe(true);
    expect(cap?.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
  });
});

describe("start_studio_listing", () => {
  it("takes the draft revision, and a pin for a local command", () => {
    expect(
      toolStudioListingStart.input.parse({ server: "files", revision: 3, pin: { version: "1.4.0", digest: DIGEST } }),
    ).toEqual({ server: "files", revision: 3, pin: { version: "1.4.0", digest: DIGEST } });
    expect(toolStudioListingStart.input.parse({ server: "files", revision: 3 })).toEqual({
      server: "files",
      revision: 3,
    });
  });

  it("refuses a revision below 1 and a digest that is not sha256:<hex> (negative)", () => {
    expect(toolStudioListingStart.input.safeParse({ server: "files", revision: 0 }).success).toBe(false);
    expect(
      toolStudioListingStart.input.safeParse({
        server: "files",
        revision: 3,
        pin: { version: "1.4.0", digest: "b2".repeat(32) },
      }).success,
    ).toBe(false);
    expect(
      toolStudioListingStart.input.safeParse({
        server: "files",
        revision: 3,
        pin: { version: "1.4.0", digest: DIGEST, name: "files-mcp" },
      }).success,
    ).toBe(false);
  });

  it("answers the listing it recorded", () => {
    expect(toolStudioListingStart.output.parse({ listing: WAITING }).listing.status).toBe("waiting_for_machine");
  });
});
