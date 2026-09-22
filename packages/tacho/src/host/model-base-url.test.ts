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
  claudeToolSearchEnabled,
  isModelProxyBaseUrl,
  modelBaseUrlFor,
  readModelBaseUrlState,
  restoreModelBaseUrls,
  stellaManagedSettingsPath,
} from "./model-base-url";

let home: string;
const PORT = 4319;
const both = () => ({
  home,
  port: PORT,
  harnesses: ["claude-code" as const, "codex" as const],
});
// Managed files that do not exist, so the machine's own never leak in.
const internals = () => ({
  managedSettingsFile: join(home, "no-managed-settings.json"),
  stellaManagedSettingsFile: join(home, "no-managed-stella.toml"),
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
    expect(claude.toolSearch).toEqual({ current: "true", enabled: true });
    expect(applied.harnesses[1]!.key).toBe("openai_base_url");
    expect(applied.harnesses[1]!.toolSearch).toBeUndefined();

    const written = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(written.env).toEqual({
      CLAUDE_CODE_SYNTAX_HIGHLIGHT: "1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4319/anthropic",
      ENABLE_TOOL_SEARCH: "true",
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
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4319/anthropic",
        ENABLE_TOOL_SEARCH: "true",
      },
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

// Behind a non-Anthropic base URL Claude Code turns its tool search off and
// inlines the whole MCP catalog, which on a machine with a few hundred tools
// overflowed the context before the first prompt and thrashed autocompact.
describe("ENABLE_TOOL_SEARCH beside the base URL", () => {
  const claude = () => ({ ...both(), harnesses: ["claude-code" as const] });

  it("reads Claude Code's accepted values", () => {
    for (const on of ["true", "TRUE", "auto", "auto:30"])
      expect(claudeToolSearchEnabled(on)).toBe(true);
    for (const off of ["false", "0", "", "yes", "auto:", null, undefined])
      expect(claudeToolSearchEnabled(off)).toBe(false);
  });

  it("puts back the value it displaced, even after another edit", async () => {
    seed(settingsPath(), '{"env":{"ENABLE_TOOL_SEARCH":"false"}}\n');
    const applied = await applyModelBaseUrls(claude(), internals());
    expect(applied.harnesses[0]!.toolSearch).toEqual({
      current: "true",
      enabled: true,
    });
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).env).toEqual({
      ENABLE_TOOL_SEARCH: "true",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4319/anthropic",
    });

    const edited = JSON.parse(readFileSync(settingsPath(), "utf8"));
    edited.model = "opus";
    writeFileSync(settingsPath(), `${JSON.stringify(edited)}\n`);
    await restoreModelBaseUrls(claude(), internals());
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      env: { ENABLE_TOOL_SEARCH: "false" },
      model: "opus",
    });
  });

  it("leaves a value the user already had that enables the search", async () => {
    seed(settingsPath(), '{"env":{"ENABLE_TOOL_SEARCH":"auto:20"}}\n');
    const applied = await applyModelBaseUrls(claude(), internals());
    expect(applied.harnesses[0]!.toolSearch).toEqual({
      current: "auto:20",
      enabled: true,
    });
    const edited = JSON.parse(readFileSync(settingsPath(), "utf8"));
    edited.model = "opus";
    writeFileSync(settingsPath(), `${JSON.stringify(edited)}\n`);
    await restoreModelBaseUrls(claude(), internals());
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).env).toEqual({
      ENABLE_TOOL_SEARCH: "auto:20",
    });
  });

  it("keeps a value the user changed after enrollment", async () => {
    seed(settingsPath(), SETTINGS);
    await applyModelBaseUrls(claude(), internals());
    const edited = JSON.parse(readFileSync(settingsPath(), "utf8"));
    edited.env.ENABLE_TOOL_SEARCH = "auto";
    writeFileSync(settingsPath(), `${JSON.stringify(edited)}\n`);
    await restoreModelBaseUrls(claude(), internals());
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).env).toEqual({
      CLAUDE_CODE_SYNTAX_HIGHLIGHT: "1",
      ENABLE_TOOL_SEARCH: "auto",
    });
  });

  it("repairs a host enrolled before the key existed, and restores it clean", async () => {
    seed(settingsPath(), SETTINGS);
    const first = await applyModelBaseUrls(claude(), internals());
    // An enrollment from the build that wrote the base URL alone: the key is
    // missing from the file and from the sidecar.
    const file = JSON.parse(readFileSync(settingsPath(), "utf8"));
    delete file.env.ENABLE_TOOL_SEARCH;
    writeFileSync(settingsPath(), `${JSON.stringify(file, null, 4)}\n`);
    const backup = first.harnesses[0]!.backup;
    const sidecar = JSON.parse(readFileSync(backup, "utf8"));
    delete sidecar.previous_tool_search;
    writeFileSync(backup, `${JSON.stringify(sidecar, null, 2)}\n`);
    const before = await readModelBaseUrlState(claude(), internals());
    expect(before.harnesses[0]!.ours).toBe(true);
    expect(before.harnesses[0]!.toolSearch).toEqual({
      current: null,
      enabled: false,
    });

    const again = await applyModelBaseUrls(claude(), internals());
    expect(again.harnesses[0]!.changed).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).env).toEqual({
      CLAUDE_CODE_SYNTAX_HIGHLIGHT: "1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4319/anthropic",
      ENABLE_TOOL_SEARCH: "true",
    });
    expect(
      JSON.parse(readFileSync(backup, "utf8")).previous_tool_search,
    ).toBeNull();

    await restoreModelBaseUrls(claude(), internals());
    expect(readFileSync(settingsPath(), "utf8")).toBe(SETTINGS);
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

