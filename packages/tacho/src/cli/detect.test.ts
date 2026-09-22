import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tachoPaths } from "../host/paths";
import { type CliDeps, defaultCliDeps } from "./deps";
import { detect, type DetectedHarness } from "./detect";

/**
 * A deps object for an unenrolled machine with nothing installed. Each test
 * overrides the one probe it is about, so no test is answered by whatever the
 * machine running it happens to carry.
 */
function deps(overrides: Partial<CliDeps> = {}): {
  deps: CliDeps;
  lines: string[];
} {
  const home = mkdtempSync(join(tmpdir(), "tacho-detect-"));
  const env = { HOME: home, TACHO_HOME: join(home, "tacho") };
  const lines: string[] = [];
  return {
    lines,
    deps: defaultCliDeps({
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
      ...overrides,
    }),
  };
}

function cursorOf(harnesses: DetectedHarness[]): DetectedHarness {
  const entry = harnesses.find((h) => h.harness === "cursor");
  if (entry === undefined) throw new Error("no Cursor entry in the report");
  return entry;
}

describe("detect", () => {
  it("reports the Cursor editor as installed when the CLI alias is absent", () => {
    const { deps: d, lines } = deps({
      cursor: () => ({
        app: { installed: true, path: "/Applications/Cursor.app" },
      }),
    });
    const cursor = cursorOf(detect({}, d).harnesses);
    expect(cursor.installed).toBe(true);
    expect(cursor.foundVia).toBe("app");
    expect(cursor.path).toBe("/Applications/Cursor.app");
    expect(cursor.version).toBeUndefined();
    expect(
      lines.some((line) => line.includes("/Applications/Cursor.app")),
    ).toBe(true);
  });

  it("reports the CLI alias when it answers, with its version", () => {
    const { deps: d } = deps({
      cursor: () => ({
        path: "/usr/local/bin/cursor-agent",
        version: "2.0.1",
        app: { installed: true, path: "/Applications/Cursor.app" },
      }),
    });
    const cursor = cursorOf(detect({}, d).harnesses);
    expect(cursor.foundVia).toBe("cli");
    expect(cursor.path).toBe("/usr/local/bin/cursor-agent");
    expect(cursor.version).toBe("2.0.1");
  });

  it("says Cursor is coverable when neither signal answered", () => {
    const { deps: d, lines } = deps();
    const cursor = cursorOf(detect({}, d).harnesses);
    expect(cursor.installed).toBe(false);
    expect(cursor.foundVia).toBeUndefined();
    expect(cursor.coverableWhenAbsent).toContain("~/.cursor/hooks.json");
    expect(
      lines.some(
        (line) => line.startsWith("Cursor") && line.includes("hooks.json"),
      ),
    ).toBe(true);
  });

  it("marks no other harness coverable while it is absent", () => {
    const { deps: d } = deps();
    const others = detect({}, d).harnesses.filter(
      (h) => h.harness !== "cursor",
    );
    expect(others.every((h) => h.coverableWhenAbsent === undefined)).toBe(true);
  });
});
