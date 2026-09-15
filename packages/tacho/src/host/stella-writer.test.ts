/**
 * The Stella hooks writer: the TOML path appends and removes one managed
 * block byte-for-byte and refuses a file an appended table would break; the
 * JSON path merges groups like Codex with `timeoutMs`; the target rule picks
 * the file Stella actually reads.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeStellaHooks,
  readStellaHooksFile,
  renderStellaTomlBlock,
  STELLA_HOOK_EVENTS,
  STELLA_MAX_HOOK_TIMEOUT_MS,
  stellaHookEntries,
  stellaHookPresence,
  type StellaHooksFile,
  stellaTomlConflicts,
  stripStellaHooks,
  stripStellaTomlBlocks,
  tomlBasicString,
} from "./stella-writer";
import { TEST_ENROLLMENT } from "./test-support";

const CONFIG = {
  enrollmentId: TEST_ENROLLMENT,
  hookCommand: '"C:\\Program Files\\Oxagen\\tacho.exe" hook',
  port: 47001,
  localToken: "tok",
};

const OTHER = "tch_zyxwvutsrqpnmkjhgfedcb";

const USER_TOML = [
  "# my stella config",
  'model = "opus" # keep this comment',
  "",
  "[[hooks.PreToolUse]]",
  'matcher = "bash"',
  "[[hooks.PreToolUse.hooks]]",
  'type = "command"',
  'command = "guard.sh"',
  "",
].join("\n");

const toml = (text?: string): StellaHooksFile => ({
  path: "/h/.stella/stella.toml",
  format: "toml",
  text,
});

const json = (text?: string): StellaHooksFile => ({
  path: "/h/.stella/settings.json",
  format: "json",
  text,
});

function mergedText(file: StellaHooksFile, config = CONFIG): string {
  const result = mergeStellaHooks(file, config);
  if (!result.ok) throw new Error(result.error);
  return result.file.text ?? "";
}

describe("stella writer", () => {
  it("installs one command hook per Stella event with --harness stella and millisecond timeouts", () => {
    const entries = stellaHookEntries(CONFIG);
    expect(Object.keys(entries)).toEqual([...STELLA_HOOK_EVENTS]);
    const timeouts = Object.fromEntries(
      STELLA_HOOK_EVENTS.map((event) => [
        event,
        entries[event][0]?.hooks[0]?.["timeoutMs"],
      ]),
    );
    expect(timeouts).toEqual({
      SessionStart: 10_000,
      UserPromptSubmit: 10_000,
      PreToolUse: 15_000,
      PostToolUse: 5_000,
      Stop: 10_000,
      PreCompact: 5_000,
      SubagentStart: 5_000,
      SubagentStop: 5_000,
    });
    for (const event of STELLA_HOOK_EVENTS) {
      const hook = entries[event][0]?.hooks[0];
      expect(hook).toEqual({
        type: "command",
        command: `${CONFIG.hookCommand} --enrollment ${TEST_ENROLLMENT} --harness stella`,
        timeoutMs: timeouts[event],
      });
      expect(hook?.["timeoutMs"]).toBeLessThanOrEqual(
        STELLA_MAX_HOOK_TIMEOUT_MS,
      );
      // Claude Code's seconds field would be ignored by Stella.
      expect(hook).not.toHaveProperty("timeout");
    }
  });

  it("writes TOML basic strings Stella can parse", () => {
    expect(tomlBasicString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(tomlBasicString("tab\tnl\n\u007f")).toBe('"tab\\tnl\\n\\u007F"');
    const block = renderStellaTomlBlock(CONFIG);
    expect(block).toContain(
      `# >>> tacho enrollment ${TEST_ENROLLMENT} (managed by tacho; do not edit) >>>\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "\\"C:\\\\Program Files\\\\Oxagen\\\\tacho.exe\\" hook --enrollment ${TEST_ENROLLMENT} --harness stella"\ntimeoutMs = 10000\n`,
    );
    expect(
      block.endsWith(`# <<< tacho enrollment ${TEST_ENROLLMENT} <<<\n`),
    ).toBe(true);
    expect(renderStellaTomlBlock(CONFIG, "\r\n")).not.toMatch(/[^\r]\n/);
  });

  it("appends a managed block to stella.toml and strips it back byte-for-byte", () => {
    // A new file is the block alone.
    const fresh = mergeStellaHooks(toml(undefined), CONFIG);
    expect(fresh).toMatchObject({ ok: true, changed: true });
    expect(mergedText(toml(undefined))).toBe(renderStellaTomlBlock(CONFIG));
    expect(stripStellaTomlBlocks(mergedText(toml("")))).toBe("");

    // The operator's file, comments and hooks included, survives untouched.
    const merged = mergedText(toml(USER_TOML));
    expect(merged).toBe(`${USER_TOML}\n${renderStellaTomlBlock(CONFIG)}`);
    expect(stripStellaHooks(toml(merged), TEST_ENROLLMENT)).toEqual({
      file: toml(USER_TOML),
      changed: true,
    });
    // Merging again for the same enrollment replaces, never duplicates.
    expect(mergeStellaHooks(toml(merged), CONFIG)).toMatchObject({
      ok: true,
      changed: false,
    });
    // Another enrollment's block is foreign to this one.
    const both = mergedText(toml(merged), { ...CONFIG, enrollmentId: OTHER });
    const one = stripStellaHooks(toml(both), TEST_ENROLLMENT).file.text ?? "";
    expect(one).not.toContain(TEST_ENROLLMENT);
    expect(one).toContain(OTHER);
    expect(one.startsWith(USER_TOML)).toBe(true);
    expect(stripStellaHooks(toml(both)).file.text).toBe(USER_TOML);
    // Nothing to strip is not a change; an absent file strips to itself.
    expect(stripStellaHooks(toml(USER_TOML)).changed).toBe(false);
    expect(stripStellaHooks(toml(undefined))).toEqual({
      file: toml(undefined),
      changed: false,
    });

    // A file without a final newline, and a CRLF file, round-trip exactly.
    const bare = mergedText(toml("model = 1"));
    expect(bare.startsWith("model = 1\n# >>> tacho")).toBe(true);
    expect(stripStellaHooks(toml(bare)).file.text).toBe("model = 1");
    const crlf = mergedText(toml("a = 1\r\n"));
    expect(crlf).toBe(`a = 1\r\n\r\n${renderStellaTomlBlock(CONFIG, "\r\n")}`);
    expect(stripStellaHooks(toml(crlf)).file.text).toBe("a = 1\r\n");
    // Text the operator added after the block stays.
    const after = `${merged}extra = true\n`;
    expect(stripStellaHooks(toml(after)).file.text).toBe(
      `${USER_TOML}extra = true\n`,
    );
  });

  it("reports TOML presence from this enrollment's block", () => {
    expect(stellaHookPresence(toml(undefined), TEST_ENROLLMENT)).toEqual({
      complete: false,
      present: [],
      missing: [...STELLA_HOOK_EVENTS],
    });
    const merged = mergedText(toml(USER_TOML));
    expect(stellaHookPresence(toml(merged), TEST_ENROLLMENT)).toEqual({
      complete: true,
      present: [...STELLA_HOOK_EVENTS],
      missing: [],
    });
    expect(stellaHookPresence(toml(merged), OTHER).complete).toBe(false);
    // An operator who deleted two tables from the block sees them missing.
    const partial = merged
      .replace(/\[\[hooks\.Stop\]\]\n/, "")
      .replace(/\[\[hooks\.PreCompact\]\]\n/, "");
    const presence = stellaHookPresence(toml(partial), TEST_ENROLLMENT);
    expect(presence.complete).toBe(false);
    expect(presence.missing).toEqual(["Stop", "PreCompact"]);
  });

  it("refuses a stella.toml that defines a hook event as a key or a standard table", () => {
    const refused: Array<[string, string[]]> = [
      ["hooks.PreToolUse = []\n", ["PreToolUse"]],
      ["[hooks]\nStop = [{ hooks = [] }]\n", ["Stop"]],
      ["[hooks.SessionStart]\nfoo = 1\n", ["SessionStart"]],
      ["hooks = { }\n", [...STELLA_HOOK_EVENTS]],
      ['"hooks" . "PreCompact" = []\n', ["PreCompact"]],
      ["[ 'hooks' ]\nSubagentStop.x = 1\n", ["SubagentStop"]],
    ];
    for (const [text, events] of refused) {
      expect(stellaTomlConflicts(text)).toEqual(events);
      const result = mergeStellaHooks(toml(text), CONFIG);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(
          "/h/.stella/stella.toml already defines",
        );
        expect(result.error).toContain(`hooks.${events[0] ?? ""}`);
      }
    }
    const accepted = [
      USER_TOML,
      "[other]\nStop = 1\n",
      "# hooks.Stop = []\n",
      'note = """\nhooks.Stop = []\n"""\nafter = 1\n',
      "[[hooks.Stop]]\nmatcher = 'x'\n",
      "plain text that is not a key\n",
      renderStellaTomlBlock({ ...CONFIG, enrollmentId: OTHER }),
    ];
    for (const text of accepted) {
      expect(stellaTomlConflicts(text)).toEqual([]);
      expect(mergeStellaHooks(toml(text), CONFIG).ok).toBe(true);
    }
  });

  it("still refuses a conflict hidden behind a multi-line string, a comment, an array table or a child table", () => {
    // Every text below is a stella.toml that Python's tomllib rejects once
    // the managed block is appended (verified 2026-09-15), so a miss here
    // writes a file Stella cannot parse and stops every Stella session.
    const refused: Array<[string, string]> = [
      // The scanner must leave multi-line mode when the string closes.
      ['note = """\nhooks.PreToolUse = []\n"""\nhooks.Stop = []\n', "Stop"],
      ["note = '''\nx\n'''\nhooks.Stop = []\n", "Stop"],
      // A one-line triple-quoted string never opens multi-line mode.
      ['note = """x"""\nhooks.Stop = []\n', "Stop"],
      // A standard table after an array table is a static path again.
      ["[[hooks.PreToolUse]]\nmatcher = 'x'\n[hooks]\nStop = []\n", "Stop"],
      ["hooks.Stop = [] # trailing comment\n", "Stop"],
      ["[hooks.Stop] # header comment\na = 1\n", "Stop"],
      // A child table makes hooks.Stop a table an array cannot extend.
      ['[hooks.Stop.hooks]\ntype = "command"\n', "Stop"],
      ["[hooks.PreCompact.extra]\na = 1\n", "PreCompact"],
      // A child table with no key under it still defines hooks.Stop.
      ["[hooks.Stop.hooks]\n", "Stop"],
      // An array child with no [[hooks.Stop]] before it does too.
      ["[[hooks.Stop.hooks]]\n", "Stop"],
      // A parent that comes after its child is too late.
      ["[hooks.Stop.hooks]\n[[hooks.Stop]]\n", "Stop"],
    ];
    for (const [text, event] of refused) {
      expect(stellaTomlConflicts(text)).toEqual([event]);
      const result = mergeStellaHooks(toml(text), CONFIG);
      expect(result).toEqual({
        ok: false,
        error: `/h/.stella/stella.toml already defines hooks.${event} as a key or a [table], so the [[hooks.<Event>]] tables Tacho appends would be a duplicate key; move those hooks to [[hooks.<Event>]] array tables and enroll again`,
      });
    }
    // Text that only mentions a hook key inside a string is not a definition.
    expect(stellaTomlConflicts("note = 'hooks.Stop = []'\n")).toEqual([]);
  });

  it("accepts tables under an earlier [[hooks.<Event>]], which an appended element leaves valid", () => {
    // tomllib parses each of these with the managed block appended
    // (verified 2026-09-15): the child tables belong to the operator's own
    // array element, not to a static path.
    const compatible = [
      "[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = 'command'\ncommand = 'a'\n",
      "[[hooks.Stop]]\n[hooks.Stop.extra]\ny = 1\n",
      "[[hooks.Stop]]\n[other]\nz = 1\n[[hooks.Stop.hooks]]\ncommand = 'a'\n",
    ];
    for (const text of compatible) {
      expect(stellaTomlConflicts(text)).toEqual([]);
      const merged = mergedText(toml(text));
      expect(stripStellaHooks(toml(merged)).file.text).toBe(text);
    }
    // The owning parent is per event: [[hooks.Stop]] does not own PreCompact.
    expect(
      stellaTomlConflicts("[[hooks.Stop]]\n[hooks.PreCompact.extra]\n"),
    ).toEqual(["PreCompact"]);
  });

  it("merges, strips and reads presence in the legacy settings.json", () => {
    const foreign = {
      model: "opus",
      hooks: {
        PreToolUse: [
          {
            matcher: "bash",
            hooks: [{ type: "command", command: "guard.sh" }],
          },
        ],
      },
    };
    const text = `${JSON.stringify(foreign, null, 2)}\n`;
    const merged = mergeStellaHooks(json(text), CONFIG);
    expect(merged).toMatchObject({ ok: true, changed: true });
    if (!merged.ok) throw new Error(merged.error);
    const doc = JSON.parse(merged.file.text ?? "{}") as typeof foreign;
    expect(doc.model).toBe("opus");
    expect(doc.hooks.PreToolUse).toHaveLength(2);
    expect(doc.hooks.PreToolUse[1]?.hooks[0]).toMatchObject({
      timeoutMs: 15_000,
    });
    expect(stellaHookPresence(merged.file, TEST_ENROLLMENT).complete).toBe(
      true,
    );
    expect(mergeStellaHooks(merged.file, CONFIG)).toMatchObject({
      ok: true,
      changed: false,
    });
    const stripped = stripStellaHooks(merged.file, TEST_ENROLLMENT);
    expect(stripped.changed).toBe(true);
    expect(JSON.parse(stripped.file.text ?? "{}")).toEqual(foreign);
    expect(stripStellaHooks(stripped.file).changed).toBe(false);
    // A missing or empty file is created; junk is refused and left alone.
    expect(mergeStellaHooks(json(undefined), CONFIG)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(mergeStellaHooks(json("  "), CONFIG).ok).toBe(true);
    const junk = mergeStellaHooks(json("{ nope"), CONFIG);
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.error).toContain("is not valid JSON");
    expect(stripStellaHooks(json("{ nope"))).toEqual({
      file: json("{ nope"),
      changed: false,
    });
    expect(stellaHookPresence(json("{ nope"), TEST_ENROLLMENT).present).toEqual(
      [],
    );
  });

  it("reads the file Stella reads: stella.toml, else settings.json, else a new stella.toml", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-stella-"));
    const paths = {
      stellaToml: join(home, "stella.toml"),
      stellaSettingsJson: join(home, "settings.json"),
    };
    expect(readStellaHooksFile(paths)).toEqual({
      path: paths.stellaToml,
      format: "toml",
      text: undefined,
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(paths.stellaSettingsJson, "{}");
    expect(readStellaHooksFile(paths)).toEqual({
      path: paths.stellaSettingsJson,
      format: "json",
      text: "{}",
    });
    writeFileSync(paths.stellaToml, "a = 1\n");
    expect(readStellaHooksFile(paths)).toEqual({
      path: paths.stellaToml,
      format: "toml",
      text: "a = 1\n",
    });
    // An explicit format reads that file whatever the rule picks.
    expect(readStellaHooksFile(paths, "json").text).toBe("{}");
  });
});