describe("Stella: providers.anthropic.base_url", () => {
  const STELLA_URL = `http://127.0.0.1:${PORT}/stella/anthropic`;
  const stella = () => ({ home, port: PORT, harnesses: ["stella" as const] });
  const stellaToml = () => join(home, ".stella", "stella.toml");
  const stellaJson = () => join(home, ".stella", "settings.json");
  // What Tacho's hooks writer leaves: the user's file, one line break, the block.
  const BLOCK = [
    "# >>> tacho enrollment tch_test (managed by tacho; do not edit) >>>",
    "[[hooks.Stop]]",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    'command = "tacho-hook"',
    "",
    "# <<< tacho enrollment tch_test <<<",
    "",
  ].join("\n");
  const USER = `# stella, hand-edited
[model]
name = "fable-5"   # keep

[providers.openrouter]
api_key_env = "OPENROUTER_KEY"`;

  it("gives Stella a prefix of its own, so its calls are never filed under Claude Code", () => {
    expect(modelBaseUrlFor("stella", 4319)).toBe(
      "http://127.0.0.1:4319/stella/anthropic",
    );
    expect(
      isModelProxyBaseUrl("stella", "http://127.0.0.1:4319/anthropic"),
    ).toBe(false);
    expect(stellaManagedSettingsPath("linux", {})).toBe(
      "/etc/stella/stella.toml",
    );
    expect(
      stellaManagedSettingsPath("darwin", {
        STELLA_MANAGED_SETTINGS: "/x.toml",
      }),
    ).toBe("/x.toml");
  });

  it("puts the table before the hooks block, is idempotent, and round trips byte for byte", async () => {
    const enrolled = `${USER}\n${BLOCK}`;
    seed(stellaToml(), enrolled, 0o600);
    const applied = await applyModelBaseUrls(stella(), internals());
    expect(applied.harnesses[0]).toMatchObject({
      harness: "stella",
      key: "providers.anthropic.base_url",
      current: STELLA_URL,
      ours: true,
      changed: true,
      file: stellaToml(),
    });
    const text = readFileSync(stellaToml(), "utf8");
    expect(text).toBe(
      `${USER}\n\n[providers.anthropic]\nbase_url = "${STELLA_URL}"\n${BLOCK}`,
    );
    // The hooks writer strips the block with the one line break before it
    // and appends it again: the same bytes come back.
    const stripped = text.replace(/\n# >>> tacho enrollment[\s\S]*$/, "");
    expect(`${stripped}\n${BLOCK}`).toBe(text);

    const again = await applyModelBaseUrls(stella(), internals());
    expect(again.harnesses[0]!.changed).toBe(false);
    expect(readFileSync(stellaToml(), "utf8")).toBe(text);

    await restoreModelBaseUrls(stella(), internals());
    expect(readFileSync(stellaToml(), "utf8")).toBe(enrolled);
    expect(statSync(stellaToml()).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, ".stella"))).toEqual(["stella.toml"]);
  });

  it("adds the key to a [providers.anthropic] table the user already has", async () => {
    const own = `[providers.anthropic]\napi_key_env = "MY_KEY"\n`;
    seed(stellaToml(), own);
    await applyModelBaseUrls(stella(), internals());
    expect(readFileSync(stellaToml(), "utf8")).toBe(
      `[providers.anthropic]\nbase_url = "${STELLA_URL}"\napi_key_env = "MY_KEY"\n`,
    );
    // Somebody else edits the file: restore takes out only our line and
    // leaves the user's table, which apply did not create.
    writeFileSync(
      stellaToml(),
      `${readFileSync(stellaToml(), "utf8")}# later\n`,
    );
    await restoreModelBaseUrls(stella(), internals());
    expect(readFileSync(stellaToml(), "utf8")).toBe(`${own}# later\n`);
  });

  it("takes out the table it created when the file was edited since", async () => {
    seed(stellaToml(), `${USER}\n`);
    await applyModelBaseUrls(stella(), internals());
    writeFileSync(
      stellaToml(),
      readFileSync(stellaToml(), "utf8").replace("fable-5", "fable-6"),
    );
    await restoreModelBaseUrls(stella(), internals());
    expect(readFileSync(stellaToml(), "utf8")).toBe(
      `${USER.replace("fable-5", "fable-6")}\n`,
    );
  });

  it("leaves a base_url the user set, and says so, writing nothing", async () => {
    const own = `[providers.anthropic]\nbase_url = "https://corp-proxy.example"\n`;
    seed(stellaToml(), own);
    const state = await applyModelBaseUrls(stella(), internals());
    expect(state.harnesses[0]).toMatchObject({
      ours: false,
      changed: false,
      current: "https://corp-proxy.example",
    });
    expect(state.harnesses[0]!.leftAlone).toContain("already sets");
    expect(readFileSync(stellaToml(), "utf8")).toBe(own);
    expect(readdirSync(join(home, ".stella"))).toEqual(["stella.toml"]);
  });

  it.each([
    ["a dotted key", 'providers.anthropic.api_key_env = "K"\n'],
    [
      "an inline providers table",
      'providers = { anthropic = { api_key_env = "K" } }\n',
    ],
    [
      "an inline anthropic table",
      '[providers]\nanthropic = { api_key_env = "K" }\n',
    ],
  ])(
    "refuses rather than corrupts a file that defines the table as %s",
    async (_shape, own) => {
      seed(stellaToml(), own);
      const state = await applyModelBaseUrls(stella(), internals());
      expect(state.harnesses[0]!.ours).toBe(false);
      expect(state.harnesses[0]!.leftAlone).toContain(
        "line edit cannot extend",
      );
      expect(readFileSync(stellaToml(), "utf8")).toBe(own);
    },
  );

  it("does not read a table name inside a multi-line string", async () => {
    const own = `notes = """\n[providers.anthropic]\nbase_url = "x"\n"""\n`;
    seed(stellaToml(), own);
    await applyModelBaseUrls(stella(), internals());
    expect(readFileSync(stellaToml(), "utf8")).toBe(
      `${own}\n[providers.anthropic]\nbase_url = "${STELLA_URL}"\n`,
    );
  });

  it("writes the legacy settings.json when that is the file Stella reads, and never creates a TOML beside it", async () => {
    const own = `{\n  "model": "anthropic/claude-sonnet-5"\n}\n`;
    seed(stellaJson(), own);
    const state = await applyModelBaseUrls(stella(), internals());
    expect(state.harnesses[0]!.file).toBe(stellaJson());
    expect(existsSync(stellaToml())).toBe(false);
    expect(JSON.parse(readFileSync(stellaJson(), "utf8"))).toEqual({
      model: "anthropic/claude-sonnet-5",
      providers: { anthropic: { base_url: STELLA_URL } },
    });
    // Edited since: the objects apply created go with our value.
    const edited = JSON.parse(readFileSync(stellaJson(), "utf8"));
    edited.theme = "dark";
    writeFileSync(stellaJson(), `${JSON.stringify(edited, null, 2)}\n`);
    await restoreModelBaseUrls(stella(), internals());
    expect(JSON.parse(readFileSync(stellaJson(), "utf8"))).toEqual({
      model: "anthropic/claude-sonnet-5",
      theme: "dark",
    });
  });

  it("creates stella.toml when Stella has no config, and removes it again", async () => {
    await applyModelBaseUrls(stella(), internals());
    expect(readFileSync(stellaToml(), "utf8")).toBe(
      `[providers.anthropic]\nbase_url = "${STELLA_URL}"\n`,
    );
    await restoreModelBaseUrls(stella(), internals());
    expect(existsSync(stellaToml())).toBe(false);
  });

  it("honours STELLA_HOME", async () => {
    const stellaHome = join(home, "elsewhere");
    await applyModelBaseUrls({ ...stella(), stellaHome }, internals());
    expect(existsSync(join(stellaHome, "stella.toml"))).toBe(true);
    expect(existsSync(stellaToml())).toBe(false);
  });

  it("reports a managed Stella setting that shadows ours", async () => {
    const managed = join(home, "managed-stella.toml");
    writeFileSync(
      managed,
      '[providers.anthropic]\nbase_url = "https://pinned.example"\n',
    );
    const state = await applyModelBaseUrls(stella(), {
      ...internals(),
      stellaManagedSettingsFile: managed,
    });
    expect(state.harnesses[0]!.ours).toBe(true);
    expect(state.harnesses[0]!.shadowedBy).toEqual({
      file: managed,
      value: "https://pinned.example",
    });
  });
});
