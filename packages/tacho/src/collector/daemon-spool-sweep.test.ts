/**
 * The sweep must not seal a session while the spool still holds its hooks.
 *
 * On 2026-09-24 a daemon came back from a 34-minute outage and its first
 * drain stopped on a transient failure for another session. The sweep ran
 * right after it in the same tick and sealed a session whose pid was gone,
 * as `crashed`. The next drain replayed two of that session's prompts from
 * the spool, and they landed after its `agent_stop` (#4111).
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHostFile, writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";

/** The session the sweep would close: its harness process is gone. */
const ENDED = "11111111-2222-3333-4444-555555555555";
/** Another session, whose spooled hook the drain fails on. */
const OTHER = "66666666-7777-8888-9999-000000000000";
/** A pid no process holds. */
const DEAD_PID = "2147483647";
const CWD = "/repo";

function payload(
  sessionId: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  return { session_id: sessionId, hook_event_name: name, cwd: CWD, ...extra };
}

function prompt(sessionId: string, text: string) {
  return payload(sessionId, "UserPromptSubmit", { prompt: text });
}

function spool(
  paths: ReturnType<typeof scratchPaths>,
  name: string,
  body: Record<string, unknown>,
): void {
  mkdirSync(paths.spool, { recursive: true });
  writeFileSync(
    join(paths.spool, `${name}.json`),
    JSON.stringify({
      schema: "tacho.spool.v1",
      received_at: new Date(1_000).toISOString(),
      hook_id: name,
      payload: body,
      env: {},
    }),
  );
}

function spooled(paths: ReturnType<typeof scratchPaths>): string[] {
  return readdirSync(paths.spool).filter((name) => name.endsWith(".json"));
}

