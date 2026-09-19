/**
 * The daemon's side of frame bodies: the bundle's retention clause decides
 * whether a body reaches the WAL at all, the shipper sends the bodies of a
 * batch with that batch, and a body the control plane refuses is said so in
 * the log. Kept apart from daemon.test.ts, whose fake control plane accepts
 * events and never looks at bodies.
 */
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes, digestJcs } from "../digest";
import type { TachoEvent } from "../envelope";
import type { FetchLike } from "../host/control-client";
import { writeSensitiveFileAtomic } from "../host/fs";
import { writeHostFile } from "../host/host-file";
import { mergeTachoSettings } from "../host/settings-writer";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { PolicyBundle, TachoBody } from "../wire";
import { type DaemonHandle, startDaemon } from "./daemon";

interface Batch {
  events: TachoEvent[];
  bodies: TachoBody[] | undefined;
}

/** What the control plane answers a proxied `tools/call` with. */
const MCP_RESULT = { content: [{ type: "text", text: "42 nodes" }] };
const MCP_ARGUMENTS = { q: "MATCH (n) RETURN count(n)", limit: 10 };

/** What the fake control plane answers a bundle poll with. */
interface BundleAnswer {
  ok: boolean;
  status: number;
  payload: unknown;
}

/** The default: the etag in force is still the current one. */
const BUNDLE_UNCHANGED: BundleAnswer = {
  ok: true,
  status: 200,
  payload: { not_modified: true, etag: "etag-3", bundle: null },
};

/** A control plane that records every batch and refuses the bodies it is told to. */
function plane(
  refuse: (body: TachoBody) => string | undefined = () => undefined,
  bundleAnswer: () => BundleAnswer = () => BUNDLE_UNCHANGED,
) {
  const batches: Batch[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    const control = {
      host_status: "active",
      deny_generation: { org: 1, workspace: 1 },
      bundle_etag: "etag-3",
      commands: [],
    };
    if (url.endsWith("/events")) {
      const events = body["events"] as TachoEvent[];
      const bodies = body["bodies"] as TachoBody[] | undefined;
      batches.push({ events, bodies });
      const rejections = (bodies ?? []).flatMap((b) => {
        const reason = refuse(b);
        return reason === undefined
          ? []
          : [{ event_id_idem: b.event_id_idem, reason }];
      });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            accepted: events.length,
            event_ids: events.map((e) => e.event_id_idem),
            chain_breaks: [],
            body_rejections: rejections,
            control,
          }),
      };
    }
    if (url.endsWith("/bundle")) {
      const answer = bundleAnswer();
      return {
        ok: answer.ok,
        status: answer.status,
        text: async () => JSON.stringify(answer.payload),
      };
    }
    if (url.endsWith("/mcp")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: (body as { id?: unknown }).id ?? null,
            result: MCP_RESULT,
          }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ acknowledged: 0, control }),
    };
  };
  return { fetch, batches };
}

