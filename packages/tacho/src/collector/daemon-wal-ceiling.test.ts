/**
 * The WAL ceiling, driven through the daemon (ADR-260, #3722).
 *
 * A control plane that answers 503 to every ingest leaves each batch on the
 * host, which is right, and the WAL grows for as long as that lasts. Past the
 * ceiling the daemon removes the stalled session's stored bodies, keeps its
 * events, and records the drop on its own chain.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { TachoEvent } from "../envelope";
import type { FetchLike } from "../host/control-client";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { readWalCeilingState, type WalCeilingPolicy } from "../host/wal-ceiling";
import { type DaemonHandle, startDaemon } from "./daemon";

const SESSION = "7d2a51c0-3b1e-4f6a-9c11-0a5e2f9b4c01";
const MINUTE = 60_000;
/** Inside the test bundle's signed window, so its retention clause holds. */
const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const CEILING = 256 * 1024;
/** One prompt's body is over 500 KiB on disk, twice the ceiling. */
const PROMPT = "x".repeat(400 * 1024);

function hook(name: string, extra: Record<string, unknown> = {}) {
  return {
    payload: {
      session_id: SESSION,
      hook_event_name: name,
      cwd: "/repo",
      ...extra,
    },
    env: {},
  };
}

/** A control plane whose store refuses every write, as #3662 answers it. */
function refusingPlane(): { fetch: FetchLike; ingests: () => number } {
  let ingests = 0;
  const fetch: FetchLike = async (url) => {
    if (url.endsWith("/events")) ingests += 1;
    return {
      ok: false,
      status: 503,
      text: async () =>
        JSON.stringify({
          error: { code: "store_overloaded", message: "store under pressure" },
        }),
    };
  };
  return { fetch, ingests: () => ingests };
}

/** A control plane that accepts every batch. */
function acceptingPlane(): FetchLike {
  const control = {
    host_status: "active",
    deny_generation: { org: 1, workspace: 1 },
    bundle_etag: "etag-3",
    commands: [],
  };
  return async (url, init) => {
    if (url.endsWith("/events")) {
      const events = (JSON.parse(init.body ?? "{}") as { events: TachoEvent[] })
        .events;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            accepted: events.length,
            event_ids: events.map((event) => event.event_id_idem),
            chain_breaks: [],
            body_rejections: [],
            control,
          }),
      };
    }
    if (url.endsWith("/bundle"))
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ not_modified: true, etag: "etag-3", bundle: null }),
      };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ acknowledged: 0, control }),
    };
  };
}

describe("the WAL ceiling in the daemon", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    fetch: FetchLike,
    clock: { at: number },
    walCeiling: Partial<WalCeilingPolicy>,
  ) {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({
        retention: {
          mode: "content_exact",
          classes: ["model_call", "tool_call"],
        },
      }),
    );
    writeHostFile(paths.hostFile, testHostFile(signer, bundle));
    const log: string[] = [];
    const handle = await startDaemon({
      paths,
      fetch,
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      now: () => clock.at,
      log: (line) => log.push(line),
      listen: false,
      transcriptRoots: [`${paths.tachoDir}/no-transcripts`],
      timers: {
        detectorMs: 60 * MINUTE,
        sweepMs: 60 * MINUTE,
        checkpointMs: 60 * MINUTE,
        commandsPollMs: 0,
      },
      walCeiling: { freeBytes: () => undefined, checkEveryMs: 0, ...walCeiling },
    });
    handles.push(handle);
    return { handle, paths, log };
  }

  it("removes a stalled session's bodies past the ceiling, keeps its chain whole, and records the drop", async () => {
    const plane = refusingPlane();
    const clock = { at: T0 };
    const { handle, paths, log } = await boot(plane.fetch, clock, {
      ceilingBytes: CEILING,
      stallGraceMs: 0,
    });
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: PROMPT }));
    const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;
    const bodyFile = join(paths.wal, `${uuid}.bodies.jsonl`);
    const bodyBytes = statSync(bodyFile).size;
    expect(bodyBytes).toBeGreaterThan(CEILING);
    const recorded = handle.wal.read(uuid);

    await handle.tick();

    // The ingest was tried and refused, so nothing shipped.
    expect(plane.ingests()).toBeGreaterThan(0);
    expect(handle.wal.shippedThrough(uuid)).toBe(-1);
    // The content went. Every event stayed, and the chain still verifies.
    // The tick's checkpoint adds a frame of its own after them.
    expect(existsSync(bodyFile)).toBe(false);
    expect(existsSync(join(paths.wal, `${uuid}.bodies.index`))).toBe(false);
    const chain = handle.wal.read(uuid);
    expect(chain.slice(0, recorded.length)).toEqual(recorded);
    expect(verifyChain(chain, { expectGenesis: true }).ok).toBe(true);

    // The daemon's own chain says what went, how much, and why.
    const daemonChain = handle.wal.read(handle.hostRecorder.sessionUuid);
    expect(verifyChain(daemonChain, { expectGenesis: true }).ok).toBe(true);
    const gap = daemonChain.find(
      (event) =>
        event.kind === "telemetry_gap" &&
        (event.body as Record<string, unknown>)["gap_cause"] === "wal_ceiling",
    );
    expect(gap?.body).toMatchObject({
      gap_cause: "wal_ceiling",
      incident_evidence: {
        session_uuid: uuid,
        bytes: bodyBytes,
        shipped_through: -1,
        ceiling_bytes: CEILING,
      },
    });
    expect(log.some((line) => line.startsWith("WAL ceiling: removed"))).toBe(
      true,
    );

    // The bound holds as the session keeps recording through the outage.
    clock.at += MINUTE;
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: PROMPT }));
    expect(existsSync(bodyFile)).toBe(true);
    await handle.tick();
    expect(existsSync(bodyFile)).toBe(false);
    expect(
      verifyChain(handle.wal.read(uuid), { expectGenesis: true }).ok,
    ).toBe(true);
    const state = readWalCeilingState(paths.wal);
    expect(state?.drops.map((drop) => drop.session_uuid)).toEqual([
      uuid,
      uuid,
    ]);
    expect(state?.stalled_bytes).toBeLessThanOrEqual(CEILING);
  });

  it("leaves a session that ships alone, however small the ceiling", async () => {
    const clock = { at: T0 };
    const { handle, paths } = await boot(acceptingPlane(), clock, {
      ceilingBytes: 1,
      stallGraceMs: 10 * MINUTE,
    });
    await handle.api.handleHook(hook("SessionStart"));
    await handle.api.handleHook(hook("UserPromptSubmit", { prompt: PROMPT }));
    const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;
    const bodyFile = join(paths.wal, `${uuid}.bodies.jsonl`);

    for (let step = 0; step < 4; step += 1) {
      await handle.tick();
      clock.at += 11 * MINUTE;
      await handle.api.handleHook(hook("UserPromptSubmit", { prompt: "go" }));
    }
    await handle.tick();

    expect(handle.wal.shippedThrough(uuid)).toBeGreaterThan(-1);
    expect(existsSync(bodyFile)).toBe(true);
    expect(readWalCeilingState(paths.wal)?.drops ?? []).toEqual([]);
  });
});
