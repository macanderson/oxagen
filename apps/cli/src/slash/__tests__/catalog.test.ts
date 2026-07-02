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
import { theme } from "../../tui/theme.js";

const CLI: CliCommandMeta[] = [
  { name: "cost", description: "Project model cost", argumentHint: undefined },
  { name: "graph", description: "Query the knowledge graph", argumentHint: undefined },
  // Collides with the built-in /replay — the built-in must win.
  { name: "replay", description: "CLI replay", argumentHint: "[turn]" },
];

describe("BUILTIN_SLASH_COMMANDS", () => {
  it("includes the REPL-native commands with /mode and /init", () => {
    expect(BUILTIN_SLASH_NAMES.has("mode")).toBe(true);
    expect(BUILTIN_SLASH_NAMES.has("init")).toBe(true);
    expect(BUILTIN_SLASH_NAMES.has("help")).toBe(true);
    expect(BUILTIN_SLASH_NAMES.has("exit")).toBe(true);
  });

  it("gives /mode a permission-posture argument hint", () => {
    const mode = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "mode");
    expect(mode?.argumentHint).toBe("[ask|auto-edit|bypass|readonly]");
    expect(mode?.description.length).toBeGreaterThan(0);
  });
});

describe("slashQuery", () => {
  it("returns the lowercased partial while typing a single /word token", () => {
    expect(slashQuery("/mo")).toBe("mo");
    expect(slashQuery("/MODE")).toBe("mode");
    expect(slashQuery("/")).toBe("");
  });

  it("closes the menu (null) once arguments begin or it isn't a slash token", () => {
    expect(slashQuery("/mode ask")).toBeNull();
    expect(slashQuery("/mode ")).toBeNull();
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
    const mode = catalog.find((c) => c.name === "mode");
    const cost = catalog.find((c) => c.name === "cost");
    const shipit = catalog.find((c) => c.name === "shipit");

    expect(mode).toMatchObject({ source: "builtin", productized: true });
    expect(cost).toMatchObject({ source: "cli", productized: true });
    expect(shipit).toMatchObject({ source: "custom", productized: false });
    expect(shipit?.description).toBe("Ship the branch");

    // Only builtin commands carry a menu color — CLI commands are productized
    // but uncolored, same as custom commands, so the menu renders them plain.
    expect(mode?.color).toBeDefined();
    expect(cost?.color).toBeUndefined();
    expect(shipit?.color).toBeUndefined();
  });

  it("assigns every builtin command a stable color from theme.commandPalette", () => {
    const catalog = build();
    const builtinEntries = catalog.filter((c) => c.source === "builtin");
    expect(builtinEntries.length).toBe(BUILTIN_SLASH_COMMANDS.length);
    for (const entry of builtinEntries) {
      expect(entry.color).toBeDefined();
      expect(theme.commandPalette).toContain(entry.color);
    }

    // Stable per command: rebuilding the catalog assigns the same color again.
    const rebuilt = build();
    for (const entry of builtinEntries) {
      const again = rebuilt.find((c) => c.name === entry.name);
      expect(again?.color).toBe(entry.color);
    }
  });

  it("dedupes on name with precedence builtin > cli > custom", () => {
    // A custom command that shadows a built-in name must not displace the built-in.
    writeFileSync(join(userDir, "mode.md"), "---\ndescription: custom mode\n---\nbody\n", "utf8");
    const catalog = build();
    const modeEntries = catalog.filter((c) => c.name === "mode");
    expect(modeEntries).toHaveLength(1);
    expect(modeEntries[0]).toMatchObject({ source: "builtin", productized: true });

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
