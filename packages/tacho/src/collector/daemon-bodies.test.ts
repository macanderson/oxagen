/**
 * The daemon's side of frame bodies: the bundle's retention clause decides
 * whether a body reaches the WAL at all, the shipper sends the bodies of a
 * batch with that batch, and a body the control plane refuses is said so in
 * the log. Kept apart from daemon.test.ts, whose fake control plane accepts
 * events and never looks at bodies.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestBytes, digestJcs } from "../digest";
import type { TachoEvent } from "../envelope";
import type { FetchLike } from "../host/control-client";
import { writeSensitiveFileAtomic } from "../host/fs";
import { readHostFile, writeHostFile } from "../host/host-file";
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
    await handles.find((handle) => handle.port === port)?.flushGitReads();
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

  it("seals one tool_call for a gateway call a hooked session made, on that session's chain", async () => {
    // Claude Code with the gateway as one of its MCP servers: the call's
    // PreToolUse, the gateway's forward, and its PostToolUse all report one
    // call, and each used to seal its own identity (G-11, ADR-189).
    const { fetch, batches } = plane();
    const { handle, host } = await boot(fetch, {
      mode: "content_exact",
      classes: ["tool_call"],
    });
    const port = handle.port as number;
    const hooked = "sess-gateway-1";
    const toolUseId = "toolu_01GatewayCall";
    const tool = {
      session_id: hooked,
      tool_name: "mcp__oxagen__query_ontology",
      tool_input: MCP_ARGUMENTS,
      tool_use_id: toolUseId,
    };
    for (const hook of [
      { session_id: hooked, hook_event_name: "SessionStart", cwd: "/repo" },
      { session_id: hooked, hook_event_name: "UserPromptSubmit", prompt: "q" },
      { ...tool, hook_event_name: "PreToolUse" },
    ])
      expect(await post(port, host.local_token, hook)).toBe(200);
    const answer = await handle.api.mcp?.(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "query_ontology",
          arguments: MCP_ARGUMENTS,
          _meta: { "claudecode/toolUseId": toolUseId },
        },
      },
      { sessionId: "mcp-sess-2" },
    );
    expect(answer?.status).toBe(200);
    expect(
      await post(port, host.local_token, {
        ...tool,
        hook_event_name: "PostToolUse",
        tool_response: MCP_RESULT,
      }),
    ).toBe(200);
    await handle.tick();

    const frames = batches
      .flatMap((b) => b.events)
      .filter((event) => event.kind === "tool_call");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.session_uuid).toBe(
      handle.registry.get(hooked)?.recorder.sessionUuid,
    );
    expect(frames[0]?.body).toMatchObject({
      tool_use_id: toolUseId,
      tool_input_digest: digestJcs(MCP_ARGUMENTS),
      tool_output_digest: digestJcs(MCP_RESULT),
    });
    expect(frames[0]?.attrs).toMatchObject({
      "oxagen.enforcement_tier": "gateway",
      "oxagen.mcp_session": "mcp-sess-2",
    });
    // The daemon's own chain holds nothing for the call.
    expect(handle.wal.read(handle.hostRecorder.sessionUuid)).not.toContainEqual(
      expect.objectContaining({ kind: "tool_call" }),
    );
  });

  it("leaves a gateway call to its PostToolUse when the session chain write fails", async () => {
    // ADR-189 decision 5: the gateway's frame is written on the serial queue
    // after the client has its answer. A failed write is logged and rolled
    // back, the call stays claimed, and the hook seals the call's one frame.
    const { fetch, batches } = plane();
    const { handle, host, log } = await boot(fetch, {
      mode: "content_exact",
      classes: ["tool_call"],
    });
    const port = handle.port as number;
    const hooked = "sess-gateway-rollback";
    const toolUseId = "toolu_01GatewayRollback";
    const tool = {
      session_id: hooked,
      tool_name: "mcp__oxagen__query_ontology",
      tool_input: MCP_ARGUMENTS,
      tool_use_id: toolUseId,
    };
    for (const hook of [
      { session_id: hooked, hook_event_name: "SessionStart", cwd: "/repo" },
      { session_id: hooked, hook_event_name: "UserPromptSubmit", prompt: "q" },
      { ...tool, hook_event_name: "PreToolUse" },
    ])
      expect(await post(port, host.local_token, hook)).toBe(200);
    const append = handle.wal.append.bind(handle.wal);
    let failed = false;
    const fault = vi
      .spyOn(handle.wal, "append")
      .mockImplementation((events, bodies) => {
        if (
          !failed &&
          events.some(
            (event) =>
              event.kind === "tool_call" &&
              event.attrs["oxagen.enforcement_tier"] === "gateway",
          )
        ) {
          failed = true;
          throw Object.assign(new Error("event disk full"), {
            code: "ENOSPC",
          });
        }
        append(events, bodies);
      });
    const answer = await handle.api.mcp?.(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "query_ontology",
          arguments: MCP_ARGUMENTS,
          _meta: { "claudecode/toolUseId": toolUseId },
        },
      },
      { sessionId: "mcp-sess-4" },
    );
    expect(answer?.status).toBe(200);
    // The hook runs on the same queue, after the gateway's write.
    expect(
      await post(port, host.local_token, {
        ...tool,
        hook_event_name: "PostToolUse",
        tool_response: MCP_RESULT,
      }),
    ).toBe(200);
    fault.mockRestore();
    await handle.tick();

    expect(failed).toBe(true);
    expect(
      log.some((line) =>
        line.includes(
          `mcp gateway could not record query_ontology (${toolUseId}): event disk full`,
        ),
      ),
    ).toBe(true);
    const session = handle.registry.get(hooked)?.recorder.sessionUuid;
    const frames = batches
      .flatMap((b) => b.events)
      .filter((event) => event.kind === "tool_call");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.session_uuid).toBe(session);
    expect(frames[0]?.body).toMatchObject({ tool_use_id: toolUseId });
    expect(frames[0]?.attrs["oxagen.enforcement_tier"]).not.toBe("gateway");
    // The rollback left no hole in the session's chain.
    const seqs = handle.wal.read(session as string).map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index));
  });

  it("seals a gateway call on the daemon's chain when no session is waiting on its id", async () => {
    const { fetch, batches } = plane();
    const { handle } = await boot(fetch, {
      mode: "content_exact",
      classes: ["tool_call"],
    });
    await handle.api.mcp?.(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "query_ontology",
          arguments: MCP_ARGUMENTS,
          _meta: { "claudecode/toolUseId": "toolu_01NobodyAsked" },
        },
      },
      { sessionId: "mcp-sess-3" },
    );
    await handle.tick();
    const frames = batches
      .flatMap((b) => b.events)
      .filter((event) => event.kind === "tool_call");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.session_uuid).toBe(handle.hostRecorder.sessionUuid);
  });

  it("reseals a gateway call whose WAL write failed with its body and no hole", async () => {
    // The gateway call seals its frame, drains the recorder's bodies into the
    // write, and the write throws. The rollback has to leave the host chain
    // and its pending bodies where the call found them, so the next call
    // takes the abandoned position and ships its own body, not a stale one.
    const { fetch, batches } = plane();
    const { handle } = await boot(fetch, {
      mode: "content_exact",
      classes: ["tool_call"],
    });
    const before = { ...handle.hostRecorder.chainCursor };
    const append = handle.wal.append.bind(handle.wal);
    let failed = false;
    const fault = vi
      .spyOn(handle.wal, "append")
      .mockImplementation((events, bodies) => {
        if (!failed && events.some((event) => event.kind === "tool_call")) {
          failed = true;
          throw Object.assign(new Error("event disk full"), {
            code: "ENOSPC",
          });
        }
        append(events, bodies);
      });
    const call = (id: number) =>
      handle.api.mcp?.(
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "query_ontology", arguments: MCP_ARGUMENTS },
        },
        { sessionId: "mcp-sess-1" },
      );
    await expect(call(4)).rejects.toThrow("event disk full");
    expect(failed).toBe(true);
    expect(handle.hostRecorder.chainCursor).toEqual(before);
    fault.mockRestore();

    await call(5);
    await handle.tick();
    const frames = batches
      .flatMap((b) => b.events)
      .filter((event) => event.kind === "tool_call");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.seq).toBe(before.seq);
    const bodies = batches.flatMap((b) => b.bodies ?? []);
    expect(bodies.map((body) => body.event_id_idem)).toEqual([
      frames[0]?.event_id_idem,
    ]);
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
    // A holder rather than a `let`: `signer` exists only after
    // `boot(fetch, ...)` and `fetch` closes over this, so the narrowed bundle
    // cannot be built at the declaration. `prefer-const` fires on a bare
    // `let` assigned once and its fixer would collapse the two and break the
    // closure; an `= undefined` initializer silences it but lands between two
    // rules that disagree, since `no-undef-init` forbids exactly that. The
    // object is const and the mutation is explicit, so neither rule applies.
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

  it("completes a narrowing sweep that failed, on the next confirmation", async () => {
    // The debt outlives the attempt. `applyControlFacts` writes the new etag
    // before the sweep runs, so once it is written every later poll answers
    // `not_modified` and the narrowing is never seen again. A sweep that threw
    // — a transient filesystem error, or the process dying mid-write — would
    // otherwise leave the excluded bytes on disk for ever, with nothing left
    // to notice them.
    const narrowed: { bundle?: PolicyBundle; delivered?: boolean } = {};
    const { fetch } = plane(
      () => undefined,
      () =>
        narrowed.bundle === undefined || narrowed.delivered === true
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
    await handle.tick();
    expect(readFileSync(bodyPath, "utf8")).toContain(PROMPT_BASE64);

    // The sweep fails exactly once, the way a transient EIO would.
    const real = handle.wal.purgeBodiesOutsideMandate.bind(handle.wal);
    let failed = false;
    handle.wal.purgeBodiesOutsideMandate = (retention) => {
      if (!failed) {
        failed = true;
        throw new Error("EIO: simulated");
      }
      return real(retention);
    };

    narrowed.bundle = signer.sign(
      unsignedBundle({
        version: 4,
        etag: "etag-4",
        retention: { mode: "digest_only", classes: [] },
      }),
    );
    await handle.refreshBundle();
    narrowed.delivered = true;

    // The mandate took effect and the bytes did not go: this is the state the
    // finding is about, and it is reached through the logged catch.
    expect(failed).toBe(true);
    expect(readFileSync(bodyPath, "utf8")).toContain(PROMPT_BASE64);
    expect(
      log.some((line) =>
        line.startsWith("failed to erase bodies the narrowed mandate"),
      ),
    ).toBe(true);
    // The debt is on disk, not only in memory, so a restart still owes it.
    expect(existsSync(join(paths.wal, "body-purge-owed"))).toBe(true);

    // The next poll is a plain confirmation — the branch that used to return
    // without ever looking again.
    await handle.refreshBundle();

    expect(
      existsSync(bodyPath) ? readFileSync(bodyPath, "utf8") : "",
    ).not.toContain(PROMPT_BASE64);
    expect(existsSync(join(paths.wal, "body-purge-owed"))).toBe(false);
    expect(
      log.some((line) => line.startsWith("completed an owed body purge")),
    ).toBe(true);
  });

  it("sweeps bodies the drain can no longer reach when the mandate narrows, on a session that never seals", async () => {
    // The finding, in the case the drain cannot answer. Dropping a body as it
    // is withheld from a batch reaches only a body whose event is still
    // unshipped. Once the event has shipped the cursor is past it, so nothing
    // looks at that body again, and `Wal.compact` frees the file only when its
    // session is sealed, fully shipped, and past the retention window. A live
    // or abandoned session therefore kept the raw prompt with no bound at all.
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
    // Ship everything under the mandate that authorised it. The bodies stay on
    // disk afterwards, and no later batch names their events.
    await handle.tick();
    expect(handle.wal.stats().unshipped).toBe(0);
    expect(batches.flatMap((b) => b.bodies ?? []).length).toBeGreaterThan(0);
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
    // The poll is what carries a narrowing to this host.
    await handle.refreshBundle();
    await handle.tick();

    // Gone from disk: either the line went, or the file went with it.
    expect(
      existsSync(bodyPath) ? readFileSync(bodyPath, "utf8") : "",
    ).not.toContain(PROMPT_BASE64);
    expect(log.some((line) => line.startsWith("mandate narrowed ("))).toBe(
      true,
    );
    // The chain is untouched: the events shipped with their digests, and the
    // session still reads and still seals.
    expect(
      batches
        .flatMap((b) => b.events)
        .some(
          (e) => e.kind === "turn_start" && e.content?.digest !== undefined,
        ),
    ).toBe(true);
    expect(handle.wal.stats().unshipped).toBe(0);
    expect(
      await post(handle.port as number, host.local_token, {
        session_id: session,
        hook_event_name: "SessionEnd",
        reason: "other",
      }),
    ).toBe(200);
    await handle.flushGitReads();
    await handle.tick();
    expect(
      batches.flatMap((b) => b.events).some((e) => e.kind === "agent_stop"),
    ).toBe(true);
  });

  it("records the narrowing before the etag is committed, and settles it after a restart", async () => {
    // Two windows the test above leaves open. The debt is recorded after
    // `applyControlFacts` has written the new etag, so a process that exits in
    // between records nothing and no later poll can tell the clause narrowed.
    // And the retry runs only on a poll, so a host that restarts into an
    // unreachable control plane holds the content until one answers.
    const narrowed: { bundle?: PolicyBundle; delivered?: boolean } = {};
    const { fetch } = plane(
      () => undefined,
      () =>
        narrowed.bundle === undefined || narrowed.delivered === true
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
    await handle.tick();
    expect(readFileSync(bodyPath, "utf8")).toContain(PROMPT_BASE64);

    // A transient filesystem error, standing in for anything that makes the
    // sweep fail once the narrowing has been accepted. It reads the etag on
    // disk as it fails, which is how the ordering is asserted below.
    let etagWhenSwept: string | undefined;
    const sweep = handle.wal.purgeBodiesOutsideMandate.bind(handle.wal);
    handle.wal.purgeBodiesOutsideMandate = () => {
      etagWhenSwept = readHostFile(paths.hostFile)?.bundle.etag;
      throw new Error("EIO: the disk said no");
    };
    narrowed.bundle = signer.sign(
      unsignedBundle({
        version: 4,
        etag: "etag-4",
        retention: { mode: "digest_only", classes: [] },
      }),
    );
    await handle.refreshBundle();
    handle.wal.purgeBodiesOutsideMandate = sweep;
    // The old etag: the debt was recorded and the sweep tried before the
    // replacement was cached, so an exit anywhere in here leaves the debt.
    expect(etagWhenSwept).toBe("etag-3");
    expect(readHostFile(paths.hostFile)?.bundle.etag).toBe("etag-4");
    expect(readFileSync(bodyPath, "utf8")).toContain(PROMPT_BASE64);
    const owedPath = join(paths.wal, "body-purge-owed");
    expect(existsSync(owedPath)).toBe(true);
    // The debt names the clause to enforce, not just that one is owed.
    expect(
      (
        JSON.parse(readFileSync(owedPath, "utf8")) as {
          retention: { mode: string };
        }
      ).retention.mode,
    ).toBe("digest_only");

    // A restart settles it without waiting for a poll, which is what a host
    // that comes back to an unreachable control plane depends on.
    await handle.stop();
    handles.splice(handles.indexOf(handle), 1);
    const restartLog: string[] = [];
    const restarted = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("the control plane is unreachable");
      },
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => restartLog.push(line),
      port: 0,
      listen: false,
      transcriptRoots: [paths.root],
      timers: { detectorMs: 0, sweepMs: 0, checkpointMs: 0, commandsPollMs: 0 },
    });
    handles.push(restarted);
    expect(
      existsSync(bodyPath) ? readFileSync(bodyPath, "utf8") : "",
    ).not.toContain(PROMPT_BASE64);
    expect(existsSync(owedPath)).toBe(false);
    expect(
      restartLog.some((line) =>
        line.startsWith("completed an owed body purge"),
      ),
    ).toBe(true);
    expect(log.some((line) => line.startsWith("mandate narrowed ("))).toBe(
      false,
    );
  });

  // A silent debt-write failure plus a failed sweep used to commit the new
  // etag with nothing on disk to retry. The next poll answered not_modified
  // and the excluded bodies stayed forever.
  it("refuses the etag commit when the purge debt cannot be written (negative)", async () => {
    const narrowed: { bundle?: PolicyBundle; delivered?: boolean } = {};
    const { fetch } = plane(
      () => undefined,
      () =>
        narrowed.bundle === undefined || narrowed.delivered === true
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
    await handle.tick();
    expect(readFileSync(bodyPath, "utf8")).toContain(PROMPT_BASE64);

    // The debt marker cannot land: its path is a directory, so `writeFileSync`
    // throws EISDIR. Not `chmod`, which root ignores — this container runs as
    // uid 0 and the first version of this test passed the write straight
    // through, recorded the debt, swept, and committed etag-4.
    const owedPath = join(paths.wal, "body-purge-owed");
    mkdirSync(owedPath);
    const sweep = handle.wal.purgeBodiesOutsideMandate.bind(handle.wal);
    handle.wal.purgeBodiesOutsideMandate = () => {
      throw new Error("EROFS: read-only file system");
    };
    narrowed.bundle = signer.sign(
      unsignedBundle({
        version: 4,
        etag: "etag-4",
        retention: { mode: "digest_only", classes: [] },
      }),
    );
    await handle.refreshBundle();

    // The replacement never cached: without a debt, committing it would leave
    // excluded bodies with no retry path.
    expect(readHostFile(paths.hostFile)?.bundle.etag).toBe("etag-3");
    // Nothing wrote a debt: the path is still the directory that failed it.
    expect(statSync(owedPath).isDirectory()).toBe(true);
    expect(readFileSync(bodyPath, "utf8")).toContain(PROMPT_BASE64);
    expect(
      log.some((line) =>
        line.startsWith("refusing to cache a narrowed bundle"),
      ),
    ).toBe(true);

    // Writable again: the next poll still carries the narrowing (old etag),
    // records the debt, sweeps, and commits.
    rmSync(owedPath, { recursive: true });
    handle.wal.purgeBodiesOutsideMandate = sweep;
    await handle.refreshBundle();
    narrowed.delivered = true;
    expect(readHostFile(paths.hostFile)?.bundle.etag).toBe("etag-4");
    expect(
      existsSync(bodyPath) ? readFileSync(bodyPath, "utf8") : "",
    ).not.toContain(PROMPT_BASE64);
    expect(existsSync(join(paths.wal, "body-purge-owed"))).toBe(false);
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
