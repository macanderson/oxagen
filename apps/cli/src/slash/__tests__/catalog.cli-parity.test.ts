/**
 * Regression coverage for PR C item 11 — two real defects in the slash
 * catalog's CLI tier fixed alongside the REPL's inline capture-execution
 * seam (see repl/cli-bridge.ts):
 *
 *   1. `describeCliCommands` used to enumerate ONLY top-level commands, so
 *      subcommands like `graph search` / `mcp add` never appeared in the
 *      catalog at all — unreachable from the REPL's `/` menu no matter what.
 *      It now walks the Commander tree recursively and colon-joins the path
 *      (`graph:search`, `mcp:add`, …) into one unambiguous token.
 *   2. A CLI command whose bare name collided with a built-in (e.g. `config`)
 *      used to be silently dropped from the catalog by `buildSlashCatalog`'s
 *      dedup — genuinely unreachable, not even via `oxagen config` from
 *      inside the REPL's menu. It's now exposed under a `cli:<name>` alias.
 *
 * Uses the REAL Commander tree (`buildProgram()` from program.js), not a
 * synthetic CLI array — the whole point is proving the actual production
 * command tree round-trips through `describeCliCommands` + `buildSlashCatalog`
 * correctly, subcommands and collisions included.
 */
import { describe, it, expect } from "vitest";
import { buildProgram } from "../../program.js";
import { describeCliCommands } from "../../commands/meta.js";
import {
  buildSlashCatalog,
  CLI_DISAMBIGUATION_PREFIX,
  BUILTIN_SLASH_NAMES,
} from "../catalog.js";

describe("describeCliCommands — recursive subcommand discovery", () => {
  it("includes top-level commands (unchanged, no regression)", () => {
    const names = describeCliCommands(buildProgram()).map((c) => c.name);
    expect(names).toContain("cost");
    expect(names).toContain("graph");
    expect(names).toContain("mcp");
  });

  it("includes colon-joined subcommand paths — graph:search and mcp:add", () => {
    const names = describeCliCommands(buildProgram()).map((c) => c.name);
    expect(names).toContain("graph:search");
    expect(names).toContain("mcp:add");
    expect(names).toContain("mcp:list");
    expect(names).toContain("memory:list");
    expect(names).toContain("settings:get");
  });

  it("carries a real description and argument hint for a subcommand entry", () => {
    const entries = describeCliCommands(buildProgram());
    const graphSearch = entries.find((c) => c.name === "graph:search");
    expect(graphSearch).toBeDefined();
    expect(graphSearch?.description.length).toBeGreaterThan(0);

    const modelsUse = entries.find((c) => c.name === "models:use");
    expect(modelsUse?.argumentHint).toBe("<id>");
  });

  it("does not duplicate a subcommand under its bare leaf name", () => {
    // "search" alone (not "graph:search") should not appear as a top-level-ish
    // entry — the walk always includes the full parent path.
    const names = describeCliCommands(buildProgram()).map((c) => c.name);
    expect(names).not.toContain("search");
    expect(names).not.toContain("add");
  });
});

describe("buildSlashCatalog — builtin-shadowed CLI command disambiguation", () => {
  function catalog() {
    return buildSlashCatalog({
      cwd: "/tmp/does-not-matter",
      cliCommands: describeCliCommands(buildProgram()),
      userCommandsDir: "/tmp/oxagen-catalog-cli-parity-nonexistent",
    });
  }

  it("finds at least one real CLI top-level name shadowed by a built-in (canary)", () => {
    // "config" is both a built-in (/config — tiered settings browser) and a
    // real CLI command tree (`oxagen config get/set/add/...` — workspace
    // rules/preferences). If this ever stops being true (the CLI renames its
    // command, or the built-in does), update the fixture name below rather
    // than deleting the assertions it feeds.
    const cliNames = describeCliCommands(buildProgram()).map((c) => c.name);
    const shadowed = cliNames.filter((n) => BUILTIN_SLASH_NAMES.has(n));
    expect(shadowed.length).toBeGreaterThan(0);
    expect(shadowed).toContain("config");
  });

  it("the bare shadowed name still resolves to the built-in, not the CLI command", () => {
    const entry = catalog().find((c) => c.name === "config");
    expect(entry?.source).toBe("builtin");
  });

  it("the shadowed CLI command is reachable via its cli: disambiguated alias", () => {
    const aliased = catalog().find(
      (c) => c.name === `${CLI_DISAMBIGUATION_PREFIX}config`,
    );
    expect(aliased).toBeDefined();
    expect(aliased?.source).toBe("cli");
    expect(aliased?.productized).toBe(true);
    // The description should still be the CLI command's own (not the built-in's),
    // so /help / the menu tells the user what they're actually invoking.
    expect(aliased?.description).toContain("configuration");
  });

  it("every catalog entry name is unique (no aliasing collision slipped through)", () => {
    const names = catalog().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
