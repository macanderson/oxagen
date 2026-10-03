/**
 * A daemon running newer code than the enrollment that wrote its host.json
 * (#5365).
 *
 * Only a fresh enroll wrote `wrapper_version`, so a machine upgraded in place
 * kept reporting the version it enrolled with: on every event, in the health
 * report the control plane stores as `daemon_version`, and in its user agent.
 * The daemon now takes the version of the code that is running, and writes it
 * back to host.json.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readHostFile, writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { TACHO_VERSION } from "../version";
import { type DaemonHandle, startDaemon } from "./daemon";

const SESSION = "11111111-2222-3333-4444-555555555555";
const ENROLLED = "0.0.1-enrolled";

describe("a daemon upgraded in place", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    paths: ReturnType<typeof scratchPaths>,
    log: string[],
  ): Promise<DaemonHandle> {
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      now: () => 1_000,
      log: (line) => log.push(line),
      listen: false,
      transcriptRoots: [`${paths.tachoDir}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 60 * 60_000,
        checkpointMs: 60 * 60_000,
        commandsPollMs: 0,
      },
    });
    handles.push(handle);
    return handle;
  }

  it("names the running code, not the enrolled one", async () => {
    expect(TACHO_VERSION).not.toBe(ENROLLED);
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        wrapper_version: ENROLLED,
      }),
    );
    const log: string[] = [];
    const handle = await boot(paths, log);

    expect(handle.host().wrapper_version).toBe(TACHO_VERSION);
    expect(handle.api.health()["version"]).toBe(TACHO_VERSION);
    expect(readHostFile(paths.hostFile)?.wrapper_version).toBe(TACHO_VERSION);
    expect(
      log.some((line) =>
        line.includes(
          `host.json now records version ${TACHO_VERSION} (was ${ENROLLED})`,
        ),
      ),
    ).toBe(true);

    await handle.api.handleHook({
      payload: {
        session_id: SESSION,
        hook_event_name: "SessionStart",
        cwd: "/repo",
      },
      env: {},
    });
    await handle.tick();
    const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;
    const events = handle.wal.read(uuid);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events)
      expect(event.agent.wrapper_version).toBe(TACHO_VERSION);
  });

  it("leaves host.json alone when it already names the running code", async () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        wrapper_version: TACHO_VERSION,
      }),
    );
    const log: string[] = [];
    const handle = await boot(paths, log);

    expect(handle.host().wrapper_version).toBe(TACHO_VERSION);
    expect(log.some((line) => line.includes("host.json now records"))).toBe(
      false,
    );
  });

  it("does not write over host.json once it holds another enrollment", async () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(unsignedBundle());
    const running = testHostFile(signer, bundle, {
      wrapper_version: ENROLLED,
    });
    const next = testHostFile(signer, bundle, {
      host_enrollment_id: `${running.host_enrollment_id}-next`,
      wrapper_version: ENROLLED,
    });
    writeHostFile(paths.hostFile, next);
    const handle = await startDaemon({
      paths,
      host: running,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      now: () => 1_000,
      log: () => undefined,
      listen: false,
      transcriptRoots: [`${paths.tachoDir}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 60 * 60_000,
        checkpointMs: 60 * 60_000,
        commandsPollMs: 0,
      },
    });
    handles.push(handle);

    expect(handle.host().wrapper_version).toBe(TACHO_VERSION);
    const disk = readHostFile(paths.hostFile);
    expect(disk?.host_enrollment_id).toBe(next.host_enrollment_id);
    expect(disk?.wrapper_version).toBe(ENROLLED);
  });
});
