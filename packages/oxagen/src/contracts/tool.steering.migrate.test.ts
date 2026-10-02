import { describe, expect, it } from "vitest";
import {
  TOOL_MIGRATION_STATES,
  toolSteeringMigrate,
} from "./tool.steering.migrate";

const PR = { number: 12, url: "https://github.com/acme/oxagen-support/pull/12" };

describe("migrate_tools_to_steering contract", () => {
  it("is a high-sensitivity workspace write on api, mcp, and cli, outside metering", () => {
    expect(toolSteeringMigrate.name).toBe("migrate_tools_to_steering");
    expect(toolSteeringMigrate.domain).toBe("tool");
    expect(toolSteeringMigrate.scoped).toBe(true);
    expect(toolSteeringMigrate.mutates).toBe(true);
    expect(toolSteeringMigrate.noBillingGate).toBe(true);
    expect(toolSteeringMigrate.sensitivity).toBe("high");
    expect(toolSteeringMigrate.defaultEffect).toBe("deny");
    expect(toolSteeringMigrate.surfaces).toEqual(["api", "mcp", "cli"]);
  });

  it("is for org Owners and Admins only", () => {
    expect(toolSteeringMigrate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("takes nothing, because the workspace comes from the scope", () => {
    expect(toolSteeringMigrate.input.parse({})).toEqual({});
    expect(toolSteeringMigrate.input.safeParse({ workspaceId: "ws_1" }).success).toBe(false);
  });

  it("answers each state with its PRs", () => {
    expect(TOOL_MIGRATION_STATES).toEqual(["opened", "already_open", "already_migrated"]);
    for (const state of TOOL_MIGRATION_STATES) {
      const output = { state, pullRequest: PR, pullRequests: [PR] };
      expect(toolSteeringMigrate.output.parse(output)).toEqual(output);
    }
  });

  it("answers a workspace that never needed a PR with none", () => {
    const output = { state: "already_migrated", pullRequest: null, pullRequests: [] };
    expect(toolSteeringMigrate.output.parse(output)).toEqual(output);
  });

  it("refuses an unknown state, a bad PR number, a bad URL, and extra fields", () => {
    const ok = { state: "opened", pullRequest: PR, pullRequests: [PR] };
    expect(toolSteeringMigrate.output.safeParse({ ...ok, state: "merged" }).success).toBe(false);
    expect(
      toolSteeringMigrate.output.safeParse({ ...ok, pullRequest: { ...PR, number: 0 } }).success,
    ).toBe(false);
    expect(
      toolSteeringMigrate.output.safeParse({ ...ok, pullRequests: [{ ...PR, url: "pull/12" }] })
        .success,
    ).toBe(false);
    expect(toolSteeringMigrate.output.safeParse({ ...ok, branch: "tools/x" }).success).toBe(false);
    expect(toolSteeringMigrate.output.safeParse({ state: "opened" }).success).toBe(false);
  });
});
