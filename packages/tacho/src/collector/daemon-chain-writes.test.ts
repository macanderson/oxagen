/**
 * The daemon's writers outside a hook take back only the chains they sealed
 * on (#4311). The detector and the operator's commands used to mark every
 * chain, wait (on a transcript scan, on a bundle fetch), and then take every
 * chain back when their write failed. A chain a hook wrote during that wait
 * went back behind frames the WAL held, and every later seal on it was
 * refused. A SessionEnd restored after a restart keeps its `hook_id`, so the
 * client's spooled copy of the same hook is recognized as a repeat.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyChain } from "../chain";
import type { TachoEvent } from "../envelope";
import type { FetchLike } from "../host/control-client";
import { readHostFile, writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { ControlEnvelope, DeliveredCommand } from "../wire";
import { type DaemonHandle, type DaemonTimers, startDaemon } from "./daemon";

const SESSION = "11111111-2222-3333-4444-555555555555";
const CWD = "/repo";
/** One hour: a pass that does not run in these tests unless they ask. */
const QUIET = 60 * 60_000;

function hook(name: string, extra: Record<string, unknown> = {}) {
  return {
    payload: {
      session_id: SESSION,
      hook_event_name: name,
      cwd: CWD,
      ...extra,
    },
    env: {},
  };
}

function command(overrides: Partial<DeliveredCommand>): DeliveredCommand {
  return {
    id: "cmd",
    command: "refresh_bundle",
    session_uuid: null,
    payload: {},
    requested_mode: null,
    delivery_mode: null,
    degraded_reason: null,
    reason: null,
    issued_at: "2026-10-03T10:00:00.000Z",
    expires_at: null,
    ...overrides,
  };
}

/**
 * A control plane that hands out the commands a test queues, and whose
 * bundle endpoint a test can hold, the way a slow fetch does, until it lets
 * the fetch answer. Its envelopes name the etag of the bundle the host holds,
 * so the daemon fetches only for a `refresh_bundle`.
 */
function fakePlane() {
  const queue: DeliveredCommand[] = [];
  let etag = "";
  let hold: Promise<void> | undefined;
  let held = 0;
  const control = (): ControlEnvelope => ({
    host_status: "active",
    deny_generation: { org: 1, workspace: 1 },
    bundle_etag: etag,
    commands: queue.splice(0),
  });
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    if (url.endsWith("/events")) {
      const events = body["events"] as TachoEvent[];
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            accepted: events.length,
            event_ids: events.map((event) => event.event_id_idem),
            chain_breaks: [],
            control: control(),
          }),
      };
    }
    if (url.endsWith("/bundle")) {
      if (hold !== undefined) {
        held += 1;
        await hold;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ not_modified: true, etag, bundle: null }),
      };
    }
    if (url.endsWith("/commands")) {
      const sent = body["acknowledgements"] as unknown[];
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ acknowledged: sent.length, control: control() }),
      };
    }
    return { ok: false, status: 404, text: async () => "nope" };
  };
  return {
    fetch,
    /** Name this etag in every envelope: the one the host's bundle carries. */
    announce: (value: string) => {
      etag = value;
    },
    queue: (delivered: DeliveredCommand) => queue.push(delivered),
    /** Hold every bundle request from now on; the returned call lets them answer. */
    holdBundle: (): (() => void) => {
      let release: () => void = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = undefined;
        release();
      };
    },
    /** How many bundle requests arrived while held. */
    bundleRequestsHeld: () => held,
  };
}

/** Refuse the WAL write of any batch holding a frame of `kind`. */
function refuseWrites(handle: DaemonHandle, kind: string): () => number {
  const append = handle.wal.append.bind(handle.wal);
  let refused = 0;
  vi.spyOn(handle.wal, "append").mockImplementation((events, bodies) => {
    if (events.some((event) => event.kind === kind)) {
      refused += 1;
      throw Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
    }
    append(events, bodies);
  });
  return () => refused;
}

/** The daemon's chain stands where its WAL ends, one seq past the tail. */
function expectHostChainOnTheWal(handle: DaemonHandle): void {
  const tail = handle.wal.lastEvent(handle.hostRecorder.sessionUuid);
  expect(tail).toBeDefined();
  expect(handle.hostRecorder.chainCursor).toEqual({
    seq: (tail?.seq ?? -1) + 1,
    prevHash: tail?.hash,
  });
}