function post(port: number, token: string, body: unknown) {
  return new Promise<number>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/hook",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

describe("tachod and frame bodies", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    fetch: FetchLike,
    retention: PolicyBundle["retention"],
    now?: () => number,
  ) {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(unsignedBundle({ retention }));
    const host = testHostFile(signer, bundle);
    writeHostFile(paths.hostFile, host);
    writeSensitiveFileAtomic(
      paths.claudeSettings,
      JSON.stringify(
        mergeTachoSettings(
          {},
          {
            enrollmentId: TEST_ENROLLMENT,
            hookCommand: "x",
            port: 1,
            localToken: host.local_token,
          },
        ).settings,
      ),
    );
    const log: string[] = [];
    const handle = await startDaemon({
      paths,
      fetch,
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => log.push(line),
      port: 0,
      transcriptRoots: [paths.root],
      timers: { detectorMs: 0, sweepMs: 0, checkpointMs: 0, commandsPollMs: 0 },
      ...(now !== undefined ? { now } : {}),
    });
    handles.push(handle);
    return { handle, host, log, signer, paths };
  }

  const session = "sess-bodies-1";
  async function runSession(port: number, token: string) {
    expect(
      await post(port, token, {
        session_id: session,
        hook_event_name: "SessionStart",
        cwd: "/repo",
      }),
    ).toBe(200);
    expect(
      await post(port, token, {
        session_id: session,
        hook_event_name: "UserPromptSubmit",
        prompt: "Read README.md, then stop.",
      }),
    ).toBe(200);
    expect(
      await post(port, token, {
        session_id: session,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/repo/README.md" },
        tool_use_id: "toolu_1",
      }),
    ).toBe(200);
    expect(
      await post(port, token, {
        session_id: session,
        hook_event_name: "SessionEnd",
        reason: "other",
      }),
    ).toBe(200);
  }

  it("ships the bodies the bundle retains, each with its own event", async () => {
    const { fetch, batches } = plane();
    const { handle, host } = await boot(fetch, {
      mode: "content_exact",
      classes: ["model_call", "tool_call"],
    });
    await runSession(handle.port as number, host.local_token);
    await handle.tick();
    const shipped = batches.flatMap((b) => b.bodies ?? []);
    expect(shipped.length).toBe(2);
    const events = new Map(
      batches
        .flatMap((b) => b.events)
        .map((e) => [e.event_id_idem, e] as const),
    );
    for (const batch of batches) {
      const inBatch = new Set(batch.events.map((e) => e.event_id_idem));
      for (const body of batch.bodies ?? [])
        expect(inBatch.has(body.event_id_idem)).toBe(true);
    }
    const prompt = shipped.find(
      (b) => events.get(b.event_id_idem)?.kind === "turn_start",
    );
    const bytes = Buffer.from(prompt?.bytes_base64 ?? "", "base64");
    expect(bytes.toString("utf8")).toBe("Read README.md, then stop.");
    expect(events.get(prompt?.event_id_idem ?? "")?.content?.digest).toBe(
      digestBytes(new Uint8Array(bytes)),
    );
    expect(
      shipped.some(
        (b) => events.get(b.event_id_idem)?.kind === "tool_requested",
      ),
    ).toBe(true);
  });

  it("ships no body under digest_only retention, and none of a class the bundle leaves out", async () => {
    const digestOnly = plane();
    const a = await boot(digestOnly.fetch, {
      mode: "digest_only",
      classes: [],
    });
    await runSession(a.handle.port as number, a.host.local_token);
    await a.handle.tick();
    expect(digestOnly.batches.length).toBeGreaterThan(0);
    expect(digestOnly.batches.every((b) => b.bodies === undefined)).toBe(true);
    // The digests are still on the chain: only the bytes stayed home.
    expect(
      digestOnly.batches
        .flatMap((b) => b.events)
        .some(
          (e) => e.kind === "turn_start" && e.content?.digest !== undefined,
        ),
    ).toBe(true);

    const toolsOnly = plane();
    const b = await boot(toolsOnly.fetch, {
      mode: "content_exact",
      classes: ["tool_call"],
    });
    await runSession(b.handle.port as number, b.host.local_token);
    await b.handle.tick();
    const events = new Map(
      toolsOnly.batches
        .flatMap((x) => x.events)
        .map((e) => [e.event_id_idem, e] as const),
    );
    const kinds = toolsOnly.batches
      .flatMap((x) => x.bodies ?? [])
      .map((body) => events.get(body.event_id_idem)?.kind);
    expect(kinds).toEqual(["tool_requested"]);
  });

  it("files a gateway tool call's arguments and result as the frame's body", async () => {
    const { fetch, batches } = plane();
    const { handle } = await boot(fetch, {
      mode: "content_exact",
      classes: ["tool_call"],
    });
    const answer = await handle.api.mcp?.(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "query_ontology", arguments: MCP_ARGUMENTS },
      },
      { sessionId: "mcp-sess-1" },
    );
    expect(answer?.status).toBe(200);
    await handle.tick();

    const events = batches.flatMap((b) => b.events);
    const frame = events.find((event) => event.kind === "tool_call");
    expect(frame?.body).toMatchObject({
      tool_name: "query_ontology",
      tool_input_digest: digestJcs(MCP_ARGUMENTS),
      tool_output_digest: digestJcs(MCP_RESULT),
    });

    const body = batches
      .flatMap((b) => b.bodies ?? [])
      .find((b) => b.event_id_idem === frame?.event_id_idem);
    const bytes = Buffer.from(body?.bytes_base64 ?? "", "base64");
    // One body holds both halves, so the step replays without reaching back to
    // another frame for what was asked.
    expect(JSON.parse(bytes.toString("utf8"))).toEqual({
      input: MCP_ARGUMENTS,
      output: MCP_RESULT,
    });
    expect(frame?.content?.digest).toBe(digestBytes(new Uint8Array(bytes)));
  });

  it("logs a body the control plane refused, the way it logs a chain break", async () => {
    const { fetch } = plane(() => "digest_mismatch");
    const { handle, host, log } = await boot(fetch, {
      mode: "content_exact",
      classes: ["model_call"],
    });
    await runSession(handle.port as number, host.local_token);
    await handle.tick();
    expect(
      log.some((line) =>
        /control plane refused body for evt_[0-9a-f]{64}: digest_mismatch/.test(
          line,
        ),
      ),
    ).toBe(true);
    // The events were accepted regardless: nothing is left to ship.
    expect(handle.wal.stats().unshipped).toBe(0);
  });

  it("does not transmit a queued body once the mandate has narrowed", async () => {
    // The leak: a body reaches the WAL under `content_exact`, the workspace
    // narrows to `digest_only` while the control plane is out of reach, and
    // the drain sends what is queued. The control plane refusing it is too
    // late — the prompt has already left the machine, which is the one thing
    // the retention boundary exists to prevent.
    const narrowed: { bundle?: PolicyBundle } = {};
    const { fetch, batches } = plane(
      () => undefined,
      () =>
        narrowed.bundle === undefined
          ? BUNDLE_UNCHANGED
          : {
              ok: true,
              status: 200,
              payload: {
                not_modified: false,
                etag: narrowed.bundle.etag,
                bundle: narrowed.bundle,
              },
            },
    );
    const { handle, host, signer } = await boot(fetch, {
      mode: "content_exact",
      classes: ["model_call", "tool_call"],
    });
    await runSession(handle.port as number, host.local_token);
    // Queued, not shipped: the bodies are sitting in the WAL.
    expect(handle.wal.stats().unshipped).toBeGreaterThan(0);
    narrowed.bundle = signer.sign(
      unsignedBundle({
        version: 4,
        etag: "etag-4",
        retention: { mode: "digest_only", classes: [] },
      }),
    );
    await handle.tick();
    expect(batches.flatMap((b) => b.bodies ?? [])).toEqual([]);
    // The events still ship, digests and all: only the bytes stayed home.
    expect(
      batches
        .flatMap((b) => b.events)
        .some(
          (e) => e.kind === "turn_start" && e.content?.digest !== undefined,
        ),
    ).toBe(true);
    expect(handle.wal.stats().unshipped).toBe(0);
  });

  it("withholds a queued body when the mandate can no longer be established", async () => {
    // Narrowing is not the only way the answer changes. A cached mandate that
    // has outlived its signed window, with a control plane that cannot
    // confirm it, is authority for nothing: sending the body then would be
    // sending it under a mandate nobody can prove, so the bytes stay home
    // until one can be.
    const clock = { at: Date.parse("2026-09-15T00:00:00.000Z") };
    const { fetch, batches } = plane(
      () => undefined,
      () => ({ ok: false, status: 503, payload: { error: "unavailable" } }),
    );
    const { handle, host } = await boot(
      fetch,
      { mode: "content_exact", classes: ["model_call", "tool_call"] },
      () => clock.at,
    );
    await runSession(handle.port as number, host.local_token);
    expect(handle.wal.stats().unshipped).toBeGreaterThan(0);
    // Past the signed window, and the poll that would renew it fails.
    clock.at = Date.parse("2027-10-01T00:00:00.000Z");
    await handle.tick();
    expect(batches.flatMap((b) => b.bodies ?? [])).toEqual([]);
    expect(batches.flatMap((b) => b.events).length).toBeGreaterThan(0);
    expect(handle.wal.stats().unshipped).toBe(0);
  });

  /**
   * The body file of the one agent session this WAL holds. The WAL files a
   * session under its tacho `session_uuid`, not under the harness id the hook
   * posts, and the daemon's own chain is a session too, so the agent's is the
   * one with a body file beside it.
   */
  function bodyFileOf(walDir: string, handle: DaemonHandle): string {
    const found = handle.wal
      .sessions()
      .map((uuid) => join(walDir, `${uuid}.bodies.jsonl`))
      .filter((path) => existsSync(path));
    expect(found.length).toBe(1);
    return found[0] as string;
  }

  /** Every hook of `runSession` but the one that seals: this session stays live. */
  async function runLiveSession(port: number, token: string) {
    expect(
      await post(port, token, {
        session_id: session,
        hook_event_name: "SessionStart",
        cwd: "/repo",
      }),
    ).toBe(200);
    expect(
      await post(port, token, {
        session_id: session,
        hook_event_name: "UserPromptSubmit",
        prompt: "Read README.md, then stop.",
      }),
    ).toBe(200);
    expect(
      await post(port, token, {
        session_id: session,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/repo/README.md" },
        tool_use_id: "toolu_1",
      }),
    ).toBe(200);
  }

  const PROMPT_BASE64 = Buffer.from("Read README.md, then stop.").toString(
    "base64",
  );

  it("erases queued bodies from the WAL when the mandate narrows, on a session that never seals", async () => {
    // The finding: the shipper stopped transmitting these bytes, and the bytes
    // stayed on disk. `Wal.compact` removes a body file only once its session
    // is sealed, fully shipped, and past the retention window, so a live or
    // abandoned session kept the raw prompt with no bound at all.
    const narrowed: { bundle?: PolicyBundle } = {};
    const { fetch, batches } = plane(
      () => undefined,
      () =>
        narrowed.bundle === undefined
          ? BUNDLE_UNCHANGED
          : {
              ok: true,
              status: 200,
              payload: {
                not_modified: false,
                etag: narrowed.bundle.etag,
                bundle: narrowed.bundle,
              },
            },
    );
    const { handle, host, log, signer, paths } = await boot(fetch, {
      mode: "content_exact",
      classes: ["model_call", "tool_call"],
    });
    await runLiveSession(handle.port as number, host.local_token);
    const bodyPath = bodyFileOf(paths.wal, handle);
    expect(readFileSync(bodyPath, "utf8")).toContain(PROMPT_BASE64);
    // Nothing sealed this session, so compaction would never remove the bytes.
    expect(handle.wal.compact(Date.now() + 365 * 24 * 60 * 60_000, 0)).toEqual(
      [],
    );

    narrowed.bundle = signer.sign(
      unsignedBundle({
        version: 4,
        etag: "etag-4",
        retention: { mode: "digest_only", classes: [] },
      }),
    );
    await handle.tick();

    expect(readFileSync(bodyPath, "utf8")).not.toContain(PROMPT_BASE64);
    expect(log.some((line) => line.startsWith("mandate narrowed ("))).toBe(
      true,
    );
    // The events still seal and ship, digests and all: only the bytes went.
    expect(batches.flatMap((b) => b.bodies ?? [])).toEqual([]);
    expect(
      batches
        .flatMap((b) => b.events)
        .some(
          (e) => e.kind === "turn_start" && e.content?.digest !== undefined,
        ),
    ).toBe(true);
    expect(handle.wal.stats().unshipped).toBe(0);
  });

  it("keeps queued bodies through a mandate it cannot establish, and ships them once it can", async () => {
    // Withholding and erasing are different triggers, and this is why. A
    // cached mandate that has outlived its signed window, with a control plane
    // that cannot confirm it, is authority for nothing, so the shipper sends
    // nothing (the test above). It is not a narrowing: one poll can confirm
    // the same clause again, and the bytes have to still be there when it
    // does.
    const clock = { at: Date.parse("2026-09-15T00:00:00.000Z") };
    const unavailable: BundleAnswer = {
      ok: false,
      status: 503,
      payload: { error: "unavailable" },
    };
    const answer = { current: unavailable };
    const { fetch, batches } = plane(
      () => undefined,
      () => answer.current,
    );
    const { handle, host, log, paths } = await boot(
      fetch,
      { mode: "content_exact", classes: ["model_call", "tool_call"] },
      () => clock.at,
    );
    await runLiveSession(handle.port as number, host.local_token);
    const walBodyPath = bodyFileOf(paths.wal, handle);

    // Past the signed window, and the poll that would renew it fails.
    clock.at = Date.parse("2027-10-01T00:00:00.000Z");
    await handle.refreshBundle();
    expect(readFileSync(walBodyPath, "utf8")).toContain(PROMPT_BASE64);
    expect(log.some((line) => line.startsWith("mandate narrowed ("))).toBe(
      false,
    );

    // The lapse passes: one poll confirms the same clause, and the bodies it
    // covers are still there to ship.
    answer.current = BUNDLE_UNCHANGED;
    await handle.tick();
    expect(
      batches
        .flatMap((b) => b.bodies ?? [])
        .map((b) => Buffer.from(b.bytes_base64, "base64").toString("utf8")),
    ).toContain("Read README.md, then stop.");
  });
});
