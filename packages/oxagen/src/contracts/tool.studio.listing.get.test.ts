/**
 * Contract test for get_studio_listing (ADR-233, #4756).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { studioListingSchema, toolStudioListingGet } from "./tool.studio.listing.get";

const WAITING = {
  server: "files",
  status: "waiting_for_machine",
  machineGroups: ["dev-laptops"],
  pin: {
    name: "files-mcp",
    version: "1.4.0",
    digest: `sha256:${"a1".repeat(32)}`,
    registryType: null,
  },
  draftRevision: 3,
  requestedAt: "2026-09-30T10:00:00.000Z",
  requestedBy: "0192d4a8-7c1e-7a00-8000-0000000005e1",
  claimedAt: null,
  finishedAt: null,
  machine: null,
  toolCount: null,
  error: null,
} as const;

describe("get_studio_listing is registered as declared", () => {
  it("is a scoped read that skips the billing gate", () => {
    const cap = getCapability("get_studio_listing");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(false);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
  });

  it("admits the roles that save a draft", () => {
    expect(getCapability("get_studio_listing")?.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
  });
});

describe("get_studio_listing", () => {
  it("takes a server name and refuses anything else", () => {
    expect(toolStudioListingGet.input.parse({ server: "files" })).toEqual({ server: "files" });
    expect(toolStudioListingGet.input.safeParse({ server: "Files" }).success).toBe(false);
    expect(toolStudioListingGet.input.safeParse({ server: "files", extra: 1 }).success).toBe(false);
  });

  it("answers a listing, or null when the draft has none", () => {
    expect(toolStudioListingGet.output.parse({ listing: WAITING }).listing?.status).toBe(
      "waiting_for_machine",
    );
    expect(toolStudioListingGet.output.parse({ listing: null })).toEqual({ listing: null });
  });

  it("carries a succeeded listing's machine and tool count, and a registry package's type", () => {
    const done = studioListingSchema.parse({
      ...WAITING,
      status: "succeeded",
      pin: { ...WAITING.pin, name: "@acme/files-mcp", registryType: "npm" },
      claimedAt: "2026-09-30T10:00:05.000Z",
      finishedAt: "2026-09-30T10:00:09.000Z",
      machine: "tch_laptop01",
      toolCount: 4,
    });
    expect(done).toMatchObject({ machine: "tch_laptop01", toolCount: 4, pin: { registryType: "npm" } });
  });

  it("refuses a status the listing never takes (negative)", () => {
    expect(studioListingSchema.safeParse({ ...WAITING, status: "queued" }).success).toBe(false);
  });
});
