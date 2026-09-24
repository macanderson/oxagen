/**
 * `HarnessFiles.settle` on a file the strip never reached, and a harness file
 * saved with a byte order mark.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessFiles } from "./harness-file";
import { TEST_ENROLLMENT } from "./test-support";

const scratch = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "tacho-harness-file-")));
const HOOKED = JSON.stringify({
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: `/opt/tacho/tacho hook --enrollment ${TEST_ENROLLMENT}`,
          },
        ],
      },
    ],
  },
});

describe("settle on a file that still carries Tacho's hooks", () => {
  it("fails the restore and keeps the receipt, the backup and the 0600", () => {
    const dir = scratch();
    const root = join(dir, "tacho");
    const files = new HarnessFiles(root);
    const path = join(dir, "settings.json");
    writeFileSync(path, '{"theme":"dark"}');
    chmodSync(path, 0o644);
    files.write(path, HOOKED);
    // Unenroll stripped some other path, so this one was never rewritten.
    const outcomes = files.settle();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.result).toBe("failed");
    expect(outcomes[0]?.reason).toContain("still carries Tacho's hooks");
    expect(readFileSync(path, "utf8")).toBe(HOOKED);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(join(root, "install-receipts.json"))).toBe(true);
    // The retry that does reach the file gives the original back.
    files.write(path, '{\n  "theme": "dark"\n}\n');
    expect(files.settle()).toEqual([{ path, result: "restored" }]);
    expect(readFileSync(path, "utf8")).toBe('{"theme":"dark"}');
    expect(lstatSync(path).mode & 0o777).toBe(0o644);
    expect(existsSync(join(root, "install-receipts.json"))).toBe(false);
  });

  it("does not delete a file it created that still carries them", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, ".codex", "hooks.json");
    files.write(path, HOOKED);
    expect(files.settle()[0]?.result).toBe("failed");
    expect(readFileSync(path, "utf8")).toBe(HOOKED);
  });

  it("recognises an MCP args array and an HTTP hook URL as ours", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const desktop = join(dir, "claude_desktop_config.json");
    files.write(
      desktop,
      JSON.stringify(
        {
          mcpServers: {
            oxagen: {
              command: "/opt/tacho/tacho",
              args: ["mcp-stdio", "--enrollment", TEST_ENROLLMENT],
            },
          },
        },
        null,
        2,
      ),
    );
    const settings = join(dir, "settings.json");
    files.write(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "http",
                  url: `http://127.0.0.1:47001/hook/${TEST_ENROLLMENT}`,
                },
              ],
            },
          ],
        },
      }),
    );
    expect(files.settle().map((outcome) => outcome.result)).toEqual([
      "failed",
      "failed",
    ]);
  });

  it("keeps a user edit whose original already named an enrollment", () => {
    // Hooks the user carried in before this install are theirs to keep, and
    // must not wedge the file in a restore that can never succeed.
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, "settings.json");
    writeFileSync(path, HOOKED);
    files.write(path, `${HOOKED}\n`);
    files.write(path, JSON.stringify({ ...JSON.parse(HOOKED), mine: 1 }));
    expect(files.settle()[0]?.result).toBe("kept-user-edit");
  });
});

describe("a harness file with a byte order mark", () => {
  const BOM = "﻿";

  it("parses, keeps its mark through a write, and settles byte for byte", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, "settings.json");
    const original = `${BOM}{\r\n  "theme": "dark"\r\n}\r\n`;
    writeFileSync(path, original);
    expect(files.readJson(path)).toEqual({ theme: "dark" });
    files.write(path, `${JSON.stringify({ theme: "dark", ours: 1 })}\n`);
    expect(readFileSync(path, "utf8").startsWith(BOM)).toBe(true);
    expect(files.readJson(path)).toEqual({ theme: "dark", ours: 1 });
    files.write(path, `${JSON.stringify({ theme: "dark" })}\n`);
    expect(files.settle()).toEqual([{ path, result: "restored" }]);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("takes back a created file whose only content is the mark and braces", () => {
    const dir = scratch();
    const files = new HarnessFiles(join(dir, "tacho"));
    const path = join(dir, ".codex", "hooks.json");
    files.write(path, HOOKED);
    writeFileSync(path, `${BOM}{}`);
    expect(files.settle()[0]?.result).toBe("deleted");
  });
});
