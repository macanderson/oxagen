/**
 * Install and uninstall, proven against a snapshot. A scratch HOME is seeded
 * with a real user's pre-existing state, the tree is snapshotted (paths,
 * modes, content hashes, link targets), and then:
 *
 *   enroll -> everything expected exists and the service unit is valid
 *   enroll again -> nothing duplicated, not one byte moved
 *   unenroll --purge -> the tree is byte-identical to the snapshot
 *   unenroll again -> a clean no-op
 *
 * plus the failure variants: malformed settings, a read-only file, a
 * symlinked settings file, an offline revoke, and the process dying at each
 * step. Nothing here reaches the real home directory or a real service
 * manager; see `install-rig.ts`.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexHookPresence } from "../host/codex-writer";
import { claudeDesktopPresence } from "../host/claude-desktop-writer";
import { readHostFile } from "../host/host-file";
import { tachoHookPresence } from "../host/settings-writer";
import { readStellaHooksFile, stellaHookPresence } from "../host/stella-writer";
import { TEST_ENROLLMENT } from "../host/test-support";
import type { TachoHarness } from "../wire";
import { enroll } from "./enroll";
import {
  buildRig,
  diffTrees,
  EMPTY_DIFF,
  type KillPoint,
  RIG_GATEWAY_PORT,
  RigKill,
  seedHome,
  snapshotTree,
  USER_CLAUDE_SETTINGS,
} from "./install-rig";
import { status } from "./status";
import { unenroll } from "./unenroll";

const ALL: TachoHarness[] = [
  "claude-code",
  "codex",
  "cursor",
  "stella",
  "claude-desktop",
];

/**
 * What `unenroll --purge` may leave behind, and why. Empty on purpose: a
 * purge that confirmed its revoke leaves nothing. The one documented
 * exception is asserted where it happens (an offline revoke keeps
 * `host.json` so the revoke can be finished later).
 */
const PURGE_ALLOWLIST: string[] = [];

/** What a plain `unenroll` keeps: the local event record, for inspection. */
const KEEP_ALLOWLIST = [
  ".config/oxagen/tacho/wal",
  ".config/oxagen/tacho/spool",
  ".config/oxagen/tacho/quarantine",
  ".config/oxagen/tacho/tachod.log",
];

