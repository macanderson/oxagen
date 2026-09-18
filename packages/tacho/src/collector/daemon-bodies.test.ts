/**
 * The daemon's side of frame bodies: the bundle's retention clause decides
 * whether a body reaches the WAL at all, the shipper sends the bodies of a
 * batch with that batch, and a body the control plane refuses is said so in
 * the log. Kept apart from daemon.test.ts, whose fake control plane accepts
 * events and never looks at bodies.
 */
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { digestBytes } from "../digest";
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

/** A control plane that records every batch and refuses the bodies it is told to. */
function plane(
  refuse: (body: TachoBody) => string | undefined = () => undefined,
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
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ not_modified: true, etag: "etag-3", bundle: null }),
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

  async function boot(fetch: FetchLike, retention: PolicyBundle["retention"]) {
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
    });
    handles.push(handle);
    return { handle, host, log };
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
});
