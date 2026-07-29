/**
 * Command-layer tests for `oxagen config init|get|set|add|remove|explain|build|lint|pull`
 * (the Oxagen Workspace Config surface — NOT the legacy `handleConfig` token/model/
 * api-url getter-setter, which is untouched and already implicitly covered by the
 * rest of the suite exercising the CLI).
 *
 * Every handler takes an injection context (`cwd` + `managedConfigPath` +
 * `userConfigPath` [+ `userHomeDir`/`userSettingsPath` for build/lint, which
 * thread straight into the indexer) so nothing here ever touches the real
 * $HOME or ~/.oxagen — and, since the ADR-023 §4 output-discipline conversion, a
 * trailing {@link CommandWriter}. We pass a fake writer that captures stdout into
 * `out[]` and stderr into `err[]`, so these tests assert the discipline directly:
 * answers land on stdout, advisories/errors on stderr, and errors set the right
 * non-zero exit code without ever calling `process.exit`.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../lib/api.js", () => ({
  userApiPostOrThrow: vi.fn(),
}));

import {
  configInit,
  configGet,
  configSet,
  configAdd,
  configRemove,
  configExplain,
  configBuild,
  configLint,
  configPull,
  type WorkspaceConfigCtx,
} from "../config.js";
import { userApiPostOrThrow } from "../../lib/api.js";
import {
  getConfigScopePaths,
  clearWorkspaceConfigCache,
} from "../../config/index.js";
import type { CommandWriter } from "../../lib/capture-writer.js";

const mockUserApiPostOrThrow = userApiPostOrThrow as unknown as Mock;

let cwd: string;
let homeDir: string;
let ctx: WorkspaceConfigCtx;
let out: string[];
let err: string[];
let writer: CommandWriter;

function write(relPath: string, content: string, base = cwd): void {
  const full = join(base, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

// text()/errText() read the CURRENT `out`/`err` bindings, so a mid-test
// `out = []` reset (used to isolate the call under test from its setup) works.
const text = () => out.join("\n");
const errText = () => err.join("\n");

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oxagen-cmd-config-cwd-"));
  homeDir = mkdtempSync(join(tmpdir(), "oxagen-cmd-config-home-"));
  ctx = {
    cwd,
    managedConfigPath: join(homeDir, "managed.json"),
    userConfigPath: join(homeDir, "user.json"),
    userHomeDir: homeDir,
    userSettingsPath: join(homeDir, "settings.json"),
  };
  out = [];
  err = [];
  writer = {
    write: (line: string) => {
      out.push(line);
    },
    writeErr: (line: string) => {
      err.push(line);
    },
  };
  process.exitCode = undefined;
  mockUserApiPostOrThrow.mockReset();
  clearWorkspaceConfigCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  process.exitCode = undefined;
  clearWorkspaceConfigCache();
});

describe("configInit", () => {
  it("writes a starter workspace.json when absent", () => {
    configInit(undefined, ctx, writer);
    expect(text()).toContain("Wrote starter workspace config");
    expect(existsSync(getConfigScopePaths(cwd, ctx).workspace)).toBe(true);
  });

  it("is idempotent — leaves an existing file untouched", () => {
    write(".oxagen/workspace.json", JSON.stringify({ orgSlug: "acme" }));
    configInit(undefined, ctx, writer);
    expect(text()).toContain("already exists");
    const doc = JSON.parse(
      readFileSync(getConfigScopePaths(cwd, ctx).workspace, "utf8"),
    );
    expect(doc.orgSlug).toBe("acme");
  });

  it("rejects an unknown scope on stderr with a usage exit code (2)", () => {
    configInit("nowhere", ctx, writer);
    expect(errText()).toContain('Unknown scope "nowhere"');
    expect(process.exitCode).toBe(2);
    expect(out).toHaveLength(0); // stdout clean on error
  });

  it("refuses org scope with a clear message and a runtime exit code (1)", () => {
    configInit("org", ctx, writer);
    expect(errText()).toContain("read-only");
    expect(process.exitCode).toBe(1);
    expect(out).toHaveLength(0);
  });
});

describe("configGet", () => {
  it("reports (not set) for a path nothing defines", () => {
    configGet("vision.statement", ctx, writer);
    expect(text()).toBe("vision.statement: (not set)");
  });

  it("prints the merged value and winning scope", () => {
    configSet("vision.statement", "Ship it.", "workspace", ctx, writer);
    out = [];
    configGet("vision.statement", ctx, writer);
    expect(text()).toBe("vision.statement: Ship it.  (workspace)");
  });

  // Item 8b: `config get model` (Workspace Config) and `config model` (store
  // #2) used to read entirely different stores, so `config get model` always
  // reported "(not set)" even when store #2 had a real value — a split-brain
  // get. Now `config get` on one of the 4 runtime keys prints every store
  // with the actual runtime-effective winner marked.
  describe("split-brain runtime keys (model/apiUrl/effort/token)", () => {
    it("prints per-store breakdown for model instead of falling through to Workspace Config", () => {
      configGet("model", ctx, writer);
      expect(text()).toContain("model — resolved from EACH store");
      expect(text()).toContain("shell/session env OXAGEN_MODEL:");
      expect(text()).toContain("settings.json");
      expect(text()).toContain("~/.config/oxagen/config.json:");
      expect(text()).toContain("→ effective at runtime:");
    });

    it("reflects a shell-exported OXAGEN_MODEL as the effective winner", () => {
      const saved = process.env["OXAGEN_MODEL"];
      process.env["OXAGEN_MODEL"] = "vendor/from-shell";
      try {
        configGet("model", ctx, writer);
        expect(text()).toContain(
          "shell/session env OXAGEN_MODEL:  vendor/from-shell",
        );
        expect(text()).toContain("→ effective at runtime:  vendor/from-shell");
      } finally {
        if (saved === undefined) delete process.env["OXAGEN_MODEL"];
        else process.env["OXAGEN_MODEL"] = saved;
      }
    });

    it("masks the token value like the legacy getter does", () => {
      configGet("token", ctx, writer);
      expect(text()).toContain("token — resolved from EACH store");
      expect(text()).not.toContain("settings.json"); // token has no settings.json equivalent
    });

    it("does not print a settings.json row for effort (no settings.json equivalent)", () => {
      configGet("effort", ctx, writer);
      expect(text()).toContain("effort — resolved from EACH store");
      expect(
        text()
          .split("\n")
          .some((l) => l.includes("settings.json")),
      ).toBe(false);
    });
  });
});

describe("configSet", () => {
  it("writes and confirms on stdout", () => {
    configSet("packageManagers.primary", "pnpm", "workspace", ctx, writer);
    expect(text()).toContain("✓ packageManagers.primary = pnpm  (workspace:");
  });

  it("defaults to workspace scope when --scope is omitted", () => {
    configSet("packageManagers.primary", "pnpm", undefined, ctx, writer);
    expect(text()).toContain(getConfigScopePaths(cwd, ctx).workspace);
  });

  it("rejects an unknown scope on stderr with a usage exit code (2)", () => {
    configSet("packageManagers.primary", "pnpm", "nowhere", ctx, writer);
    expect(errText()).toContain('Unknown scope "nowhere"');
    expect(process.exitCode).toBe(2);
    expect(out).toHaveLength(0);
  });

  it("warns (on stderr) when the write would be overridden by a more-authoritative locked scope", () => {
    write(
      "managed.json",
      JSON.stringify({ packageManagers: { primary: "npm" } }),
      homeDir,
    );
    configSet("packageManagers.primary", "pnpm", "workspace", ctx, writer);
    // The advisory Note is decoration → stderr; the ✓ confirmation is the answer → stdout.
    expect(errText()).toContain("Note:");
    expect(errText()).toContain("locked by managed.json (org)");
    expect(text()).toContain("✓ packageManagers.primary = pnpm");
  });

  it("does not warn when writing to the scope that already wins", () => {
    configSet("packageManagers.primary", "pnpm", "workspace", ctx, writer);
    out = [];
    err = [];
    configSet("packageManagers.primary", "pnpm2", "workspace", ctx, writer);
    expect(errText()).not.toContain("Note:");
  });

  // Item 8a: previously this warning fired ONLY for a locked-scope win. A
  // more-specific-but-unlocked scope (e.g. workspace already sets the path
  // while this write targets the less-specific `user` scope) silently
  // shadowed the new write with no warning at all.
  it("warns (on stderr) when a more-specific UNLOCKED scope already shadows the write target", () => {
    configSet("packageManagers.primary", "pnpm", "workspace", ctx, writer); // workspace is more specific than user
    out = [];
    err = [];
    configSet("packageManagers.primary", "npm", "user", ctx, writer);
    expect(errText()).toContain("Note:");
    expect(errText()).toContain("most specific: workspace.json (workspace)");
  });

  it("does not warn when writing to a MORE specific scope than the current (less-specific) winner", () => {
    configSet("packageManagers.primary", "npm", "user", ctx, writer);
    out = [];
    err = [];
    configSet("packageManagers.primary", "pnpm", "workspace", ctx, writer); // workspace is more specific — this write will win
    expect(errText()).not.toContain("Note:");
  });

  // Item 5: model/apiUrl/effort/token are store #2 / settings.json fields —
  // nothing in Workspace Config ever reads them back, so `config set` used to
  // print a confident "✓" for a write that was a total no-op.
  describe("dead-key redirect", () => {
    it.each(["model", "apiUrl", "effort", "token"])(
      "redirects %s to the legacy command, exits 2 (usage), and writes nothing to stdout",
      (key) => {
        configSet(key, "some-value", "workspace", ctx, writer);
        expect(errText()).toContain(`"${key}"`);
        expect(errText()).toContain("Did you mean: oxagen config");
        expect(process.exitCode).toBe(2);
        expect(out).toHaveLength(0);
      },
    );

    it("never writes workspace.json for a dead-key set", () => {
      configSet("model", "vendor/x", "workspace", ctx, writer);
      expect(existsSync(getConfigScopePaths(cwd, ctx).workspace)).toBe(false);
    });

    it("apiUrl redirects to the hyphenated legacy key (api-url), not the field name", () => {
      configSet("apiUrl", "https://example.com", "workspace", ctx, writer);
      expect(errText()).toContain("oxagen config api-url https://example.com");
    });
  });
});

describe("configAdd", () => {
  it("adds an item, auto-slugging the id from the text", () => {
    configAdd("typescript", "rule", "No any.", {}, ctx, writer);
    expect(text()).toContain('✓ Added rule "no-any" to languages.typescript');
    out = [];
    configExplain("languages.typescript.items.no-any", ctx, writer);
    expect(text()).toContain("languages.typescript.items.no-any");
  });

  it("honors an explicit --id", () => {
    configAdd(
      "typescript",
      "rule",
      "No any.",
      { id: "custom-id" },
      ctx,
      writer,
    );
    expect(text()).toContain('"custom-id"');
  });

  it("rejects an unknown kind on stderr with a usage exit code (2)", () => {
    configAdd("typescript", "not-a-kind", "text", {}, ctx, writer);
    expect(errText()).toContain('Unknown kind "not-a-kind"');
    expect(process.exitCode).toBe(2);
    expect(out).toHaveLength(0);
  });

  it("rejects an unknown scope on stderr with a usage exit code (2)", () => {
    configAdd("typescript", "rule", "text", { scope: "nowhere" }, ctx, writer);
    expect(errText()).toContain('Unknown scope "nowhere"');
    expect(process.exitCode).toBe(2);
  });
});

describe("configRemove", () => {
  it("removes an existing item", () => {
    configAdd("typescript", "rule", "No any.", { id: "no-any" }, ctx, writer);
    out = [];
    configRemove("no-any", "workspace", ctx, writer);
    expect(text()).toContain('✓ Removed "no-any"');
  });

  it("reports not-found on stderr with a non-zero exit code and clean stdout", () => {
    configRemove("does-not-exist", "workspace", ctx, writer);
    expect(errText()).toContain("not found");
    expect(process.exitCode).toBe(1);
    expect(out).toHaveLength(0);
  });
});

describe("configExplain", () => {
  it("reports an unset path", () => {
    configExplain("vision.statement", ctx, writer);
    expect(text()).toContain("is not set in any scope");
  });

  it("reports the winning scope for a set path", () => {
    configSet("vision.statement", "Ship it.", "workspace", ctx, writer);
    out = [];
    configExplain("vision.statement", ctx, writer);
    expect(text()).toContain("most specific: workspace.json (workspace)");
  });
});

describe("configBuild", () => {
  it("scans sources and writes the consolidated index into workspace.json (pretty summary → stdout)", async () => {
    write(
      ".oxagen/agents/reviewer.toml",
      'schema_version = 1\nkind = "agent"\nname = "reviewer"\ndescription = "Reviews code."\ndeveloper_instructions = "Body."\n',
    );
    await configBuild({}, ctx, writer);
    expect(text()).toContain("✓ Built consolidated index");
    expect(text()).toContain("agents: 1");
    // pretty mode is a human summary, not JSON
    expect(() => JSON.parse(text())).toThrow();
  });

  it("--json emits ONE single-line JSON value that round-trips the same shape", async () => {
    await configBuild({ json: true }, ctx, writer);
    // exactly one stdout write, single line, no pretty chrome, nothing on stderr
    expect(out).toHaveLength(1);
    expect(text()).not.toContain("\n");
    expect(text()).not.toContain("✓ Built");
    expect(err).toHaveLength(0);
    const parsed = JSON.parse(text());
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed).toHaveProperty("skills");
    // shape is preserved: re-serializing the parsed value yields the same single line
    expect(JSON.stringify(parsed)).toBe(text());
  });
});

describe("configLint", () => {
  it("reports ok when no config files exist", async () => {
    await configLint(ctx, writer);
    expect(text()).toContain("No config files found");
  });

  it("validates a present, well-formed scope file", async () => {
    configSet("packageManagers.primary", "pnpm", "workspace", ctx, writer);
    out = [];
    await configLint(ctx, writer);
    expect(text()).toContain("✓ workspace");
  });

  it("reports schema errors on stderr for a malformed scope file", async () => {
    write(
      ".oxagen/workspace.json",
      JSON.stringify({ version: "not-a-number" }),
    );
    await configLint(ctx, writer);
    expect(errText()).toContain("✗ workspace");
    expect(process.exitCode).toBe(1);
  });

  it("detects consolidated drift when sources changed since the last build", async () => {
    await configBuild({}, ctx, writer);
    out = [];
    write(
      ".oxagen/agents/new-agent.toml",
      'schema_version = 1\nkind = "agent"\nname = "new-agent"\ndescription = "New agent."\ndeveloper_instructions = "Body."\n',
    );
    await configLint(ctx, writer);
    expect(text()).toContain("drift detected");
    expect(text()).toContain("agents: +new-agent");
    expect(process.exitCode).toBe(1);
  });

  it("reports up to date immediately after a build with no further changes", async () => {
    await configBuild({}, ctx, writer);
    out = [];
    await configLint(ctx, writer);
    expect(text()).toContain("consolidated: up to date");
  });
});

describe("configPull", () => {
  it("prints a clear not-yet-available message and does not throw when the endpoint is unreachable", async () => {
    mockUserApiPostOrThrow.mockRejectedValueOnce(new Error("404 Not Found"));
    await expect(configPull(ctx, writer)).resolves.toBeUndefined();
    expect(text()).toContain("isn't available yet");
    expect(text()).toContain("404 Not Found");
  });

  it("writes userConfig to the user scope path when the platform returns one", async () => {
    mockUserApiPostOrThrow.mockResolvedValueOnce({
      userConfig: { orgSlug: "acme" },
    });
    await configPull(ctx, writer);
    expect(text()).toContain("✓ Pulled user config");
    expect(existsSync(getConfigScopePaths(cwd, ctx).user)).toBe(true);
  });

  it("reports nothing to pull when the platform has no config yet", async () => {
    mockUserApiPostOrThrow.mockResolvedValueOnce({});
    await configPull(ctx, writer);
    expect(text()).toContain("Nothing to pull");
  });
});