function text(home: string, ...parts: string[]): string {
  return readFileSync(join(home, ...parts), "utf8");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("install rig: macOS, every harness", () => {
  it("installs, re-installs without a duplicate, and uninstalls to a byte-identical tree", async () => {
    const seed = seedHome();
    const before = snapshotTree(seed.home);
    const rig = buildRig(seed);

    const first = await enroll({ harnesses: ALL }, rig.deps);
    expect(first.ok).toBe(true);

    // Everything expected exists, and the service unit is valid.
    const host = readHostFile(rig.deps.paths.hostFile);
    expect(host?.host_enrollment_id).toBe(TEST_ENROLLMENT);
    expect(host?.revoked_at).toBeNull();
    const plistPath = join(
      seed.home,
      "Library",
      "LaunchAgents",
      "sh.oxagen.tachod.plist",
    );
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain("<string>sh.oxagen.tachod</string>");
    expect(plist).toContain(`${rig.deps.runtime.daemonCommand[0]}</string>`);
    expect(plist).toContain("<string>daemon</string>");
    expect(rig.serviceLoaded()).toBe(true);
    expect(
      tachoHookPresence(rig.deps.readSettings(), TEST_ENROLLMENT).missing,
    ).toEqual([]);
    expect(
      codexHookPresence(rig.deps.readCodexHooks(), TEST_ENROLLMENT).missing,
    ).toEqual([]);
    expect(
      stellaHookPresence(readStellaHooksFile(rig.deps.paths), TEST_ENROLLMENT)
        .missing,
    ).toEqual([]);
    expect(
      claudeDesktopPresence(rig.deps.readClaudeDesktopConfig(), TEST_ENROLLMENT)
        .present,
    ).toBe(true);
    // The user's own entries survived the merge.
    const settings = rig.deps.readSettings() as {
      model: string;
      env: Record<string, string>;
      hooks: { PreToolUse: Array<{ hooks: Array<{ command?: string }> }> };
    };
    expect(settings.model).toBe("opus");
    expect(settings.env["MY_TEAM_PROXY"]).toBe(
      "http://proxy.corp.example:8080",
    );
    expect(
      settings.hooks.PreToolUse.some((g) =>
        g.hooks.some((h) => h.command === "~/bin/audit-bash.sh"),
      ),
    ).toBe(true);
    // Their own `oxagen` on PATH is not ours to touch.
    expect(text(seed.home, ".local", "bin", "oxagen")).toContain(
      "my own oxagen",
    );

    // Install again: idempotent, no duplicates, not one byte moved.
    const afterFirst = snapshotTree(seed.home);
    const second = await enroll({ harnesses: ALL }, rig.deps);
    expect(second.ok).toBe(true);
    expect(diffTrees(afterFirst, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
    expect(
      countOccurrences(
        text(seed.home, ".stella", "stella.toml"),
        ">>> tacho enrollment",
      ),
    ).toBe(1);
    expect(
      rig.requests.filter((r) => r.url.endsWith("/tacho/enrollments")),
    ).toHaveLength(1);

    // Uninstall: byte-identical to the snapshot.
    const removed = await unenroll({ purge: true }, rig.deps);
    expect(removed.ok).toBe(true);
    expect(removed.revoked).toBe(true);
    expect(rig.serviceLoaded()).toBe(false);
    expect(diffTrees(before, snapshotTree(seed.home), PURGE_ALLOWLIST)).toEqual(
      EMPTY_DIFF,
    );

    // Uninstall again: a clean no-op.
    const again = await unenroll({ purge: true }, rig.deps);
    expect(again.ok).toBe(true);
    expect(again.warnings).toEqual([]);
    expect(diffTrees(before, snapshotTree(seed.home), PURGE_ALLOWLIST)).toEqual(
      EMPTY_DIFF,
    );
  });

  it("without --purge keeps only the local event record", async () => {
    const seed = seedHome();
    const before = snapshotTree(seed.home);
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ALL }, rig.deps)).ok).toBe(true);
    expect((await unenroll({}, rig.deps)).ok).toBe(true);
    const diff = diffTrees(before, snapshotTree(seed.home), KEEP_ALLOWLIST);
    // The tacho root itself stays, because the record under it does.
    expect(diff.added.filter((p) => p !== ".config/oxagen/tacho")).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("uninstall without install changes nothing", async () => {
    const seed = seedHome();
    const before = snapshotTree(seed.home);
    const rig = buildRig(seed);
    const result = await unenroll({ purge: true }, rig.deps);
    expect(result.ok).toBe(true);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });

  it("creates nothing it does not remove on a machine with no harness files at all", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    // A machine where none of the harness files exist yet.
    rmSync(join(seed.home, ".claude"), { recursive: true });
    rmSync(join(seed.home, ".codex"), { recursive: true });
    rmSync(join(seed.home, ".cursor"), { recursive: true });
    rmSync(join(seed.home, ".stella"), { recursive: true });
    rmSync(join(seed.home, "Library", "Application Support"), {
      recursive: true,
    });
    const before = snapshotTree(seed.home);
    expect((await enroll({ harnesses: ALL }, rig.deps)).ok).toBe(true);
    expect(existsSync(rig.deps.paths.claudeSettings)).toBe(true);
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });

  it("gives back a Cursor hooks file whose only member is the user's own version", async () => {
    // The narrow case between the two Cursor files the rig otherwise covers:
    // not one Tacho created, and not one carrying the user's hooks, but a
    // started-and-left `{"version": 1}`. It is byte for byte what Tacho's own
    // leftover looks like after a strip, so anything that reads the leftover
    // by its shape reads this as the leftover too and empties a file the user
    // wrote. Only the receipt tells them apart.
    const seed = seedHome();
    writeFileSync(join(seed.home, ".cursor", "hooks.json"), '{"version": 1}\n');
    const before = snapshotTree(seed.home);
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ALL }, rig.deps)).ok).toBe(true);
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });

  it("keeps a hook the user added to the Cursor file enrollment created", async () => {
    // The other half of the receipt that lets a purge take back a file Tacho
    // made. The teardown writes the stripped document through
    // `HarnessFiles.write`, so those bytes are by definition the bytes Tacho
    // wrote last — and a hook the user added while enrolled is inside them.
    // Deleting on that digest alone would take their hook with the file, out
    // of their home directory. Only `cursorDocumentIsVestigial` saying the
    // strip left nothing but our own `version` may delete it, and here it
    // cannot say that.
    const seed = seedHome();
    rmSync(join(seed.home, ".cursor"), { recursive: true });
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ["cursor"] }, rig.deps)).ok).toBe(true);
    const path = rig.deps.paths.cursorHooks[0] as string;
    expect(existsSync(path)).toBe(true);
    // They add one of their own to the file enrollment created for them.
    const live = JSON.parse(readFileSync(path, "utf8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    live.hooks["afterFileEdit"] = [{ command: "~/bin/my-own-hook.sh" }];
    writeFileSync(path, `${JSON.stringify(live, null, 2)}\n`);
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    // Their hook and their file are still there; every Tacho entry is gone.
    expect(existsSync(path)).toBe(true);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("~/bin/my-own-hook.sh");
    expect(after).not.toContain(TEST_ENROLLMENT);
    expect(after).not.toContain("tacho");
  });

  it("keeps the Cursor file when the operator pinned their own schema version", async () => {
    // The third form of the same loss. `mergeCursorHooks` writes `version`
    // only when the document has none, deliberately, so an operator who pinned
    // a future schema version keeps it. The purge then read "one key, and it is
    // `version`" as its own scaffolding and deleted the file with their pin in
    // it. Tacho can only take back the value Tacho wrote.
    const seed = seedHome();
    rmSync(join(seed.home, ".cursor"), { recursive: true });
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ["cursor"] }, rig.deps)).ok).toBe(true);
    const path = rig.deps.paths.cursorHooks[0] as string;
    const live = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      hooks: Record<string, unknown>;
    };
    expect(live.version).toBe(1);
    // They pin a schema version of their own while enrolled.
    live.version = 2;
    writeFileSync(path, `${JSON.stringify(live, null, 2)}\n`);

    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);

    expect(existsSync(path)).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
    };
    expect(after.version).toBe(2);
    expect(readFileSync(path, "utf8")).not.toContain(TEST_ENROLLMENT);
  });

  it("writes through a symlinked settings file and leaves the link a link", async () => {
    const seed = seedHome({ symlinkedClaudeSettings: true });
    const before = snapshotTree(seed.home);
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    expect(lstatSync(rig.deps.paths.claudeSettings).isSymbolicLink()).toBe(
      true,
    );
    // The dotfiles copy is the one that carries the hooks.
    expect(text(seed.home, "dotfiles", "claude-settings.json")).toContain(
      TEST_ENROLLMENT,
    );
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });

  it("keeps the user's later edits and still removes every Tacho entry", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    // The user changes their own settings while enrolled.
    const live = JSON.parse(text(seed.home, ".claude", "settings.json")) as {
      model: string;
    };
    live.model = "sonnet";
    writeFileSync(rig.deps.paths.claudeSettings, JSON.stringify(live, null, 4));
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    const after = text(seed.home, ".claude", "settings.json");
    expect(after).not.toContain(TEST_ENROLLMENT);
    expect(after).not.toContain("TACHO_");
    const parsed = JSON.parse(after) as Record<string, unknown>;
    const original = JSON.parse(USER_CLAUDE_SETTINGS) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ ...original, model: "sonnet" });
    // The user's mode comes back even when their bytes cannot.
    expect(lstatSync(rig.deps.paths.claudeSettings).mode & 0o777).toBe(0o644);
  });
});