describe("the daemon's writers outside a hook", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    options: {
      paths?: ReturnType<typeof scratchPaths>;
      fetch?: FetchLike;
      etag?: (etag: string) => void;
      timers?: Partial<DaemonTimers>;
    } = {},
  ): Promise<DaemonHandle> {
    const paths = options.paths ?? scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({
        permissions: { allow: ["Read"], deny: [], ask: [] },
      }),
    );
    const host = readHostFile(paths.hostFile) ?? testHostFile(signer, bundle);
    writeHostFile(paths.hostFile, host);
    options.etag?.(host.bundle.etag);
    const handle = await startDaemon({
      paths,
      fetch:
        options.fetch ??
        (async () => {
          throw new Error("ECONNREFUSED");
        }),
      // No repository here: every git probe fails, so a SessionEnd settles
      // on the first tick.
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      now: () => 1_000,
      listen: false,
      transcriptRoots: [`${paths.tachoDir}/no-transcripts`],
      timers: {
        detectorMs: QUIET,
        sweepMs: QUIET,
        checkpointMs: QUIET,
        ...options.timers,
      },
    });
    handles.push(handle);
    return handle;
  }

  it("takes back only the host chain when the detector's write fails, not a session a hook wrote during its scan", async () => {
    // No Claude Code settings on disk, so the detector's first pass seals
    // `oxagen:hooks_removed` on the host chain.
    const handle = await boot({ timers: { detectorMs: 0 } });
    await handle.api.handleHook(hook("SessionStart"));
    const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;

    // The detector awaits its transcript scan before it seals. The test holds
    // the pass at that await.
    const tick = handle.detector.tick.bind(handle.detector);
    let scanned: () => void = () => {};
    const scan = new Promise<void>((resolve) => {
      scanned = resolve;
    });
    let scanning = false;
    vi.spyOn(handle.detector, "tick").mockImplementationOnce(async (sink) => {
      scanning = true;
      await scan;
      return tick(sink);
    });
    const refused = refuseWrites(handle, "oxagen:hooks_removed");

    const ticking = handle.tick();
    await vi.waitFor(() => expect(scanning).toBe(true));
    // A hook on the session writes its chain while the scan runs.
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "again" }));
    scanned();
    await ticking;
    expect(refused()).toBe(1);

    // Taken back behind the prompt's frames, the session's next seal reused
    // their seq, and the WAL refused it.
    await handle.api.handleHook(hook("Stop"));
    expect(
      verifyChain(handle.wal.read(uuid), { expectGenesis: true }),
    ).toMatchObject({ ok: true });
    expectHostChainOnTheWal(handle);
  });

  it("takes back only the chains a command batch sealed on when its write fails after the bundle fetch", async () => {
    const plane = fakePlane();
    const handle = await boot({
      fetch: plane.fetch,
      etag: plane.announce,
      timers: { commandsPollMs: 0 },
    });
    await handle.api.handleHook(hook("SessionStart"));
    const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;
    const refused = refuseWrites(handle, "oxagen:command_applied");

    // A `refresh_bundle` is fetched before anything in its batch seals, and
    // the fetch can take 15 s. The test holds it.
    plane.queue(command({ id: "cmd_refresh" }));
    const release = plane.holdBundle();
    const ticking = handle.tick();
    await vi.waitFor(() => expect(plane.bundleRequestsHeld()).toBe(1));
    // A hook on the session writes its chain while the fetch waits.
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "again" }));
    release();
    await ticking;
    expect(refused()).toBe(1);

    // Taken back behind the prompt's frames, the session's next seal reused
    // their seq, and the WAL refused it.
    await handle.api.handleHook(hook("Stop"));
    expect(
      verifyChain(handle.wal.read(uuid), { expectGenesis: true }),
    ).toMatchObject({ ok: true });
    expectHostChainOnTheWal(handle);
  });

  it("keeps a deferred SessionEnd's hook_id across a restart, so the spooled copy is not sealed again", async () => {
    const paths = scratchPaths();
    const first = await boot({ paths });
    await first.api.handleHook(hook("SessionStart"));
    const uuid = first.registry.get(SESSION)!.recorder.sessionUuid;
    // The end waits for its final worktree read, and the daemon stops before
    // that read runs. The client's request timed out, so `tacho-hook` spooled
    // the same hook under the same id.
    await first.api.handleHook({
      ...hook("SessionEnd", { reason: "other" }),
      hook_id: "hook_session_end",
    });
    expect(first.registry.get(SESSION)?.sealed).toBe(false);
    await first.stop();
    handles.splice(handles.indexOf(first), 1);

    const second = await boot({ paths });
    await second.tick();
    await vi.waitFor(() =>
      expect(second.registry.get(SESSION)?.sealed).toBe(true),
    );
    const stops = () =>
      second.wal.read(uuid).filter((event) => event.kind === "agent_stop");
    expect(stops()).toHaveLength(1);
    const written = second.wal.read(uuid).length;

    await second.api.handleHook({
      ...hook("SessionEnd", { reason: "other" }),
      hook_id: "hook_session_end",
    });
    expect(stops()).toHaveLength(1);
    expect(second.wal.read(uuid)).toHaveLength(written);
  });
});
