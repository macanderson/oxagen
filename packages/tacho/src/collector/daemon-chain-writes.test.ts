/**
 * The daemon's writers outside a hook take back only the chains they sealed
 * on (#4311). The detector and the operator's commands used to mark every
 * chain, wait (on a transcript scan, on a bundle fetch), and then take every
 * chain back when their write failed. A chain a hook wrote during that wait
 * went back behind frames the WAL held, and every later seal on it was
 * refused. A SessionEnd restored after a restart keeps its `hook_id`, so the
 * client's spooled copy of the same hook is recognized as a repeat.
 *
 * An operator's command writes each frame in the stretch that seals it, a
 * session's on that session's queue. Sealed beside a hook that was waiting
 * between its seal and its write, the command took the seq after the hook's
 * frame and reached the WAL first. Sealed and written across an await, its
 * frame on the daemon's chain lost its seq to a writer that ran in between.
 * Either way the WAL refused the later write, and the chain broke.
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

  it("applies an operator's command to a session after a hook there writes what it sealed", async () => {
    const plane = fakePlane();
    const handle = await boot({
      fetch: plane.fetch,
      etag: plane.announce,
      timers: { commandsPollMs: 0 },
    });
    await handle.api.handleHook(hook("SessionStart"));
    const recorder = handle.registry.get(SESSION)!.recorder;
    const uuid = recorder.sessionUuid;
    const hostUuid = handle.hostRecorder.sessionUuid;

    // The `refresh_bundle` fetches before anything in the batch seals. The
    // test holds the fetch, so the hook below starts before the batch seals.
    plane.queue(command({ id: "cmd_refresh" }));
    plane.queue(
      command({ id: "cmd_pause", command: "pause", session_uuid: uuid }),
    );
    const release = plane.holdBundle();
    const ticking = handle.tick();
    await vi.waitFor(() => expect(plane.bundleRequestsHeld()).toBe(1));

    // A hook on the session's queue seals a frame and waits on its recalled
    // memories before it writes it.
    let recalled: () => void = () => {};
    const recall = new Promise<void>((resolve) => {
      recalled = resolve;
    });
    let hookFrame: TachoEvent | undefined;
    const hookWrite = handle.queues
      .session(SESSION, async () => {
        const sealed = recorder.sealCollectorEvent("oxagen:command_applied", {
          policy_decision: "allow",
          policy_source: "human",
        });
        hookFrame = sealed;
        await recall;
        handle.wal.append([sealed], recorder.takeBodies());
      })
      .then(
        () => "written",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
    await vi.waitFor(() => expect(hookFrame).toBeDefined());
    release();
    // The batch's frame on the daemon's chain lands, and the pause waits for
    // the hook.
    await vi.waitFor(() =>
      expect(
        handle.wal
          .read(hostUuid)
          .some((event) => event.attrs["command.id"] === "cmd_refresh"),
      ).toBe(true),
    );
    recalled();

    // Sealed beside the hook, the pause took the hook's seq + 1 and reached
    // the WAL first, and the hook's own write was refused.
    expect(await hookWrite).toBe("written");
    await ticking;
    const pause = handle.wal
      .read(uuid)
      .find((event) => event.attrs["command.id"] === "cmd_pause");
    expect(pause?.seq).toBe((hookFrame?.seq ?? -2) + 1);
    expect(pause?.prev_hash).toBe(hookFrame?.hash);
    expect(
      verifyChain(handle.wal.read(uuid), { expectGenesis: true }),
    ).toMatchObject({ ok: true });
    expect(handle.registry.get(SESSION)?.control.paused).not.toBeNull();
  });

  it("writes a command's frame on the daemon's chain in the stretch that seals it, so another writer there cannot take its seq", async () => {
    const plane = fakePlane();
    const handle = await boot({
      fetch: plane.fetch,
      etag: plane.announce,
      timers: { commandsPollMs: 0 },
    });
    const host = handle.hostRecorder;
    // Another writer of the daemon's chain, such as the model proxy refusing
    // a call no session was found for, seals and writes in one stretch. This
    // one runs at the first turn the event loop gives after the command's
    // seal.
    const seal = host.sealCollectorEvent.bind(host);
    const other: TachoEvent[] = [];
    vi.spyOn(host, "sealCollectorEvent").mockImplementation(
      (kind, body, fields) => {
        const event = seal(kind, body, fields);
        if (kind === "oxagen:command_applied" && other.length === 0)
          queueMicrotask(() => {
            const frame = seal("oxagen:hook_health", {
              hook_count: 0,
              hook_success: 0,
            });
            other.push(frame);
            handle.wal.append([frame]);
          });
        return event;
      },
    );
    plane.queue(command({ id: "cmd_refresh" }));
    await handle.tick();
    expect(other).toHaveLength(1);

    // Sealed, then written once `applyCommands` returned, the command's frame
    // came after the other writer's in the WAL, which refused it. The chain
    // went back behind the frame the other writer wrote.
    const written = handle.wal.read(host.sessionUuid);
    expect(
      written.some((event) => event.attrs["command.id"] === "cmd_refresh"),
    ).toBe(true);
    expect(written.at(-1)?.kind).toBe("oxagen:hook_health");
    expect(verifyChain(written, { expectGenesis: true })).toMatchObject({
      ok: true,
    });
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

  it("refuses a Claude Code backfill on an agent that does not hook Claude Code (#5390, negative)", async () => {
    // A Cursor-only agent would seal Claude Code's transcripts on its own
    // chains and ship them as its runs.
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        harnesses: ["cursor"],
      }),
    );
    const handle = await boot({ paths });
    const started = handle.api.startBackfill?.({});
    expect(started).toMatchObject({ status: 409 });
    expect(JSON.stringify(started)).toMatch(/does not hook Claude Code/);
  });
});
