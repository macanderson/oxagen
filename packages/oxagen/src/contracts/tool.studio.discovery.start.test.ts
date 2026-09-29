/**
 * Contract test for start_studio_discovery (lane M10, #4682).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolStudioDiscoveryStart } from "./tool.studio.discovery.start";

const queued = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  server: "ledger",
  mcpServerId: null,
  status: "queued",
  trigger: "manual",
  requestedAt: "2026-09-29T10:00:00.000Z",
  requestedBy: "usr_1",
  startedAt: null,
  finishedAt: null,
  error: null,
  outcome: null,
  toolCount: null,
  machine: null,
  sourceKind: null,
  sourceRepo: null,
  sourcePath: null,
  sourceRef: null,
  schedule: null,
  upstreamDigest: null,
  latestVersion: null,
  pr: null,
  withheld: [],
  stalled: false,
} as const;

describe("start_studio_discovery is registered as declared", () => {
  it("is scoped, mutates, skips the billing gate, and audits the server folder", () => {
    const cap = getCapability("start_studio_discovery");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(true);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.agent?.requiresApproval).toBe(false);
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.audit).toEqual({
      targetKind: "tool_server_folder",
      targetIdField: "server",
    });
  });

  it("leaves a workspace viewer out", () => {
    const cap = getCapability("start_studio_discovery");
    expect(cap?.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
  });
});

describe("start_studio_discovery", () => {
  it("accepts a server name", () => {
    expect(toolStudioDiscoveryStart.input.parse({ server: "ledger" })).toEqual({
      server: "ledger",
    });
  });

  it("refuses an uppercase name, the built-in server, and an unknown field", () => {
    for (const input of [
      {},
      { server: "Ledger" },
      { server: "builtin" },
      { server: "ledger", trigger: "push" },
    ]) {
      expect(toolStudioDiscoveryStart.input.safeParse(input).success).toBe(
        false,
      );
    }
  });

  it("returns the queued discovery and never null", () => {
    expect(toolStudioDiscoveryStart.output.parse({ discovery: queued })).toEqual({
      discovery: queued,
    });
    expect(
      toolStudioDiscoveryStart.output.safeParse({ discovery: null }).success,
    ).toBe(false);
  });
});
