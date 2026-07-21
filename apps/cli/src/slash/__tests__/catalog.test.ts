import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_SLASH_COMMANDS,
  BUILTIN_SLASH_NAMES,
  buildSlashCatalog,
  filterSlashCatalog,
  matchScore,
  slashQuery,
  type SlashCatalogEntry,
} from "../catalog.js";
import type { CliCommandMeta } from "../../commands/meta.js";
import { theme } from "../../tui/theme.js";

const CLI: CliCommandMeta[] = [
  { name: "cost", description: "Project model cost", argumentHint: undefined },
  {
    name: "graph",
    description: "Query the knowledge graph",
    argumentHint: undefined,
  },
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
    return buildSlashCatalog({
      cwd: dir,
      cliCommands: CLI,
      userCommandsDir: userDir,
    });
  }

  function customCommand(name: string, description: string): string {
    return `schema_version = 1\nkind = "command"\nname = "${name}"\ndescription = "${description}"\nprompt = "body"\n`;
  }

  it("marks built-in and CLI commands productized, custom commands not", () => {
    writeFileSync(
      join(userDir, "shipit.toml"),
      customCommand("shipit", "Ship the branch"),
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
  });

  it("keeps built-ins in grouped BUILTIN_SLASH_COMMANDS order (not alphabetical)", () => {
    const catalog = build();
    const builtinEntries = catalog.filter((c) => c.source === "builtin");
    expect(builtinEntries.length).toBe(BUILTIN_SLASH_COMMANDS.length);
    // Order matches the source array's grouped order — no alphabetical reshuffle.
    expect(builtinEntries.map((c) => c.name)).toEqual(
      BUILTIN_SLASH_COMMANDS.map((c) => c.name),
    );
    expect(builtinEntries[0]?.name).toBe("help");
  });

  it("dedupes on name with precedence builtin > cli > custom", () => {
    // A custom command that shadows a built-in name must not displace the built-in.
    writeFileSync(
      join(userDir, "mode.toml"),
      customCommand("mode", "custom mode"),
      "utf8",
    );
    const catalog = build();
    const modeEntries = catalog.filter((c) => c.name === "mode");
    expect(modeEntries).toHaveLength(1);
    expect(modeEntries[0]).toMatchObject({
      source: "builtin",
      productized: true,
    });

    // The CLI `replay` collides with the built-in /replay → built-in wins.
    const replayEntries = catalog.filter((c) => c.name === "replay");
    expect(replayEntries).toHaveLength(1);
    expect(replayEntries[0]?.source).toBe("builtin");
  });

  it("orders builtin entries before cli before custom", () => {
    writeFileSync(join(userDir, "zzz.toml"), customCommand("zzz", "z"), "utf8");
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
  const catalog = buildSlashCatalog({
    cwd: tmpdir(),
    cliCommands: CLI,
    userCommandsDir: join(tmpdir(), "nope-does-not-exist"),
  });

  it("returns the whole catalog for an empty query", () => {
    expect(filterSlashCatalog(catalog, "")).toHaveLength(catalog.length);
  });

  it("prefix-matches case-insensitively and ranks prefix hits first", () => {
    const names = filterSlashCatalog(catalog, "mo").map((c) => c.name);
    expect(names).toContain("mode");
    expect(names).toContain("model");
    // Every prefix match must sort ahead of any non-prefix (substring/subsequence)
    // match — a bare `.every(startsWith)` no longer holds now that fuzzy matches
    // are included, but the prefix hits still lead.
    const firstNonPrefix = names.findIndex((n) => !n.startsWith("mo"));
    const prefixHits = names.filter((n) => n.startsWith("mo"));
    if (firstNonPrefix !== -1) {
      expect(firstNonPrefix).toBe(prefixHits.length);
    }
  });

  it("includes substring matches after prefix matches", () => {
    // "ram" is not a prefix of any command but is a substring of "diagram"-like
    // names; "remember" contains no such run, so use a known substring: "emor"
    // sits inside "memories" but is not a prefix.
    const names = filterSlashCatalog(catalog, "emor").map((c) => c.name);
    expect(names).toContain("memories");
    expect(names.every((n) => !n.startsWith("emor"))).toBe(true);
  });

  it("includes scattered subsequence matches, ranked below prefix/substring", () => {
    // "mds" is neither a prefix nor a substring of "model" but is a subsequence
    // (m…d…l… no s) — use "mdl" which is a subsequence of "model".
    const names = filterSlashCatalog(catalog, "mdl").map((c) => c.name);
    expect(names).toContain("model");
  });

  it("keeps the catalog's own order among equally-tiered prefix matches", () => {
    // Both /model and /mode are prefix matches for "mo"; the catalog lists
    // /model before /mode, and the ranking must preserve that stable order
    // rather than reshuffle by length.
    const names = filterSlashCatalog(catalog, "mo").map((c) => c.name);
    expect(names.indexOf("model")).toBeLessThan(names.indexOf("mode"));
  });

  it("is deterministic — same query yields the same order twice", () => {
    const a = filterSlashCatalog(catalog, "co").map((c) => c.name);
    const b = filterSlashCatalog(catalog, "co").map((c) => c.name);
    expect(a).toEqual(b);
  });

  it("returns nothing when nothing matches even as a subsequence", () => {
    expect(filterSlashCatalog(catalog, "zqxjk")).toHaveLength(0);
  });
});

describe("matchScore", () => {
  it("ranks prefix > substring > subsequence > no-match", () => {
    const prefix = matchScore("model", "mo");
    const substring = matchScore("atomos", "mo");
    const subseq = matchScore("mango", "mo"); // m…o scattered? m-a-n-g-o → m then o: subsequence
    const none = matchScore("xyz", "mo");
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
    expect(none).toBe(0);
  });

  it("returns a positive score for an empty query (matches everything)", () => {
    expect(matchScore("anything", "")).toBeGreaterThan(0);
  });

  it("gives equal-tier matches the same flat score (order is a tie-break, not the score)", () => {
    // Two prefix matches of differing length score identically — intra-tier
    // order is decided by the catalog, not by matchScore.
    expect(matchScore("mode", "mo")).toBe(matchScore("moderation", "mo"));
  });
});
