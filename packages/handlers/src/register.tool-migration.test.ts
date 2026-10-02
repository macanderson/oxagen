// The witness for #4948. Before it, migrate() in mcp-studio/migrate.ts had no
// capability, so no surface could start a workspace's move of its MCP servers
// into its steering repo. The registrations must resolve both the contract
// and its handler.
import { getCapability, hasHandler } from "@oxagen/oxagen";
import { describe, expect, it } from "vitest";

await import("./register");

describe("the migrate_tools_to_steering registration", () => {
  it("resolves the contract", () => {
    expect(getCapability("migrate_tools_to_steering")?.name).toBe("migrate_tools_to_steering");
  });

  it("resolves a handler for it", () => {
    expect(hasHandler("migrate_tools_to_steering")).toBe(true);
  });
});
