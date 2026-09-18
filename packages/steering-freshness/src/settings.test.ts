import { describe, expect, it } from "vitest";
import { loadSteeringSettings } from "./settings";

/** A fake `readFile` over a path → contents table. */
function fakeRead(files: Record<string, string>) {
  return (async (path: unknown) => {
    const key = String(path);
    if (!(key in files)) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return files[key]!;
  }) as unknown as typeof import("node:fs/promises").readFile;
}

const ROOT = "/repo";
const PROJECT = "/repo/.oxagen/settings.json";
const LOCAL = "/repo/.oxagen/settings.local.json";
const USER = "/home/dev/settings.json";

describe("loadSteeringSettings", () => {
  it("returns no layers when nothing is on disk", async () => {
    const { layers, warnings } = await loadSteeringSettings({
      projectRoot: ROOT,
      userSettingsPath: USER,
      read: fakeRead({}),
    });
    expect(layers).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("reads the steering block from each scope, lowest first", async () => {
    const { layers } = await loadSteeringSettings({
      projectRoot: ROOT,
      userSettingsPath: USER,
      read: fakeRead({
        [USER]: JSON.stringify({ steering: { remote: "upstream" } }),
        [PROJECT]: JSON.stringify({ steering: { blockStaleRuns: true } }),
        [LOCAL]: JSON.stringify({ steering: { autoSync: true } }),
      }),
    });
    expect(layers.map((l) => l.scope)).toEqual(["user", "project", "local"]);
  });

  it("puts the workspace policy last, above every file", async () => {
    const { layers } = await loadSteeringSettings({
      projectRoot: ROOT,
      userSettingsPath: USER,
      read: fakeRead({ [PROJECT]: JSON.stringify({ steering: {} }) }),
      workspacePolicy: { blockStaleRuns: true },
    });
    expect(layers.at(-1)?.scope).toBe("workspace");
  });

  it("ignores a settings file with no steering block", async () => {
    const { layers, warnings } = await loadSteeringSettings({
      projectRoot: ROOT,
      userSettingsPath: USER,
      read: fakeRead({ [PROJECT]: JSON.stringify({ mcpServers: {} }) }),
    });
    expect(layers).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // The two "report it, never swallow it, never make it fatal" cases.
  it("warns about a file that is not JSON, and carries on", async () => {
    const { layers, warnings } = await loadSteeringSettings({
      projectRoot: ROOT,
      userSettingsPath: USER,
      read: fakeRead({
        [PROJECT]: "{ this is not json",
        [LOCAL]: JSON.stringify({ steering: { autoSync: true } }),
      }),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.scope).toBe("project");
    expect(warnings[0]!.message).toContain("not valid JSON");
    expect(layers.map((l) => l.scope)).toEqual(["local"]);
  });

  it("warns about an invalid steering block and names the field", async () => {
    const { layers, warnings } = await loadSteeringSettings({
      projectRoot: ROOT,
      userSettingsPath: USER,
      read: fakeRead({
        [PROJECT]: JSON.stringify({ steering: { blockStaleRuns: "yes" } }),
      }),
    });
    expect(layers).toEqual([]);
    expect(warnings[0]!.message).toContain("blockStaleRuns");
  });

  it("warns, rather than throws, when a file cannot be read at all", async () => {
    const read = (async () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }) as unknown as typeof import("node:fs/promises").readFile;
    const { warnings } = await loadSteeringSettings({
      projectRoot: ROOT,
      userSettingsPath: USER,
      read,
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]!.message).toContain("EACCES");
  });
});
