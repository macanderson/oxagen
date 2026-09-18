import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyModelBaseUrls,
  claudeManagedSettingsPath,
  isModelProxyBaseUrl,
  modelBaseUrlFor,
  readModelBaseUrlState,
  restoreModelBaseUrls,
} from "./model-base-url";

let home: string;
const PORT = 4319;
const both = () => ({
  home,
  port: PORT,
  harnesses: ["claude-code" as const, "codex" as const],
});
// A managed file that does not exist, so the machine's own never leaks in.
const internals = () => ({
  managedSettingsFile: join(home, "no-managed-settings.json"),
});

const settingsPath = () => join(home, ".claude", "settings.json");
const tomlPath = () => join(home, ".codex", "config.toml");

function seed(path: string, text: string, mode = 0o644): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

const SETTINGS = `{
    "env": {
        "CLAUDE_CODE_SYNTAX_HIGHLIGHT": "1"
    },
    "hooks": { "PreToolUse": [] },
    "someFutureKey": [1, 2, 3]
}
`;

const TOML = `# my codex config
notify = ["say", "done"]   # a comment that must survive

[features]
js_repl = true

[mcp_servers.node_repl]
command = "node"
`;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "model-base-url-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the base URLs written", () => {
  it("gives Claude Code the /anthropic prefix and Codex the suffix its backend routes need", () => {
    expect(modelBaseUrlFor("claude-code", 4319)).toBe(
      "http://127.0.0.1:4319/anthropic",
    );
    expect(modelBaseUrlFor("codex", 4319)).toBe(
      "http://127.0.0.1:4319/backend-api/codex",
    );
    expect(
      isModelProxyBaseUrl("codex", "http://127.0.0.1:9/backend-api/codex"),
    ).toBe(false);
    expect(
      isModelProxyBaseUrl("claude-code", "https://api.anthropic.com"),
    ).toBe(false);
    expect(isModelProxyBaseUrl("claude-code", null)).toBe(false);
  });

  it("names the managed settings file per platform", () => {
    expect(claudeManagedSettingsPath("darwin")).toContain("/Library/");
    expect(claudeManagedSettingsPath("linux")).toBe(
      "/etc/claude-code/managed-settings.json",
    );
    expect(claudeManagedSettingsPath("win32")).toContain("Program Files");
  });
});