describe("install rig: the gateway's model base URLs", () => {
  const CLAUDE_URL = `http://127.0.0.1:${RIG_GATEWAY_PORT}/anthropic`;
  const CODEX_URL = `http://127.0.0.1:${RIG_GATEWAY_PORT}/backend-api/codex`;

  it("are written once the model proxy is listening, and come back out byte for byte", async () => {
    const seed = seedHome();
    const before = snapshotTree(seed.home);
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ALL }, rig.deps)).ok).toBe(true);
    const settings = rig.deps.readSettings() as { env: Record<string, string> };
    expect(settings.env["ANTHROPIC_BASE_URL"]).toBe(CLAUDE_URL);
    // Without this Claude Code inlines its whole MCP catalog behind the
    // proxy, and a large one overflows the context before the first prompt.
    expect(settings.env["ENABLE_TOOL_SEARCH"]).toBe("true");
    expect(text(seed.home, ".codex", "config.toml")).toContain(CODEX_URL);
    // The user's own Codex config is otherwise as they wrote it.
    expect(text(seed.home, ".codex", "config.toml")).toContain(
      "# my codex config",
    );
    // Again: nothing moves.
    const enrolled = snapshotTree(seed.home);
    expect((await enroll({ harnesses: ALL }, rig.deps)).ok).toBe(true);
    expect(diffTrees(enrolled, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
    const report = await status({ json: true }, rig.deps);
    expect(report.modelBaseUrls?.map((h) => [h.harness, h.ours])).toEqual([
      ["claude-code", true],
      ["codex", true],
    ]);
    expect(report.modelBaseUrls?.[0]?.toolSearch).toEqual({
      current: "true",
      enabled: true,
    });
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });

  it("are never written while the proxy is not listening: a base URL on a dead port stops the agent", async () => {
    const seed = seedHome();
    const before = snapshotTree(seed.home);
    const rig = buildRig(seed, { gatewayListening: false });
    const result = await enroll({ harnesses: ALL }, rig.deps);
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/model proxy is not listening/);
    expect(text(seed.home, ".claude", "settings.json")).not.toContain(
      "ANTHROPIC_BASE_URL",
    );
    expect(text(seed.home, ".codex", "config.toml")).not.toContain(
      "openai_base_url",
    );
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });

  it("are restored before the daemon is stopped", async () => {
    const seed = seedHome();
    let urlPresentAtBootout: boolean | undefined;
    const rig = buildRig(seed, {
      onExec: (command, args) => {
        if (command === "launchctl" && args[0] === "bootout")
          urlPresentAtBootout = text(
            seed.home,
            ".claude",
            "settings.json",
          ).includes("ANTHROPIC_BASE_URL");
      },
    });
    expect((await enroll({ harnesses: ALL }, rig.deps)).ok).toBe(true);
    urlPresentAtBootout = undefined;
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    expect(urlPresentAtBootout).toBe(false);
  });

  it("survive a reassign-style strip and still restore the first original", async () => {
    const seed = seedHome({ symlinkedClaudeSettings: true });
    const before = snapshotTree(seed.home);
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ALL }, rig.deps)).ok).toBe(true);
    expect((await enroll({ harnesses: ALL, force: true }, rig.deps)).ok).toBe(
      true,
    );
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });
});

