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

// ADR-103 phase 1, MC spec §2.1: the old word does not appear in the product,
// and `--help` is the product. The commands themselves stay, because every
// machine enrolled so far was enrolled with `oxagen tacho enroll` and that
// string is in scripts, runbooks, and the managed settings documents MDM has
// already pushed. Hiding is the whole change; removing would be an outage.
describe("the deprecated tacho group", () => {
  const program = buildProgram();

  it("is absent from the top-level help", () => {
    expect(program.helpInformation()).not.toMatch(/tacho/i);
  });

  it("still carries every subcommand, so nothing enrolled breaks", () => {
    const tacho = program.commands.find((c) => c.name() === "tacho");
    expect(tacho, "the group itself must still be registered").toBeDefined();
    expect(tacho?.commands.map((c) => c.name()).sort()).toEqual([
      "enroll",
      "export",
      "hosts",
      "reassign",
      "status",
      "unenroll",
      "verify",
    ]);
  });

  // Telemetry classifies an invocation against `program.commands`, which keeps
  // hidden entries, so a deprecated call is still attributed rather than
  // recorded as unknown.
  it("stays visible to command classification", () => {
    expect(program.commands.map((c) => c.name())).toContain("tacho");
  });
});

describe("describeCliCommands", () => {
  const meta = describeCliCommands(buildProgram());
  const byName = new Map(meta.map((m) => [m.name, m]));

  it("surfaces the same top-level commands `oxagen --help` lists", () => {
    // A representative spread across the surviving governance command tree.
    for (const name of [
      "budget",
      "cost",
      "graph",
      "init",
      "memory",
      "trace",
      "secret",
    ]) {
      expect(byName.has(name), `missing ${name}`).toBe(true);
    }
  });

  it("carries each command's one-line description", () => {
    expect(byName.get("cost")?.description).toMatch(/cost/i);
    expect(byName.get("init")?.description).toMatch(/workspace/i);
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

  it("keeps every command excised with the runtime registered as a stub", () => {
    // ADR-043: a stale `oxagen sandbox …` must fail with guidance pointing at
    // Stella, not with an unknown-command parse error.
    for (const name of [
      "sandbox",
      "sandbox-template",
      "code",
      "eval",
      "file-lock",
      "a2a",
      "models",
      "skill",
      "prompt",
      "command",
      "rules",
      "settings",
      "config",
      "mcp",
      "import",
      "pr",
      "recover",
      "lineage",
    ]) {
      expect(byName.get(name)?.description, `missing ${name}`).toMatch(
        /retired/i,
      );
    }
  });
});
