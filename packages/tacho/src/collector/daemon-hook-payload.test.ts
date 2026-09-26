/**
 * The daemon's `/hook` route records a payload with a `null` member, and
 * keeps one it cannot file on any session in quarantine (H-07, audit #3944).
 * Claude Code's http telemetry hooks post here directly, and a schema refusal
 * was a 500 with a log line: the event was gone.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_QUARANTINED_HOOK_PAYLOADS,
  quarantineHookPayload,
} from "../claude-code/hook-client";
import { PAYLOAD_REPAIRS_ATTR } from "../claude-code/hooks";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";

const SESSION = "11111111-2222-3333-4444-555555555555";

describe("the daemon's hook route", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot() {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      log: () => {},
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 60 * 60_000,
        checkpointMs: 60 * 60_000,
        commandsPollMs: 0,
      },
    });
    handles.push(handle);
    return { handle, paths };
  }

  it("records an http hook whose tool_use_id and cwd are null, with the repair noted", async () => {
    const { handle } = await boot();
    await handle.api.handleHook({
      payload: { session_id: SESSION, hook_event_name: "SessionStart" },
    });
    await handle.api.handleHook({
      payload: {
        session_id: SESSION,
        hook_event_name: "PostToolUse",
        cwd: null,
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: null,
        tool_response: { stdout: "ok" },
      },
    });
    const uuid = handle.registry.get(SESSION)?.recorder.sessionUuid;
    expect(uuid).toBeDefined();
    const noted = handle.wal
      .read(uuid as string)
      .filter((event) =>
        (event.attrs[PAYLOAD_REPAIRS_ATTR] ?? "").includes(
          "tool_use_id: null, read as absent",
        ),
      );
    expect(noted.length).toBeGreaterThan(0);
  });

  it("keeps a payload with no session id in quarantine and still refuses it", async () => {
    const { handle, paths } = await boot();
    await expect(
      handle.api.handleHook({
        payload: { hook_event_name: "PostToolUse", tool_name: "Bash" },
      }),
    ).rejects.toThrow();
    const files = readdirSync(paths.quarantine).filter((name) =>
      name.endsWith(".hook-payload.json"),
    );
    expect(files).toHaveLength(1);
    const kept = JSON.parse(
      readFileSync(join(paths.quarantine, files[0] as string), "utf8"),
    ) as { reason: string; raw: string; harness: string };
    expect(kept.reason).toContain("session_id");
    expect(JSON.parse(kept.raw)).toEqual({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
    });
    expect(kept.harness).toBe("claude-code");
  });

  it("names the quarantine file with a fresh id when the request's hook_id is not a ULID", async () => {
    const { handle, paths } = await boot();
    await expect(
      handle.api.handleHook({
        hook_id: "../x",
        payload: { hook_event_name: "PostToolUse" },
      }),
    ).rejects.toThrow();
    const files = readdirSync(paths.quarantine);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.hook-payload\.json$/);
    // The request could not steer the write out of quarantine/.
    expect(existsSync(join(paths.root, "x.hook-payload.json"))).toBe(false);
    const kept = JSON.parse(
      readFileSync(join(paths.quarantine, files[0] as string), "utf8"),
    ) as { hook_id: string };
    expect(kept.hook_id).toBe("../x");
  });
});

describe("quarantineHookPayload", () => {
  const record = {
    hookId: "01J00000000000000000000000",
    receivedAt: "2026-09-25T00:00:00.000Z",
    reason: "payload is not a hook",
    rawText: "{}",
    label: { harness: "claude-code" },
  };

  it("keeps a ULID hook id as the file name", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "tacho-")), "quarantine");
    quarantineHookPayload(dir, record);
    expect(readdirSync(dir)).toEqual([`${record.hookId}.hook-payload.json`]);
  });

  it("writes nothing once the folder holds the most payloads it keeps", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "tacho-")), "quarantine");
    mkdirSync(dir);
    for (let i = 0; i < MAX_QUARANTINED_HOOK_PAYLOADS; i += 1)
      writeFileSync(join(dir, `held-${i}.hook-payload.json`), "{}");
    quarantineHookPayload(dir, record);
    expect(readdirSync(dir)).toHaveLength(MAX_QUARANTINED_HOOK_PAYLOADS);
    expect(existsSync(join(dir, `${record.hookId}.hook-payload.json`))).toBe(
      false,
    );
  });
});