describe("apply then restore", () => {
  it("round trips both files byte for byte, keeping mode, unknown keys and comments", async () => {
    seed(settingsPath(), SETTINGS, 0o640);
    seed(tomlPath(), TOML, 0o600);

    const applied = await applyModelBaseUrls(both(), internals());
    expect(
      applied.harnesses.map((h) => [h.harness, h.changed, h.ours]),
    ).toEqual([
      ["claude-code", true, true],
      ["codex", true, true],
    ]);
    const claude = applied.harnesses[0]!;
    expect(claude.file).toBe(settingsPath());
    expect(claude.key).toBe("env.ANTHROPIC_BASE_URL");
    expect(claude.current).toBe("http://127.0.0.1:4319/anthropic");
    expect(claude.previous).toBeNull();
    expect(applied.harnesses[1]!.key).toBe("openai_base_url");

    const written = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(written.env).toEqual({
      CLAUDE_CODE_SYNTAX_HIGHLIGHT: "1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4319/anthropic",
    });
    expect(written.someFutureKey).toEqual([1, 2, 3]);
    // The file keeps the indent it was written with.
    expect(readFileSync(settingsPath(), "utf8")).toContain('\n    "env"');
    const toml = readFileSync(tomlPath(), "utf8");
    expect(
      toml.startsWith(
        'openai_base_url = "http://127.0.0.1:4319/backend-api/codex"\n',
      ),
    ).toBe(true);
    expect(toml).toContain("# a comment that must survive");
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o640);
    expect(statSync(tomlPath()).mode & 0o777).toBe(0o600);
    expect(statSync(claude.backup).mode & 0o777).toBe(0o600);

    const restored = await restoreModelBaseUrls(both(), internals());
    expect(restored.harnesses.every((h) => h.changed && !h.ours)).toBe(true);
    expect(readFileSync(settingsPath(), "utf8")).toBe(SETTINGS);
    expect(readFileSync(tomlPath(), "utf8")).toBe(TOML);
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o640);
    expect(existsSync(claude.backup)).toBe(false);
    // No temp file is left beside either config.
    expect(readdirSync(join(home, ".claude"))).toEqual(["settings.json"]);
    expect(readdirSync(join(home, ".codex"))).toEqual(["config.toml"]);
  });

  it("is idempotent: a second apply changes nothing on disk", async () => {
    seed(settingsPath(), SETTINGS);
    seed(tomlPath(), TOML);
    await applyModelBaseUrls(both(), internals());
    const first = [
      readFileSync(settingsPath(), "utf8"),
      readFileSync(tomlPath(), "utf8"),
    ];
    const again = await applyModelBaseUrls(both(), internals());
    expect(again.harnesses.map((h) => h.changed)).toEqual([false, false]);
    expect([
      readFileSync(settingsPath(), "utf8"),
      readFileSync(tomlPath(), "utf8"),
    ]).toEqual(first);
    // Restore still reaches the pre-enroll original after the no-op.
    await restoreModelBaseUrls(both(), internals());
    expect(readFileSync(settingsPath(), "utf8")).toBe(SETTINGS);
  });

  it("creates a missing file and removes it again, leaving nothing behind", async () => {
    const applied = await applyModelBaseUrls(both(), internals());
    expect(applied.harnesses.every((h) => h.changed)).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4319/anthropic" },
    });
    await restoreModelBaseUrls(both(), internals());
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(tomlPath())).toBe(false);
    expect(readdirSync(join(home, ".claude"))).toEqual([]);
  });

  it("displaces a value the user already had and restores exactly that", async () => {
    const mine = SETTINGS.replace(
      '"CLAUDE_CODE_SYNTAX_HIGHLIGHT": "1"',
      '"ANTHROPIC_BASE_URL": "https://llm.corp.example/anthropic"',
    );
    const myToml = `model = "gpt-5"\nopenai_base_url = 'https://llm.corp.example/v1' # corp gateway\r\n${TOML}`;
    seed(settingsPath(), mine);
    seed(tomlPath(), myToml);

    const applied = await applyModelBaseUrls(both(), internals());
    expect(applied.harnesses.map((h) => h.previous)).toEqual([
      "https://llm.corp.example/anthropic",
      "https://llm.corp.example/v1",
    ]);
    const toml = readFileSync(tomlPath(), "utf8");
    // Replaced in place, with the line ending that line had.
    expect(toml).toContain(
      'model = "gpt-5"\nopenai_base_url = "http://127.0.0.1:4319/backend-api/codex"\r\n',
    );
    expect(toml).not.toContain("corp.example");

    const state = await readModelBaseUrlState(both(), internals());
    expect(state.harnesses.map((h) => [h.ours, h.previous, h.changed])).toEqual(
      [
        [true, "https://llm.corp.example/anthropic", false],
        [true, "https://llm.corp.example/v1", false],
      ],
    );

    await restoreModelBaseUrls(both(), internals());
    expect(readFileSync(settingsPath(), "utf8")).toBe(mine);
    expect(readFileSync(tomlPath(), "utf8")).toBe(myToml);
  });

  it("keeps the first original across a port change", async () => {
    seed(settingsPath(), SETTINGS);
    seed(tomlPath(), TOML);
    await applyModelBaseUrls(both(), internals());
    const moved = await applyModelBaseUrls(
      { ...both(), port: 5000 },
      internals(),
    );
    expect(
      moved.harnesses.map((h) => [h.changed, h.current, h.previous]),
    ).toEqual([
      [true, "http://127.0.0.1:5000/anthropic", null],
      [true, "http://127.0.0.1:5000/backend-api/codex", null],
    ]);
    await restoreModelBaseUrls({ ...both(), port: 5000 }, internals());
    expect(readFileSync(settingsPath(), "utf8")).toBe(SETTINGS);
    expect(readFileSync(tomlPath(), "utf8")).toBe(TOML);
  });
});

