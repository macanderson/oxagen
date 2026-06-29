import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_SLASH_COMMANDS,
  BUILTIN_SLASH_NAMES,
  buildSlashCatalog,
  filterSlashCatalog,
  slashQuery,
  type SlashCatalogEntry,
} from "../catalog.js";
import type { CliCommandMeta } from "../../program.js";

const CLI: CliCommandMeta[] = [
  { name: "cost", description: "Project model cost", argumentHint: undefined },
  { name: "graph", description: "Query the knowledge graph", argumentHint: undefined },
  // Collides with the built-in /replay — the built-in must win.
  { name: "replay", description: "CLI replay", argumentHint: "[turn]" },
];

describe("BUILTIN_SLASH_COMMANDS", () => {
  it("includes the REPL-native commands with /tui and /init", () => {
    expect(BUILTIN_SLASH_NAMES.has("tui")).toBe(true);
    expect(BUILTIN_SLASH_NAMES.has("init")).toBe(true);
    expect(BUILTIN_SLASH_NAMES.has("help")).toBe(true);
    expect(BUILTIN_SLASH_NAMES.has("exit")).toBe(true);
  });

  it("gives /tui a compact|fullscreen argument hint", () => {
    const tui = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "tui");
    expect(tui?.argumentHint).toBe("[compact|fullscreen]");
    expect(tui?.description.length).toBeGreaterThan(0);
  });
});

describe("slashQuery", () => {
  it("returns the lowercased partial while typing a single /word token", () => {
    expect(slashQuery("/mo")).toBe("mo");
    expect(slashQuery("/TUI")).toBe("tui");
    expect(slashQuery("/")).toBe("");
  });

  it("closes the menu (null) once arguments begin or it isn't a slash token", () => {
    expect(slashQuery("/tui compact")).toBeNull();
    expect(slashQuery("/tui ")).toBeNull();
    expect(slashQuery("find the bug")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("buildSlashCatalog", () => {
  let dir: string;
  let userDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oxagen-catalog-"));
    userDir = join(dir, "user-commands");
    mkdirSync(userDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function build(): SlashCatalogEntry[] {
    return buildSlashCatalog({ cwd: dir, cliCommands: CLI, userCommandsDir: userDir });
  }

  it("marks built-in and CLI commands productized, custom commands not", () => {
    writeFileSync(
      join(userDir, "shipit.md"),
      "---\ndescription: Ship the branch\n---\nOpen a PR for $ARGUMENTS\n",
      "utf8",
    );
    const catalog = build();
    const tui = catalog.find((c) => c.name === "tui");
    const cost = catalog.find((c) => c.name === "cost");
    const shipit = catalog.find((c) => c.name === "shipit");

    expect(tui).toMatchObject({ source: "builtin", productized: true });
    expect(cost).toMatchObject({ source: "cli", productized: true });
    expect(shipit).toMatchObject({ source: "custom", productized: false });
    expect(shipit?.description).toBe("Ship the branch");
  });

  it("dedupes on name with precedence builtin > cli > custom", () => {
    // A custom command that shadows a built-in name must not displace the built-in.
    writeFileSync(join(userDir, "tui.md"), "---\ndescription: custom tui\n---\nbody\n", "utf8");
    const catalog = build();
    const tuiEntries = catalog.filter((c) => c.name === "tui");
    expect(tuiEntries).toHaveLength(1);
    expect(tuiEntries[0]).toMatchObject({ source: "builtin", productized: true });

    // The CLI `replay` collides with the built-in /replay → built-in wins.
    const replayEntries = catalog.filter((c) => c.name === "replay");
    expect(replayEntries).toHaveLength(1);
    expect(replayEntries[0]?.source).toBe("builtin");
  });

  it("orders builtin entries before cli before custom", () => {
    writeFileSync(join(userDir, "zzz.md"), "---\ndescription: z\n---\nbody\n", "utf8");
    const catalog = build();
    const sources = catalog.map((c) => c.source);
    const firstCli = sources.indexOf("cli");
    const firstCustom = sources.indexOf("custom");
    const lastBuiltin = sources.lastIndexOf("builtin");
    expect(lastBuiltin).toBeLessThan(firstCli);
    expect(firstCli).toBeLessThan(firstCustom);
  });
});

describe("filterSlashCatalog", () => {
  const catalog = buildSlashCatalog({ cwd: tmpdir(), cliCommands: CLI, userCommandsDir: join(tmpdir(), "nope-does-not-exist") });

  it("returns the whole catalog for an empty query", () => {
    expect(filterSlashCatalog(catalog, "")).toHaveLength(catalog.length);
  });

  it("prefix-matches case-insensitively", () => {
    const m = filterSlashCatalog(catalog, "mo");
    expect(m.map((c) => c.name)).toContain("mode");
    expect(m.map((c) => c.name)).toContain("model");
    expect(m.every((c) => c.name.startsWith("mo"))).toBe(true);
  });

  it("returns nothing when the prefix matches no command", () => {
    expect(filterSlashCatalog(catalog, "zzzznope")).toHaveLength(0);
  });
});
