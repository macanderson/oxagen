// Loading the handler registrations installs the MCP server discovery runner
// (lane M10, #4682). A discovery run that finds a change opens a tools
// steering PR through M11's opener (#4686). The discovery seams refuse that PR
// with no_opener until the opener is installed, so each run installs it before
// the sync starts. Boot loads none of the three modules.
import {
  type McpServerDiscoveryData,
  mcpServerDiscoveryRunner,
} from "@oxagen/inngest-functions/mcp-server-discovery-runner";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loaded: { entry: false, seams: false, opener: false },
  opener: { open: vi.fn() },
  installDiscoverySeams: vi.fn(),
  runDiscoveryEvent: vi.fn(async () => RESULT),
  planDiscoverySweep: vi.fn(async () => []),
}));

const RESULT = {
  server: "billing",
  status: "done",
  outcome: "changed",
  toolCount: 3,
  withheld: [],
  pr: {
    number: 12,
    url: "https://github.com/acme/steering/pull/12",
    branch: "tools/sync-billing-20260929t0600",
  },
  error: null,
};

vi.mock("./mcp-studio/discovery/entry", () => {
  mocks.loaded.entry = true;
  return {
    runDiscoveryEvent: mocks.runDiscoveryEvent,
    planDiscoverySweep: mocks.planDiscoverySweep,
  };
});

vi.mock("./mcp-studio/discovery/seams", () => {
  mocks.loaded.seams = true;
  return { installDiscoverySeams: mocks.installDiscoverySeams };
});

vi.mock("./tools.pr.open", () => {
  mocks.loaded.opener = true;
  return { toolsPullRequestOpener: mocks.opener };
});

await import("./register");

const data: McpServerDiscoveryData = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  server: "billing",
  trigger: "manual",
  key: "0192d4a8-7c1e-7a00-8000-00000000ac3e:0192d4a8-7c1e-7a00-8000-0000000c0e01:billing",
};

describe("the handler registrations", () => {
  it("install M11's opener in the discovery seams before a discovery runs", async () => {
    expect(mocks.loaded).toEqual({ entry: false, seams: false, opener: false });

    await expect(mcpServerDiscoveryRunner().run(data)).resolves.toEqual(RESULT);

    expect(mocks.loaded).toEqual({ entry: true, seams: true, opener: true });
    expect(mocks.installDiscoverySeams).toHaveBeenCalledWith({
      opener: mocks.opener,
    });
    expect(mocks.runDiscoveryEvent).toHaveBeenCalledWith(data);
    const [installed] = mocks.installDiscoverySeams.mock.invocationCallOrder;
    const [ran] = mocks.runDiscoveryEvent.mock.invocationCallOrder;
    expect(installed).toBeLessThan(ran!);
  });

  it("plan the hourly sweep through the discovery entry", async () => {
    const now = new Date("2026-09-29T06:00:00Z");
    await expect(mcpServerDiscoveryRunner().sweep(now)).resolves.toEqual([]);
    expect(mocks.planDiscoverySweep).toHaveBeenCalledWith(now);
  });
});