describe("restore after somebody else edited the file", () => {
  it("removes only our value and keeps the other edit", async () => {
    seed(settingsPath(), SETTINGS);
    seed(tomlPath(), TOML);
    await applyModelBaseUrls(both(), internals());

    const edited = JSON.parse(readFileSync(settingsPath(), "utf8"));
    edited.model = "opus";
    writeFileSync(settingsPath(), `${JSON.stringify(edited, null, 4)}\n`);
    writeFileSync(
      tomlPath(),
      `${readFileSync(tomlPath(), "utf8")}\n[extra]\nadded = true\n`,
    );

    await restoreModelBaseUrls(both(), internals());
    const after = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(after.model).toBe("opus");
    expect(after.env).toEqual({ CLAUDE_CODE_SYNTAX_HIGHLIGHT: "1" });
    expect(readFileSync(tomlPath(), "utf8")).toBe(
      `${TOML}\n[extra]\nadded = true\n`,
    );
  });

  it("puts a displaced value back, and drops an env object it created", async () => {
    seed(
      settingsPath(),
      '{"env":{"ANTHROPIC_BASE_URL":"https://corp.example"}}',
    );
    seed(tomlPath(), 'openai_base_url = "https://corp.example/v1"\n');
    await applyModelBaseUrls(both(), internals());
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        ...JSON.parse(readFileSync(settingsPath(), "utf8")),
        x: 1,
      }),
    );
    writeFileSync(tomlPath(), `${readFileSync(tomlPath(), "utf8")}x = 1\n`);
    await restoreModelBaseUrls(both(), internals());
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      env: { ANTHROPIC_BASE_URL: "https://corp.example" },
      x: 1,
    });
    expect(readFileSync(tomlPath(), "utf8")).toBe(
      'openai_base_url = "https://corp.example/v1"\nx = 1\n',
    );

    // The env object apply created goes when it is empty again.
    rmSync(settingsPath());
    seed(settingsPath(), '{"a":1}');
    await applyModelBaseUrls(
      { ...both(), harnesses: ["claude-code"] },
      internals(),
    );
    writeFileSync(
      settingsPath(),
      readFileSync(settingsPath(), "utf8").replace('"a": 1', '"a": 2'),
    );
    await restoreModelBaseUrls(
      { ...both(), harnesses: ["claude-code"] },
      internals(),
    );
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ a: 2 });
  });

  it("leaves a value the user set after enrollment alone", async () => {
    seed(settingsPath(), SETTINGS);
    await applyModelBaseUrls(
      { ...both(), harnesses: ["claude-code"] },
      internals(),
    );
    const theirs = SETTINGS.replace(
      '"1"',
      '"1", "ANTHROPIC_BASE_URL": "https://theirs.example"',
    );
    writeFileSync(settingsPath(), theirs);
    const restored = await restoreModelBaseUrls(
      { ...both(), harnesses: ["claude-code"] },
      internals(),
    );
    expect(restored.harnesses[0]!.changed).toBe(false);
    expect(readFileSync(settingsPath(), "utf8")).toBe(theirs);
  });

  it("never treats a hand-written proxy value as an original to restore", async () => {
    seed(
      settingsPath(),
      '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4000/anthropic"}}',
    );
    await applyModelBaseUrls(
      { ...both(), harnesses: ["claude-code"] },
      internals(),
    );
    await restoreModelBaseUrls(
      { ...both(), harnesses: ["claude-code"] },
      internals(),
    );
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      env: {},
    });
  });
});

describe("edges", () => {
  it("refuses to touch a settings file that is not valid JSON", async () => {
    seed(settingsPath(), "{ not json");
    await expect(
      applyModelBaseUrls(
        { ...both(), harnesses: ["claude-code"] },
        internals(),
      ),
    ).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(settingsPath(), "utf8")).toBe("{ not json");
    seed(settingsPath(), "[1]");
    await expect(
      applyModelBaseUrls(
        { ...both(), harnesses: ["claude-code"] },
        internals(),
      ),
    ).rejects.toThrow(/not a JSON object/);
  });

  it("refuses a port that is not one", async () => {
    await expect(
      applyModelBaseUrls({ ...both(), port: 0 }, internals()),
    ).rejects.toThrow(/not a TCP port/);
  });

  it("does not mistake a table key or a multi-line string for the top-level key", async () => {
    const tricky = `notes = """\nopenai_base_url = "inside a string"\n"""\n[model_providers.x]\nopenai_base_url = "in a table"\n`;
    seed(tomlPath(), tricky);
    const applied = await applyModelBaseUrls(
      { ...both(), harnesses: ["codex"] },
      internals(),
    );
    expect(applied.harnesses[0]!.previous).toBeNull();
    expect(readFileSync(tomlPath(), "utf8")).toBe(
      `openai_base_url = "http://127.0.0.1:4319/backend-api/codex"\n${tricky}`,
    );
    await restoreModelBaseUrls(
      { ...both(), harnesses: ["codex"] },
      internals(),
    );
    expect(readFileSync(tomlPath(), "utf8")).toBe(tricky);
  });

  it("reports a managed setting that shadows ours", async () => {
    const managed = join(home, "managed-settings.json");
    writeFileSync(
      managed,
      '{"env":{"ANTHROPIC_BASE_URL":"https://pinned.example"}}',
    );
    const state = await applyModelBaseUrls(
      { ...both(), harnesses: ["claude-code", "claude-code"] },
      { managedSettingsFile: managed },
    );
    expect(state.harnesses).toHaveLength(1);
    expect(state.harnesses[0]!.shadowedBy).toEqual({
      file: managed,
      value: "https://pinned.example",
    });
    writeFileSync(managed, "not json");
    const unreadable = await readModelBaseUrlState(both(), {
      managedSettingsFile: managed,
    });
    expect(unreadable.harnesses[0]!.shadowedBy).toBeUndefined();
  });

  it("restore with nothing applied is a no-op that reports the file as it is", async () => {
    const restored = await restoreModelBaseUrls(both(), internals());
    expect(restored.harnesses.map((h) => [h.changed, h.current])).toEqual([
      [false, null],
      [false, null],
    ]);
    seed(settingsPath(), SETTINGS);
    await restoreModelBaseUrls(both(), internals());
    expect(readFileSync(settingsPath(), "utf8")).toBe(SETTINGS);
  });
});