describe("install rig: Linux, systemd", () => {
  it("round-trips to a byte-identical tree", async () => {
    const seed = seedHome({ platform: "linux" });
    const before = snapshotTree(seed.home);
    const rig = buildRig(seed);
    const harnesses: TachoHarness[] = ["claude-code", "codex", "stella"];
    expect((await enroll({ harnesses }, rig.deps)).ok).toBe(true);
    const unit = text(
      seed.home,
      ".config",
      "systemd",
      "user",
      "tachod.service",
    );
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain('"daemon"');
    expect(rig.serviceLoaded()).toBe(true);
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    expect(rig.serviceLoaded()).toBe(false);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });
});

describe("install rig: failure injection", () => {
  it("refuses a malformed settings file before anything is minted or written", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    writeFileSync(rig.deps.paths.claudeSettings, '{ "model": "opus", ');
    const before = snapshotTree(seed.home);
    const result = await enroll({ harnesses: ALL }, rig.deps);
    expect(result.ok).toBe(false);
    expect(rig.errors.join("\n")).toContain(rig.deps.paths.claudeSettings);
    // Nothing was enrolled on the control plane, nothing was installed.
    expect(rig.requests).toEqual([]);
    expect(rig.serviceLoaded()).toBe(false);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });

  it("preserves the gateway until broken settings can be restored on retry", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ALL }, rig.deps)).ok).toBe(true);
    const enrolledSettings = readFileSync(
      rig.deps.paths.claudeSettings,
      "utf8",
    );
    const retainedHost = readFileSync(rig.deps.paths.hostFile, "utf8");
    const retainedKey = readFileSync(rig.deps.paths.deviceKey);
    const broken = '{ "hooks": ';
    writeFileSync(rig.deps.paths.claudeSettings, broken);
    const result = await unenroll({ purge: true }, rig.deps);
    // It says it did not finish, and names the file it could not clean.
    expect(result.ok).toBe(false);
    expect(result.warnings.join("\n")).toContain(rig.deps.paths.claudeSettings);
    // The file it could not parse is exactly as the user left it.
    expect(text(seed.home, ".claude", "settings.json")).toBe(broken);
    // Keep the gateway and credentials while a harness may still depend on them.
    expect(rig.serviceLoaded()).toBe(true);
    expect(result.revoked).toBe(false);
    expect(readFileSync(rig.deps.paths.hostFile, "utf8")).toBe(retainedHost);
    expect(readFileSync(rig.deps.paths.deviceKey)).toEqual(retainedKey);
    expect(text(seed.home, ".codex", "hooks.json")).toContain(TEST_ENROLLMENT);
    expect(text(seed.home, ".stella", "stella.toml")).toContain(
      TEST_ENROLLMENT,
    );
    writeFileSync(rig.deps.paths.claudeSettings, enrolledSettings);
    const retried = await unenroll({ purge: true }, rig.deps);
    expect(retried.ok).toBe(true);
    expect(retried.revoked).toBe(true);
    expect(rig.serviceLoaded()).toBe(false);
    expect(existsSync(rig.deps.paths.hostFile)).toBe(false);
    expect(existsSync(rig.deps.paths.deviceKey)).toBe(false);
    expect(text(seed.home, ".claude", "settings.json")).toBe(
      USER_CLAUDE_SETTINGS,
    );
  });

  it("leaves a read-only settings file alone and says the harness was not hooked", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    chmodSync(rig.deps.paths.claudeSettings, 0o444);
    const before = snapshotTree(seed.home);
    const result = await enroll({ harnesses: ["claude-code"] }, rig.deps);
    expect(result.ok).toBe(false);
    expect(text(seed.home, ".claude", "settings.json")).toBe(
      USER_CLAUDE_SETTINGS,
    );
    expect(lstatSync(rig.deps.paths.claudeSettings).mode & 0o777).toBe(0o444);
    // Recoverable: unenroll takes the rest back out.
    expect((await unenroll({ purge: true }, rig.deps)).ok).toBe(true);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });

  it("an offline unenroll keeps host.json, and only host.json, so the revoke can be finished", async () => {
    const seed = seedHome();
    const before = snapshotTree(seed.home);
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ALL }, rig.deps)).ok).toBe(true);
    rig.setOffline(true);
    const offline = await unenroll({ purge: true }, rig.deps);
    expect(offline.revoked).toBe(false);
    const diff = diffTrees(before, snapshotTree(seed.home));
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([
      ".config/oxagen/tacho",
      ".config/oxagen/tacho/host.json",
    ]);
    // status does not call a retired host enrolled.
    const report = await status({ json: true }, rig.deps);
    expect(report.enrolled).toBe(false);
    // Back online, the second unenroll finishes the revoke and the tree is clean.
    rig.setOffline(false);
    const finished = await unenroll({ purge: true }, rig.deps);
    expect(finished.revoked).toBe(true);
    expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
  });

  // The process dies at each step of enroll. Whatever is left must be
  // removable (unenroll returns the tree to the snapshot) and resumable
  // (enroll run again completes, with nothing duplicated).
  const KILL_POINTS: KillPoint[] = [
    "fetch",
    "launchctl bootstrap",
    "readCodexHooks",
    "readStellaHooks",
    "writeClaudeDesktopConfig",
    "daemonGet",
  ];
  /** Enroll on a rig that dies at `killAt`; it must not report success. */
  async function dieAt(seed: ReturnType<typeof seedHome>, killAt: KillPoint) {
    const dying = buildRig(seed, { killAt });
    const outcome = await enroll({ harnesses: ALL }, dying.deps).then(
      (result) => result,
      (error: unknown) => error,
    );
    if (!(outcome instanceof RigKill))
      expect((outcome as { ok: boolean }).ok).toBe(false);
  }
  for (const killAt of KILL_POINTS) {
    it(`killed at ${killAt}: removable, then resumable`, async () => {
      const seed = seedHome();
      const before = snapshotTree(seed.home);

      // Removable.
      await dieAt(seed, killAt);
      const clean = buildRig(seed);
      const removed = await unenroll({ purge: true }, clean.deps);
      expect(removed.ok).toBe(true);
      expect(clean.serviceLoaded()).toBe(false);
      expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);

      // Resumable: die again, then finish with a plain enroll.
      await dieAt(seed, killAt);
      const resumed = buildRig(seed);
      const finished = await enroll({ harnesses: ALL }, resumed.deps);
      expect(finished.ok).toBe(true);
      expect(
        tachoHookPresence(resumed.deps.readSettings(), TEST_ENROLLMENT).missing,
      ).toEqual([]);
      expect(
        countOccurrences(
          text(seed.home, ".stella", "stella.toml"),
          ">>> tacho enrollment",
        ),
      ).toBe(1);
      expect((await unenroll({ purge: true }, resumed.deps)).ok).toBe(true);
      expect(diffTrees(before, snapshotTree(seed.home))).toEqual(EMPTY_DIFF);
    });
  }

  it("refuses a second enroll while one is running", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = buildRig(seed, {
      overrides: {
        fetch: async (url, init) => {
          await held;
          return rig.deps.fetch(url, init);
        },
      },
    });
    const first = enroll({ harnesses: ["claude-code"] }, slow.deps);
    // Let the first reach the control plane and park there.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await enroll({ harnesses: ["claude-code"] }, rig.deps);
    expect(second.ok).toBe(false);
    expect(rig.errors.join("\n")).toMatch(/another tacho/i);
    release();
    expect((await first).ok).toBe(true);
    expect(
      rig.requests.filter((r) => r.url.endsWith("/tacho/enrollments")),
    ).toHaveLength(1);
  });
});
