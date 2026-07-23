import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { oxagenProjectDir } from "../oxagen-project-paths.js";

describe("oxagenProjectDir", () => {
  it("resolves <projectRoot>/.oxagen/agents for kind 'agents'", () => {
    expect(oxagenProjectDir("agents", "/tmp/proj")).toBe(
      join("/tmp/proj", ".oxagen", "agents"),
    );
  });

  it("resolves <projectRoot>/.oxagen/commands for kind 'commands'", () => {
    expect(oxagenProjectDir("commands", "/tmp/proj")).toBe(
      join("/tmp/proj", ".oxagen", "commands"),
    );
  });

  it("defaults projectRoot to process.cwd() when omitted", () => {
    expect(oxagenProjectDir("agents")).toBe(
      join(process.cwd(), ".oxagen", "agents"),
    );
  });
});