describe("the sweep and the spool", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    paths: ReturnType<typeof scratchPaths>,
  ): Promise<DaemonHandle> {
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({
        permissions: { allow: ["Read"], deny: [], ask: [] },
      }),
    );
    writeHostFile(
      paths.hostFile,
      readHostFile(paths.hostFile) ?? testHostFile(signer, bundle),
    );
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      now: () => 5_000,
      log: () => undefined,
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 0,
        checkpointMs: 60 * 60_000,
        commandsPollMs: 0,
      },
    });
    handles.push(handle);
    return handle;
  }

  /** A daemon holding `ENDED`, started live by a process that has exited. */
  async function withEndedSession(paths: ReturnType<typeof scratchPaths>) {
    const handle = await boot(paths);
    await handle.api.handleHook({
      payload: payload(ENDED, "SessionStart", { source: "startup" }),
      env: { CLAUDE_PID: DEAD_PID },
    });
    return handle;
  }

  /** Refuse the first WAL appends that open a turn, as a full disk would. */
  function refuseTurns(handle: DaemonHandle, count = 1): void {
    const append = handle.wal.append.bind(handle.wal);
    let refusals = count;
    handle.wal.append = (events, bodies) => {
      if (refusals > 0 && events.some((event) => event.kind === "turn_start")) {
        refusals -= 1;
        throw new Error("ENOSPC: no space left on device");
      }
      append(events, bodies);
    };
  }

  function kindsOf(handle: DaemonHandle, sessionId: string): string[] {
    const uuid = handle.registry.get(sessionId)!.recorder.sessionUuid;
    return handle.wal.read(uuid).map((event) => event.kind);
  }

  it("seals a session only after the spool's hooks for it land", async () => {
    const paths = scratchPaths();
    const handle = await withEndedSession(paths);
    spool(paths, "01-other", prompt(OTHER, "a"));
    spool(paths, "02-ended", prompt(ENDED, "b"));
    spool(paths, "03-ended", payload(ENDED, "Stop"));
    refuseTurns(handle);

    // The drain stops at the other session's file, and the sweep runs.
    await handle.tick();
    expect(spooled(paths).sort()).toEqual([
      "01-other.json",
      "02-ended.json",
      "03-ended.json",
    ]);
    expect(handle.registry.get(ENDED)?.sealed).toBe(false);

    // The drain completes, and only then does the sweep close the session.
    await handle.tick();
    expect(spooled(paths)).toEqual([]);
    expect(handle.registry.get(ENDED)?.sealed).toBe(true);
    const kinds = kindsOf(handle, ENDED);
    expect(kinds).toContain("turn_start");
    expect(kinds.lastIndexOf("turn_start")).toBeLessThan(
      kinds.indexOf("agent_stop"),
    );
    expect(kinds.at(-1)).toBe("agent_stop");
  });

  it("holds the session whose own file the drain stopped at", async () => {
    const paths = scratchPaths();
    const handle = await withEndedSession(paths);
    spool(paths, "01-ended", prompt(ENDED, "a"));
    refuseTurns(handle);

    await handle.tick();
    expect(spooled(paths)).toEqual(["01-ended.json"]);
    expect(handle.registry.get(ENDED)?.sealed).toBe(false);

    await handle.tick();
    expect(handle.registry.get(ENDED)?.sealed).toBe(true);
    const kinds = kindsOf(handle, ENDED);
    expect(kinds.indexOf("turn_start")).toBeLessThan(
      kinds.indexOf("agent_stop"),
    );
  });

  it("stops holding a session once its file moves to spool/failed/", async () => {
    const paths = scratchPaths();
    const handle = await withEndedSession(paths);
    spool(paths, "01-other", prompt(OTHER, "a"));
    // A hook with no event name: the schema refuses it, so it can never
    // replay. A mistyped member no longer does, since the schema reads it
    // as absent (H-07).
    spool(paths, "02-ended", { session_id: ENDED, cwd: CWD });
    refuseTurns(handle);

    await handle.tick();
    expect(handle.registry.get(ENDED)?.sealed).toBe(false);

    await handle.tick();
    expect(existsSync(join(paths.spool, "failed", "02-ended.json"))).toBe(true);
    expect(spooled(paths)).toEqual([]);
    expect(handle.registry.get(ENDED)?.sealed).toBe(true);
  });

  it("holds every session while the spool has files the drain has not read", async () => {
    const paths = scratchPaths();
    const handle = await withEndedSession(paths);
    // One more file than a drain replays, all for another session, so the
    // session's own file is one the first drain never reads.
    for (let index = 0; index < 200; index += 1)
      spool(
        paths,
        `01-other-${String(index).padStart(3, "0")}`,
        payload(OTHER, "Notification", { message: `n${index}` }),
      );
    spool(paths, "02-ended", prompt(ENDED, "b"));

    await handle.tick();
    expect(spooled(paths)).toEqual(["02-ended.json"]);
    expect(handle.registry.get(ENDED)?.sealed).toBe(false);

    await handle.tick();
    expect(spooled(paths)).toEqual([]);
    expect(handle.registry.get(ENDED)?.sealed).toBe(true);
    const kinds = kindsOf(handle, ENDED);
    expect(kinds.indexOf("turn_start")).toBeLessThan(
      kinds.indexOf("agent_stop"),
    );
  });

  it("keeps holding a session across drains that stop at the same file", async () => {
    const paths = scratchPaths();
    const handle = await withEndedSession(paths);
    spool(paths, "01-other", prompt(OTHER, "a"));
    // A file that is not JSON names no session, and never replays.
    writeFileSync(join(paths.spool, "02-broken.json"), "{ not json");
    spool(paths, "03-ended", prompt(ENDED, "b"));
    refuseTurns(handle, 2);

    // Two drains stop at the first file. The second knows whose hooks the
    // later files hold from the first.
    await handle.tick();
    await handle.tick();
    expect(handle.registry.get(ENDED)?.sealed).toBe(false);
    expect(spooled(paths).sort()).toEqual([
      "01-other.json",
      "02-broken.json",
      "03-ended.json",
    ]);

    await handle.tick();
    expect(existsSync(join(paths.spool, "failed", "02-broken.json"))).toBe(
      true,
    );
    expect(spooled(paths)).toEqual([]);
    expect(handle.registry.get(ENDED)?.sealed).toBe(true);
    const kinds = kindsOf(handle, ENDED);
    expect(kinds.indexOf("turn_start")).toBeLessThan(
      kinds.indexOf("agent_stop"),
    );
  });
});
