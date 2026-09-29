// The seam `@oxagen/handlers/register` fills at boot (lane M10, #4682). The
// module holds one runner and offers no way to remove it, so every test loads
// a fresh copy of the module.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerDiscoveryRunner } from "./mcp-server-discovery-runner";

type Seam = typeof import("./mcp-server-discovery-runner");

async function freshSeam(): Promise<Seam> {
  return import("./mcp-server-discovery-runner");
}

function fakeRunner(server: string): McpServerDiscoveryRunner {
  return {
    run: async () => ({
      server,
      status: "succeeded",
      outcome: "unchanged",
      toolCount: 0,
      withheld: [],
      pr: null,
      error: null,
    }),
    sweep: async () => [],
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe("mcp server discovery runner", () => {
  it("throws and names the fix in a process that installed no runner", async () => {
    const seam = await freshSeam();

    expect(() => seam.mcpServerDiscoveryRunner()).toThrow(
      /no discovery runner is installed; import @oxagen\/handlers\/register/,
    );
  });

  it("returns the runner installed last", async () => {
    const seam = await freshSeam();
    const earlier = fakeRunner("github");
    const later = fakeRunner("stripe");

    seam.setMcpServerDiscoveryRunner(earlier);
    seam.setMcpServerDiscoveryRunner(later);

    expect(seam.mcpServerDiscoveryRunner()).toBe(later);
  });
});
