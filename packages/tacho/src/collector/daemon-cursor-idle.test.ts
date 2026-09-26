/**
 * A Cursor session that closes without its `sessionEnd` is sealed after one
 * quiet hour, not six (#3989, #4322, ADR-141). A Cursor hook carries no
 * harness pid, so the idle bound is the only end the daemon can see. Other
 * sessions with no pid keep the six-hour bound.
 */
import { afterEach, describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, DEFAULT_TIMERS, startDaemon } from "./daemon";

const CURSOR = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CODEX = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
const HOUR = 60 * 60_000;

describe("the sweep's idle bound", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  it("is one hour for Cursor and stays six hours for a Codex session with no pid", async () => {
    expect(DEFAULT_TIMERS.cursorIdleSessionMs).toBe(HOUR);
    expect(DEFAULT_TIMERS.idleSessionMs).toBe(6 * HOUR);
    let clock = 1_800_000_000_000;
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
      now: () => clock,
      log: () => {},
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: {
        detectorMs: 24 * HOUR,
        sweepMs: 0,
        checkpointMs: 24 * HOUR,
        commandsPollMs: 0,
      },
    });
    handles.push(handle);
    const hook = (session: string, harness: "cursor" | "codex", name: string) =>
      handle.api.handleHook({
        payload: { session_id: session, hook_event_name: name, cwd: "/repo" },
        env: {},
        harness,
      });
    await hook(CURSOR, "cursor", "SessionStart");
    await hook(CODEX, "codex", "SessionStart");
    const cursor = handle.registry.get(CURSOR);
    const codex = handle.registry.get(CODEX);
    expect(cursor?.pid).toBeUndefined();
    expect(codex?.pid).toBeUndefined();

    // Fifty-nine quiet minutes: a long shell command is still running.
    clock += HOUR - 60_000;
    await handle.tick();
    expect(cursor?.sealed).toBe(false);

    clock += 2 * 60_000;
    await handle.tick();
    expect(cursor?.sealed).toBe(true);
    expect(codex?.sealed).toBe(false);

    // The person comes back: the next hook reopens the chain (ADR-172).
    await hook(CURSOR, "cursor", "UserPromptSubmit");
    expect(cursor?.sealed).toBe(false);
  });
});
