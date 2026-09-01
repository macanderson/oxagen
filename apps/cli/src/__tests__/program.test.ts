import { describe, it, expect } from "vitest";
import { buildProgram } from "../program.js";
import { describeCliCommands } from "../commands/meta.js";

describe("buildProgram", () => {
  it("builds the oxagen command tree with no side effects", () => {
    const program = buildProgram();
    expect(program.name()).toBe("oxagen");
    expect(program.commands.length).toBeGreaterThan(10);
  });
});

describe("describeCliCommands", () => {
  const meta = describeCliCommands(buildProgram());
  const byName = new Map(meta.map((m) => [m.name, m]));

  it("surfaces the same top-level commands `oxagen --help` lists", () => {
    // A representative spread across the command tree.
    for (const name of [
      "agents",
      "cost",
      "graph",
      "code",
      "init",
      "settings",
      "mcp",
      "secret",
    ]) {
      expect(byName.has(name), `missing ${name}`).toBe(true);
    }
  });

  it("carries each command's one-line description", () => {
    expect(byName.get("cost")?.description).toMatch(/cost/i);
    expect(byName.get("init")?.description).toMatch(/scaffold/i);
  });

  it("derives an argument hint from the command's declared arguments", () => {
    // `trace <executionId>` → required argument.
    expect(byName.get("trace")?.argumentHint).toBe("<executionId>");
    // `cost` takes only options → no positional hint.
    expect(byName.get("cost")?.argumentHint).toBeUndefined();
  });

  it("keeps the retired agent commands registered as stubs", () => {
    for (const name of [
      "agents",
      "solve",
      "fleet",
      "daemon",
      "view",
      "replay",
    ]) {
      expect(byName.get(name)?.description).toMatch(/retired/i);
    }
  });
});
