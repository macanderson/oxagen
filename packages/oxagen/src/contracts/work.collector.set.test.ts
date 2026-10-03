import { describe, expect, it } from "vitest";
import { WORK_COLLECTOR_REPOS_MAX, workCollectorSet as contract } from "./work.collector.set";

// set_work_collector (P1-03, #5103).
describe("set_work_collector contract", () => {
  it("takes a name, and the connection, repositories, and pause it changes", () => {
    expect(contract.input.parse({ name: "github", connection_id: "con_01", repos: ["acme/web"] })).toEqual({
      name: "github",
      connection_id: "con_01",
      repos: ["acme/web"],
    });
    expect(contract.input.parse({ name: "github", paused: true })).toEqual({ name: "github", paused: true });
  });

  it.each([
    ["a name that is not a slug", { name: "GitHub Issues" }],
    ["no repositories", { name: "github", repos: [] }],
    ["a repository that is not owner/name", { name: "github", repos: ["web"] }],
    ["too many repositories", { name: "github", repos: Array.from({ length: WORK_COLLECTOR_REPOS_MAX + 1 }, (_, i) => `acme/r${i}`) }],
    ["a write-back switch", { name: "github", write_back: { close: true } }],
  ])("refuses %s", (_name, input) => {
    expect(contract.input.safeParse(input).success).toBe(false);
  });

  it("is on the API surface only: no MCP tool changes a collector (#5181)", () => {
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.layers).not.toContain("mcp");
  });

  it("is a setup action for a workspace owner or an org admin", () => {
    expect(contract.sensitivity).toBe("high");
    expect(contract.defaultRoles.workspace).toEqual({ Owner: "allow" });
    expect(contract.defaultRoles.org).toEqual({ Owner: "allow", Admin: "allow" });
  });
});
