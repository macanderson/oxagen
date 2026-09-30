/**
 * Contract test for get_studio_discovery (lane M10, #4682).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  studioDiscoverySchema,
  toolStudioDiscoveryGet,
} from "./tool.studio.discovery.get";

/** A discovery as Studio reads it, with every field set. */
const discovery = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  server: "ledger",
  mcpServerId: "mcs_1",
  status: "succeeded",
  trigger: "manual",
  requestedAt: "2026-09-29T10:00:00.000Z",
  requestedBy: "usr_1",
  startedAt: "2026-09-29T10:00:05.000Z",
  finishedAt: "2026-09-29T10:00:09.000Z",
  error: null,
  outcome: "pr_opened",
  toolCount: 4,
  machine: null,
  sourceKind: "mcp",
  sourceRepo: null,
  sourcePath: null,
  sourceRef: null,
  schedule: "daily",
  upstreamDigest: "sha256:abc",
  latestVersion: null,
  pr: {
    number: 12,
    url: "https://github.com/acme/steering/pull/12",
    branch: "oxagen/sync/ledger",
  },
  withheld: ["ledger__delete_entry"],
  stalled: false,
} as const;

describe("get_studio_discovery is registered as declared", () => {
  it("is scoped, reads only, and skips the billing gate", () => {
    const cap = getCapability("get_studio_discovery");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(false);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
  });

  it("lets a workspace viewer read", () => {
    const cap = getCapability("get_studio_discovery");
    expect(cap?.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
    });
  });
});

describe("get_studio_discovery", () => {
  it("accepts a server name", () => {
    expect(toolStudioDiscoveryGet.input.parse({ server: "ledger" })).toEqual({
      server: "ledger",
    });
  });

  it("refuses an uppercase name, the built-in server, and an unknown field", () => {
    for (const input of [
      {},
      { server: "Ledger" },
      { server: "builtin" },
      { server: "ledger", id: "7c9e6679-7425-40de-944b-e07fc1f90ae7" },
    ]) {
      expect(toolStudioDiscoveryGet.input.safeParse(input).success).toBe(false);
    }
  });

  it("returns a discovery or null", () => {
    expect(toolStudioDiscoveryGet.output.parse({ discovery: null })).toEqual({
      discovery: null,
    });
    expect(toolStudioDiscoveryGet.output.parse({ discovery })).toEqual({
      discovery,
    });
  });

  it("refuses a discovery without the stalled flag or with a non-ISO date", () => {
    const unflagged: Record<string, unknown> = { ...discovery };
    delete unflagged.stalled;
    expect(studioDiscoverySchema.safeParse(unflagged).success).toBe(false);
    expect(
      studioDiscoverySchema.safeParse({ ...discovery, requestedAt: "yesterday" })
        .success,
    ).toBe(false);
    expect(
      studioDiscoverySchema.safeParse({ ...discovery, status: "cancelled" })
        .success,
    ).toBe(false);
  });
});
