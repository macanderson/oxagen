/**
 * `detect` on a host.json it cannot validate, and the mode of an export
 * written to a file.
 */
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tachoPaths } from "../host/paths";
import { Wal } from "../host/wal";
import { minimalSession } from "../test-helpers";
import { defaultCliDeps } from "./deps";
import { detect } from "./detect";
import { exportCommand } from "./export";

function deps() {
  const home = mkdtempSync(join(tmpdir(), "tacho-detect-export-"));
  const env = { HOME: home, TACHO_HOME: join(home, "tacho") };
  const lines: string[] = [];
  return defaultCliDeps({
    paths: tachoPaths(env, home, "darwin"),
    env,
    home,
    platform: "darwin",
    claude: () => ({}),
    codex: () => ({}),
    cursor: () => ({}),
    stella: () => ({}),
    claudeDesktop: () => ({ installed: false }),
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
}

describe("detect", () => {
  it("lists the apps when host.json is cut short or does not validate", () => {
    const d = deps();
    mkdirSync(d.paths.root, { recursive: true });
    for (const text of ['{"schema":', '{"schema":"tacho.host.v1"}']) {
      writeFileSync(d.paths.hostFile, text);
      const report = detect({}, d);
      expect(report.enrolled).toBe(false);
      expect(report.harnesses.every((h) => !h.enrolled)).toBe(true);
    }
  });
});

describe("export --out", () => {
  it("writes the file private to its owner", async () => {
    const d = deps();
    const events = minimalSession();
    new Wal(d.paths.wal).append(events);
    const out = join(d.paths.root, "session.ndjson");
    expect(
      await exportCommand(
        { session: events[0]?.session_uuid as string, out },
        d,
      ),
    ).toBe(true);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });
});
