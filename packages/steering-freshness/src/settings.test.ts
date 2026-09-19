import { describe, expect, it } from "vitest";
import { loadCommittedProjectGates, loadSteeringSettings } from "./settings";
import { resolveSteeringPolicy } from "./policy";
import type { GitRunner } from "./git";

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

/** A fake git that answers `show <spec>` from a table and fails anything else. */
function fakeShow(blobs: Record<string, string>): {
  run: GitRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const run: GitRunner = async (args) => {
    calls.push(args.join(" "));
    const spec = args[1] ?? "";
    if (args[0] === "show" && spec in blobs) return blobs[spec]!;
    throw new Error(`fatal: path does not exist: ${spec}`);
  };
  return { run, calls };
}

const MAIN_SPEC = "refs/remotes/origin/main:.oxagen/settings.json";

describe("loadCommittedProjectGates", () => {
  // The defect: production committed `blockStaleRuns: true`, the developer
  // typed `false` into the working copy and committed nothing. The fold only
  // ever saw the `false`.
  it("keeps a gate production committed on when the working copy switches it off", async () => {
    const { layers } = await loadSteeringSettings({
      projectRoot: ROOT,
      userSettingsPath: USER,
      read: fakeRead({
        [PROJECT]: JSON.stringify({ steering: { blockStaleRuns: false } }),
      }),
    });
    expect(resolveSteeringPolicy(layers).blockStaleRuns).toBe(false);

    const { run } = fakeShow({
      [MAIN_SPEC]: JSON.stringify({ steering: { blockStaleRuns: true } }),
    });
    const committed = await loadCommittedProjectGates({
      cwd: ROOT,
      remote: "origin",
      branch: "main",
      run,
    });
    const policy = resolveSteeringPolicy([...layers, committed.layer!]);
    expect(policy.blockStaleRuns).toBe(true);
    expect(policy.sources.blockStaleRuns).toBe("project");
  });

  it("lets the working copy switch a gate on before production has it", async () => {
    const { run } = fakeShow({
      [MAIN_SPEC]: JSON.stringify({ steering: { blockStaleRuns: false } }),
    });
    const committed = await loadCommittedProjectGates({
      cwd: ROOT,
      remote: "origin",
      branch: "main",
      run,
    });
    const policy = resolveSteeringPolicy([
      { scope: "project", policy: { blockStaleRuns: true } },
      committed.layer!,
    ]);
    expect(policy.blockStaleRuns).toBe(true);
  });

  // The committed copy carries authority and nothing else. Its `remote` and
  // `branch` would otherwise overwrite the ones that located it.
  it("carries the two gates and drops every other key", async () => {
    const { run } = fakeShow({
      [MAIN_SPEC]: JSON.stringify({
        steering: {
          autoSync: true,
          remote: "elsewhere",
          branch: "other",
          fetchIntervalSeconds: 1,
          exclude: [".oxagen/rules"],
        },
      }),
    });
    const { layer } = await loadCommittedProjectGates({
      cwd: ROOT,
      remote: "origin",
      branch: "main",
      run,
    });
    expect(layer).toEqual({ scope: "project", policy: { autoSync: true } });
  });

  it("reads the remote's own default when no scope named a branch", async () => {
    const { run, calls } = fakeShow({});
    await loadCommittedProjectGates({
      cwd: ROOT,
      remote: "upstream",
      branch: null,
      run,
    });
    expect(calls).toEqual([
      "show refs/remotes/upstream/HEAD:.oxagen/settings.json",
    ]);
  });

  it("is no layer and no warning when production has no settings file", async () => {
    const { run } = fakeShow({});
    expect(
      await loadCommittedProjectGates({
        cwd: ROOT,
        remote: "origin",
        branch: "main",
        run,
      }),
    ).toEqual({ layer: null, warning: null });
  });

  it("reports a committed file that does not parse, naming the ref", async () => {
    const { run } = fakeShow({ [MAIN_SPEC]: "{ not json" });
    const { layer, warning } = await loadCommittedProjectGates({
      cwd: ROOT,
      remote: "origin",
      branch: "main",
      run,
    });
    expect(layer).toBeNull();
    expect(warning?.path).toBe(MAIN_SPEC);
    expect(warning?.message).toContain("not valid JSON");
  });

  // `remote` and `branch` can come from a personal settings file, and they
  // are about to be placed in a git argument.
  it("never hands git a ref name it would read as an option", async () => {
    const { run, calls } = fakeShow({});
    await loadCommittedProjectGates({
      cwd: ROOT,
      remote: "--upload-pack=x",
      branch: "main",
      run,
    });
    await loadCommittedProjectGates({
      cwd: ROOT,
      remote: "origin",
      branch: "-x",
      run,
    });
    expect(calls).toEqual([]);
  });
});
