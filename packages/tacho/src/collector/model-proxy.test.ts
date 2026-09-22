/**
 * The loopback model proxy end to end: a real daemon on ephemeral ports, a
 * fake vendor behind it (a plain node http server), and a client that talks
 * to the proxy the way Claude Code and Codex do.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { TachoEvent } from "../envelope";
import type { FetchLike } from "../host/control-client";
import { modelProxyPortFor, writeHostFile } from "../host/host-file";
import { applyModelBaseUrls } from "../host/model-base-url";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import {
  type ControlEnvelope,
  type DeliveredCommand,
  type PolicyBundle,
  policyBundleSchema,
  TACHO_BUNDLE_FEATURES,
  TACHO_MAX_BODY_BYTES,
} from "../wire";
import { type DaemonHandle, startDaemon } from "./daemon";
import {
  withAnthropicSystemBlock,
  withOpenAiInstructions,
} from "./model-injection";
import { createModelProxy } from "./model-proxy";
import { createModelProxyListener } from "./model-proxy-listener";
import {
  resolveModelRoute,
  upstreamUrlFor,
  DEFAULT_MODEL_UPSTREAMS,
} from "./model-routes";

const FAKE_KEY = "sk-ant-api03-FAKE-CREDENTIAL-do-not-store-9f3b";
const FAKE_BEARER = "eyJFAKE.chatgpt.subscription.token";
const PROMPT = "PROMPT-BODY-the-launch-codes-are-0000";
const COMPLETION = "COMPLETION-BODY-here-is-the-answer";
/** A credential inside the conversation, not the one the call is signed with. */
const LEAKED_KEY = "sk-ant-api03-PASTED-INTO-THE-PROMPT-abcdefghij";

/**
 * A workspace that keeps model bodies. The default bundle is `digest_only`,
 * which is why the frames in most of these tests carry digests and no bytes:
 * retention is the workspace's decision and the daemon applies it before the
 * WAL, so a test that wants bodies has to ask for them.
 */
const RETAIN_MODEL_CALLS = {
  retention: { mode: "content_exact", classes: ["model_call"] },
} as const satisfies Partial<Omit<PolicyBundle, "signature">>;

const sha = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

interface Seen {
  method: string;
  url: string;
  rawHeaders: string[];
  body: Buffer;
}

type VendorHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  seen: Seen,
) => void;

async function fakeVendor(handler: VendorHandler) {
  const requests: Seen[] = [];
  const closed: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const seen: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        rawHeaders: req.rawHeaders,
        body: Buffer.concat(chunks),
      };
      requests.push(seen);
      res.on("close", () => {
        if (!res.writableFinished) closed.push(seen.url);
      });
      handler(req, res, seen);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    requests,
    /** Requests whose response the peer closed before it finished. */
    closed,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface Answer {
  status: number;
  rawHeaders: string[];
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** When each chunk arrived, in ms since the request was sent. */
  arrivals: number[];
  error?: string;
}

function call(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: string[];
    body?: Buffer | string;
    /** Destroy the connection once this many chunks arrived. */
    abortAfterChunks?: number;
  },
): Promise<Answer> {
  return new Promise((resolve) => {
    const started = Date.now();
    const body =
      typeof options.body === "string"
        ? Buffer.from(options.body)
        : options.body;
    const req = request({
      host: "127.0.0.1",
      port,
      method: options.method ?? "POST",
      path: options.path,
      // Raw header pairs are sent exactly as given, so Host is ours to state.
      headers: [
        ...((options.headers ?? []).includes("Host")
          ? []
          : ["Host", `127.0.0.1:${port}`]),
        ...(options.headers ?? []),
        ...(body !== undefined ? ["Content-Length", String(body.length)] : []),
      ],
    });
    const answer: Answer = {
      status: 0,
      rawHeaders: [],
      headers: {},
      body: Buffer.alloc(0),
      arrivals: [],
    };
    const chunks: Buffer[] = [];
    const finish = (error?: string) => {
      answer.body = Buffer.concat(chunks);
      if (error !== undefined) answer.error = error;
      resolve(answer);
    };
    req.on("response", (res) => {
      answer.status = res.statusCode ?? 0;
      answer.rawHeaders = res.rawHeaders;
      answer.headers = res.headers;
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        answer.arrivals.push(Date.now() - started);
        if (
          options.abortAfterChunks !== undefined &&
          chunks.length >= options.abortAfterChunks
        )
          req.destroy();
      });
      res.on("end", () => finish());
      res.on("error", (error) => finish(error.message));
      res.on("close", () => finish(res.complete ? undefined : "closed early"));
    });
    req.on("error", (error) => finish(error.message));
    req.end(body);
  });
}

function controlPlane() {
  const ingested: TachoEvent[] = [];
  const queue: DeliveredCommand[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    // Built only for the routes that carry an envelope. The bundle route
    // does not, and splicing here would let a bundle poll swallow commands.
    const control = (): ControlEnvelope => ({
      host_status: "active",
      deny_generation: { org: 1, workspace: 1 },
      bundle_etag: "etag-3",
      commands: queue.splice(0),
    });
    if (url.endsWith("/events")) {
      const events = body["events"] as TachoEvent[];
      ingested.push(...events);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            accepted: events.length,
            event_ids: events.map((e) => e.event_id_idem),
            chain_breaks: [],
            control: control(),
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
      text: async () =>
        JSON.stringify({
          acknowledged: (body["acknowledgements"] as unknown[]).length,
          control: control(),
        }),
    };
  };
  return {
    fetch,
    ingested,
    queue: (
      command: Pick<DeliveredCommand, "id" | "command" | "session_uuid"> &
        Partial<DeliveredCommand>,
    ) =>
      queue.push({
        payload: {},
        requested_mode: null,
        delivery_mode: null,
        degraded_reason: null,
        reason: null,
        issued_at: new Date().toISOString(),
        expires_at: null,
        ...command,
      }),
  };
}

const PRICES: NonNullable<PolicyBundle["model_prices"]> = [
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    input: 3_000_000,
    output: 15_000_000,
    cache_read: 300_000,
    cache_write: 3_750_000,
  },
  {
    provider: "openai",
    model: "gpt-5",
    input: 1_250_000,
    output: 10_000_000,
    cache_read: 125_000,
    cache_write: 1_250_000,
  },
];

const ANTHROPIC_EVENTS = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-20260101", usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 2000 } } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: COMPLETION } })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } })}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];
// 1000 in + 500 out + 2000 cache read at the prices above.
const ANTHROPIC_COST = 3000 + 7500 + 600;

/** A vendor that streams the events above, `gapMs` apart. */
function streamingAnthropic(gapMs: number): VendorHandler {
  return (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "request-id": "req_vendor_1",
    });
    let index = 0;
    const next = () => {
      if (res.destroyed) return;
      if (index >= ANTHROPIC_EVENTS.length) {
        res.end();
        return;
      }
      res.write(ANTHROPIC_EVENTS[index]);
      index += 1;
      setTimeout(next, gapMs);
    };
    next();
  };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walkFiles(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

const until = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
};

describe("the loopback model proxy", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function boot(
    vendorUrl: string,
    options: {
      bundle?: Partial<Omit<PolicyBundle, "signature">>;
      paths?: ReturnType<typeof scratchPaths>;
      daemon?: Partial<Parameters<typeof startDaemon>[0]>;
    } = {},
  ) {
    const plane = controlPlane();
    const paths = options.paths ?? scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({ model_prices: PRICES, ...options.bundle }),
    );
    writeHostFile(paths.hostFile, testHostFile(signer, bundle));
    const log: string[] = [];
    const handle: DaemonHandle = await startDaemon({
      paths,
      fetch: plane.fetch,
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => log.push(line),
      port: 0,
      home: join(paths.root, ".."),
      transcriptRoots: [join(paths.root, "no-transcripts")],
      timers: { detectorMs: 0, sweepMs: 0, checkpointMs: 0, commandsPollMs: 0 },
      modelUpstreams: {
        anthropic: vendorUrl,
        openai: `${vendorUrl}/v1`,
        chatgpt: `${vendorUrl}/backend-api/codex`,
      },
      ...options.daemon,
    });
    cleanups.push(() => handle.stop());
    const port = handle.modelProxyPort as number;
    expect(port).toBeGreaterThan(0);
    const session = async (id: string, harness?: "codex") => {
      await handle.api.handleHook({
        payload: {
          hook_event_name: "SessionStart",
          session_id: id,
          cwd: "/tmp",
          source: "startup",
        },
        ...(harness !== undefined ? { harness } : {}),
      });
      return handle.registry.get(id)!.recorder.sessionUuid;
    };
    const frames = (uuid: string, kind = "llm_call") =>
      handle.wal.read(uuid).filter((event) => event.kind === kind);
    return { handle, plane, paths, log, port, session, frames };
  }

  async function vendor(handler: VendorHandler) {
    const fake = await fakeVendor(handler);
    cleanups.push(() => fake.close());
    return fake;
  }

  it("passes method, path, query, headers and body through byte for byte, both ways", async () => {
    const reply = Buffer.from(
      `{ "id":"msg_9",\n "model":"claude-sonnet-5", "content":[{"type":"text","text":"${COMPLETION}"}], "usage":{"input_tokens":10,"output_tokens":2} }`,
    );
    const fake = await vendor((_req, res) => {
      res.writeHead(201, "Made", [
        "Content-Type",
        "application/json",
        "X-Vendor-Thing",
        "a",
        "X-Vendor-Thing",
        "b",
        "request-id",
        "req_abc",
        "Content-Length",
        String(reply.length),
      ]);
      res.end(reply);
    });
    const { port, session, frames } = await boot(fake.url);
    const uuid = await session("sess-pass");
    // Spacing and key order a re-serializer would not reproduce.
    const body = Buffer.from(
      `{"model":"claude-sonnet-5",  "messages":[ {"role":"user","content":"${PROMPT}"} ],\n"stream":false}`,
    );
    const answer = await call(port, {
      method: "POST",
      path: "/anthropic/v1/messages?beta=true&x=%2F",
      headers: [
        "X-Api-Key",
        FAKE_KEY,
        "anthropic-version",
        "2023-06-01",
        "X-Claude-Code-Session-Id",
        "sess-pass",
        "x-oxagen-session",
        "sess-pass",
        "X-Custom-CASE",
        "one",
        "X-Custom-CASE",
        "two",
        "Accept-Encoding",
        "gzip, br",
        "Connection",
        "keep-alive, X-Hop",
        "X-Hop",
        "drop me",
        "Content-Type",
        "application/json",
      ],
      body,
    });

    const seen = fake.requests[0]!;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/v1/messages?beta=true&x=%2F");
    expect(seen.body.equals(body)).toBe(true);
    const pairs: string[] = [];
    for (let i = 0; i < seen.rawHeaders.length; i += 2)
      pairs.push(`${seen.rawHeaders[i]}: ${seen.rawHeaders[i + 1]}`);
    expect(pairs).toContain(`X-Api-Key: ${FAKE_KEY}`);
    expect(pairs).toContain("anthropic-version: 2023-06-01");
    expect(pairs).toContain("X-Claude-Code-Session-Id: sess-pass");
    expect(pairs.filter((p) => p.startsWith("X-Custom-CASE"))).toEqual([
      "X-Custom-CASE: one",
      "X-Custom-CASE: two",
    ]);
    expect(pairs).toContain("Accept-Encoding: identity");
    expect(pairs).toContain(`Content-Length: ${body.length}`);
    expect(pairs).toContain(`Host: ${new URL(fake.url).host}`);
    const names = pairs.map((p) => p.split(":")[0]!.toLowerCase());
    expect(names).not.toContain("x-oxagen-session");
    expect(names).not.toContain("x-hop");
    expect(names.filter((n) => n === "accept-encoding")).toHaveLength(1);

    expect(answer.status).toBe(201);
    expect(answer.body.equals(reply)).toBe(true);
    const back: string[] = [];
    for (let i = 0; i < answer.rawHeaders.length; i += 2)
      back.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`);
    expect(back).toEqual(
      expect.arrayContaining([
        "X-Vendor-Thing: a",
        "X-Vendor-Thing: b",
        "request-id: req_abc",
        `Content-Length: ${reply.length}`,
      ]),
    );

    const [frame] = frames(uuid);
    expect(frame!.fidelity).toBe("proxy");
    expect(frame!.source).toBe("collector");
    expect(frame!.body).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      input_tokens: 10,
      output_tokens: 2,
      api_status_code: 201,
      request_id: "req_abc",
      message_id: "msg_9",
      cost_basis: "observed",
      cost_usd_micros: 60,
    });
    expect(frame!.attrs).toMatchObject({
      "oxagen.metering": "observed",
      "oxagen.enforcement_tier": "gateway",
      "oxagen.model_api": "anthropic.messages",
      "oxagen.correlation": "header",
      "oxagen.request_digest": sha(body),
      "oxagen.response_digest": sha(reply),
      "oxagen.request_bytes": String(body.length),
      "oxagen.response_bytes": String(reply.length),
      "oxagen.stream": "0",
    });
  });

  it("never writes a credential, a prompt or a completion to disk, the spool, the wire or the log", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, plane, paths, port, log, session } = await boot(fake.url);
    await session("sess-secret");
    await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Api-Key",
        FAKE_KEY,
        "Authorization",
        `Bearer ${FAKE_BEARER}`,
        "X-Claude-Code-Session-Id",
        "sess-secret",
      ],
      body: JSON.stringify({
        model: "claude-sonnet-5",
        stream: true,
        messages: [{ role: "user", content: PROMPT }],
      }),
    });
    // A refused call and a failed one take the other two code paths.
    await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", FAKE_KEY, "Host", "evil.example"],
      body: PROMPT,
    });
    await handle.tick();
    expect(plane.ingested.some((event) => event.kind === "llm_call")).toBe(
      true,
    );

    const haystacks = [
      ...walkFiles(paths.root).map((file) => readFileSync(file, "latin1")),
      JSON.stringify(plane.ingested),
      log.join("\n"),
      JSON.stringify(handle.api.status()),
    ];
    for (const needle of [
      FAKE_KEY,
      FAKE_BEARER,
      PROMPT,
      COMPLETION,
      "launch-codes",
    ]) {
      for (const haystack of haystacks)
        expect(haystack.includes(needle)).toBe(false);
    }
  });

  it("streams SSE as it arrives, and meters the stream", async () => {
    const fake = await vendor(streamingAnthropic(120));
    const { port, session, frames } = await boot(fake.url);
    const uuid = await session("sess-stream");
    const answer = await call(port, {
      path: "/anthropic/v1/messages?beta=true",
      headers: [
        "X-Api-Key",
        FAKE_KEY,
        "X-Claude-Code-Session-Id",
        "sess-stream",
      ],
      body: JSON.stringify({
        model: "claude-sonnet-5",
        stream: true,
        messages: [],
      }),
    });
    expect(answer.body.toString()).toBe(ANTHROPIC_EVENTS.join(""));
    // Four writes 120ms apart: a proxy that buffered would deliver them at once.
    expect(answer.arrivals.length).toBeGreaterThanOrEqual(3);
    expect(
      answer.arrivals.at(-1)! - answer.arrivals[0]!,
    ).toBeGreaterThanOrEqual(200);
    expect(answer.headers["content-type"]).toBe("text/event-stream");

    const [frame] = frames(uuid);
    expect(frame!.body).toMatchObject({
      model: "claude-sonnet-5-20260101",
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 2000,
      stop_reason: "end_turn",
      cost_usd_micros: ANTHROPIC_COST,
      request_id: "req_vendor_1",
    });
    expect(frame!.attrs["oxagen.stream"]).toBe("1");
    expect(frame!.attrs["oxagen.response_digest"]).toBe(
      sha(ANTHROPIC_EVENTS.join("")),
    );
    const ttft = frame!.body as { ttft_ms: number; api_duration_ms: number };
    expect(ttft.api_duration_ms).toBeGreaterThanOrEqual(ttft.ttft_ms + 200);
  });

  it("stores the second call of a session without the messages the first already holds", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, port, session, frames } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-prefix");
    const headers = [
      "X-Api-Key",
      FAKE_KEY,
      "X-Claude-Code-Session-Id",
      "sess-prefix",
    ];
    const system = [
      {
        type: "text",
        text: `You are careful. ${"Read before you write. ".repeat(40)}`,
      },
    ];
    const first = JSON.stringify({
      model: "claude-sonnet-5",
      stream: true,
      system,
      messages: [{ role: "user", content: PROMPT }],
    });
    await call(port, { path: "/anthropic/v1/messages", headers, body: first });
    await until(() => frames(uuid).length === 1);
    const second = JSON.stringify({
      model: "claude-sonnet-5",
      stream: true,
      system,
      messages: [
        { role: "user", content: PROMPT },
        { role: "assistant", content: COMPLETION },
        { role: "user", content: "and then?" },
      ],
    });
    await call(port, { path: "/anthropic/v1/messages", headers, body: second });
    await until(() => frames(uuid).length === 2);

    const [one, two] = frames(uuid);
    const [body] = handle.wal.bodiesFor([two!]);
    const exchange = JSON.parse(
      Buffer.from(body!.bytes_base64, "base64").toString("utf8"),
    ) as { request: string };
    const stored = JSON.parse(exchange.request) as Record<string, unknown>;
    // Only what is new since the first call, and a pointer to it.
    expect(stored["messages"]).toEqual([
      { role: "assistant", content: COMPLETION },
      { role: "user", content: "and then?" },
    ]);
    expect(stored).not.toHaveProperty("system");
    expect(stored["$oxagen_prior"]).toEqual({
      unchanged_from: sha(first),
      messages: 1,
      fields: ["system"],
    });
    expect(two!.attrs["oxagen.request_prior_messages"]).toBe("1");
    expect(two!.attrs["oxagen.request_prior_digest"]).toBe(sha(first));
    expect(two!.attrs["oxagen.request_full_digest"]).toBe(sha(second));
    expect(Number(two!.attrs["oxagen.request_stored_bytes"])).toBeLessThan(
      Number(two!.attrs["oxagen.request_full_bytes"]),
    );
    // The first call is stored whole, and its full digest is what the second
    // call points at (negative: nothing to fold against).
    expect(one!.attrs["oxagen.request_prior_messages"]).toBeUndefined();
    expect(one!.attrs["oxagen.request_full_digest"]).toBe(sha(first));
    // The chain still names the stored bytes.
    expect(two!.content?.digest).toBe(
      sha(Buffer.from(body!.bytes_base64, "base64")),
    );
  });

  it("records the decoded request and the buffered stream as one frame body", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, port, session, frames } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-body");
    const sent = JSON.stringify({
      model: "claude-sonnet-5",
      stream: true,
      messages: [{ role: "user", content: PROMPT }],
    });
    // Sent gzipped, the way a harness sends it. The frame must carry what the
    // vendor reads, not the compressed bytes nobody can replay.
    await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Api-Key",
        FAKE_KEY,
        "X-Claude-Code-Session-Id",
        "sess-body",
        "Content-Encoding",
        "gzip",
      ],
      body: gzipSync(Buffer.from(sent)),
    });
    await until(() => frames(uuid).length === 1);

    const [frame] = frames(uuid);
    const [body] = handle.wal.bodiesFor([frame!]);
    expect(body).toBeDefined();
    expect(body!.content_type).toBe("application/json");
    const bytes = Buffer.from(body!.bytes_base64, "base64");
    // The chained digest names the bytes that shipped, so a reader holding the
    // body can verify it against the chain.
    expect(frame!.content?.digest).toBe(sha(bytes));

    const exchange = JSON.parse(bytes.toString("utf8")) as {
      request: string;
      response: string;
    };
    expect(JSON.parse(exchange.request)).toMatchObject({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: PROMPT }],
    });
    // Four SSE writes, one body. A proxy that dropped the stream would have
    // the usage and none of the answer.
    expect(exchange.response).toBe(ANTHROPIC_EVENTS.join(""));
    expect(exchange.response).toContain(COMPLETION);

    // The metering columns and the wire digests are what they always were.
    expect(frame!.body).toMatchObject({
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd_micros: ANTHROPIC_COST,
    });
    expect(frame!.attrs["oxagen.response_digest"]).toBe(
      sha(ANTHROPIC_EVENTS.join("")),
    );
  });

  it("holds no response body past the cap, and the frame says why", async () => {
    const oversized = "y".repeat(TACHO_MAX_BODY_BYTES + 4096);
    const reply = `{"id":"msg_big","model":"claude-sonnet-5","content":[{"type":"text","text":"${oversized}"}],"usage":{"input_tokens":10,"output_tokens":2}}`;
    const fake = await vendor((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(reply);
    });
    const { handle, port, session, frames } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-huge");
    await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", FAKE_KEY, "X-Claude-Code-Session-Id", "sess-huge"],
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    await until(() => frames(uuid).length === 1);

    const [frame] = frames(uuid);
    expect(frame!.attrs["oxagen.response_body_omitted"]).toBe("too_large");
    // The call is still on the chain with its usage, its size and a digest of
    // the bytes that crossed the wire, so a replay reads a size limit rather
    // than a host that never captured.
    expect(frame!.attrs["oxagen.response_digest"]).toBe(sha(reply));
    expect(Number(frame!.attrs["oxagen.response_bytes"])).toBe(reply.length);

    const [body] = handle.wal.bodiesFor([frame!]);
    const exchange = JSON.parse(
      Buffer.from(body!.bytes_base64, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    // The request half still replays. JCS drops the member that has no bytes.
    expect(exchange).not.toHaveProperty("response");
    expect(exchange["request"]).toContain("claude-sonnet-5");
    expect(frame!.content?.digest).toBe(
      sha(Buffer.from(body!.bytes_base64, "base64")),
    );
  });

  it("cuts a secret out of the recorded bytes, and chains the digest of what is left", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, port, session, frames, paths } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-leak");
    await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", FAKE_KEY, "X-Claude-Code-Session-Id", "sess-leak"],
      body: JSON.stringify({
        model: "claude-sonnet-5",
        stream: true,
        // A key the person pasted into the conversation, not the one the
        // request is authenticated with.
        messages: [{ role: "user", content: `deploy with ${LEAKED_KEY}` }],
      }),
    });
    await until(() => frames(uuid).length === 1);

    const [frame] = frames(uuid);
    expect(frame!.content?.redactions).toMatchObject([
      { reason: "model_api_key" },
    ]);
    const bytes = Buffer.from(
      handle.wal.bodiesFor([frame!])[0]!.bytes_base64,
      "base64",
    );
    expect(bytes.toString("utf8")).not.toContain(LEAKED_KEY);
    // The chain names the redacted bytes. A digest of what the vendor saw
    // would be a digest of a body that never ships, and an oracle for the
    // secret besides.
    expect(frame!.content?.digest).toBe(sha(bytes));
    for (const file of walkFiles(paths.root))
      expect(readFileSync(file, "latin1").includes(LEAKED_KEY)).toBe(false);
  });

  it("propagates a client abort without blaming the upstream and records the partial stream", async () => {
    const fake = await vendor(streamingAnthropic(150));
    const { port, session, frames, log } = await boot(fake.url);
    const uuid = await session("sess-abort");
    const answer = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Claude-Code-Session-Id", "sess-abort"],
      body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      abortAfterChunks: 1,
    });
    expect(answer.error).toBeDefined();
    await until(() => fake.closed.length === 1);
    await until(() => frames(uuid).length === 1);
    const [frame] = frames(uuid);
    expect(frame!.body).toMatchObject({
      api_error_class: "client_aborted",
      input_tokens: 1000,
      output_tokens: 1,
    });
    expect(log.filter((line) => line.includes("failed mid-response"))).toEqual(
      [],
    );
  });

  it("routes Codex by its credential, correlates by session-id, and forwards a zstd body untouched", async () => {
    const completed = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", model: "gpt-5-codex", status: "completed", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 60 } } } })}\n\n`;
    const fake = await vendor((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(completed);
    });
    const { port, session, frames } = await boot(fake.url);
    const uuid = await session("codex-1", "codex");
    const packed = zstdCompressSync(
      Buffer.from(
        JSON.stringify({ model: "gpt-5-codex", stream: true, input: PROMPT }),
      ),
    );

    await call(port, {
      path: "/backend-api/codex/responses",
      headers: [
        "Authorization",
        `Bearer ${FAKE_BEARER}`,
        "ChatGPT-Account-ID",
        "acct_1",
        "session-id",
        "codex-1",
        "Content-Encoding",
        "zstd",
      ],
      body: packed,
    });
    await call(port, {
      path: "/backend-api/codex/responses",
      headers: [
        "Authorization",
        "Bearer sk-openai-FAKE",
        "session-id",
        "codex-1",
      ],
      body: JSON.stringify({ model: "gpt-5-codex", stream: true }),
    });
    expect(fake.requests.map((r) => r.url)).toEqual([
      "/backend-api/codex/responses",
      "/v1/responses",
    ]);
    expect(fake.requests[0]!.body.equals(packed)).toBe(true);
    expect(fake.requests[0]!.rawHeaders).toEqual(
      expect.arrayContaining([
        "Content-Encoding",
        "zstd",
        `Bearer ${FAKE_BEARER}`,
      ]),
    );

    const [first] = frames(uuid);
    expect(first!.agent.runtime).toBe("codex");
    expect(first!.body).toMatchObject({
      provider: "openai",
      model: "gpt-5-codex",
      input_tokens: 600,
      cache_read_tokens: 400,
      output_tokens: 100,
      thinking_tokens: 60,
      cost_usd_micros: 750 + 50 + 1000,
    });
    expect(first!.attrs["oxagen.correlation"]).toBe("harness_header");
    expect(frames(uuid)).toHaveLength(2);
  });

  it("maps every documented route, and leaves unknown paths alone", () => {
    const at = (url: string, headers: Record<string, string> = {}) => {
      const route = resolveModelRoute(url, headers);
      return route === undefined
        ? undefined
        : [
            route.api,
            upstreamUrlFor(route, DEFAULT_MODEL_UPSTREAMS).toString(),
          ];
    };
    expect(at("/anthropic/v1/messages?beta=true")).toEqual([
      "anthropic.messages",
      "https://api.anthropic.com/v1/messages?beta=true",
    ]);
    expect(at("/anthropic/v1/messages/count_tokens")).toEqual([
      "other",
      "https://api.anthropic.com/v1/messages/count_tokens",
    ]);
    expect(at("/anthropic/v1/models")).toEqual([
      "other",
      "https://api.anthropic.com/v1/models",
    ]);
    expect(at("/v1/messages")).toEqual([
      "anthropic.messages",
      "https://api.anthropic.com/v1/messages",
    ]);
    expect(at("/v1/models", { "anthropic-version": "2023-06-01" })).toEqual([
      "other",
      "https://api.anthropic.com/v1/models",
    ]);
    expect(at("/v1/models")).toEqual([
      "other",
      "https://api.openai.com/v1/models",
    ]);
    expect(at("/v1/responses", { "x-api-key": "k" })).toEqual([
      "openai.responses",
      "https://api.openai.com/v1/responses",
    ]);
    expect(at("/openai/v1/chat/completions")).toEqual([
      "openai.chat",
      "https://api.openai.com/v1/chat/completions",
    ]);
    expect(
      at("/backend-api/codex/responses", { "chatgpt-account-id": "a" }),
    ).toEqual([
      "openai.responses",
      "https://chatgpt.com/backend-api/codex/responses",
    ]);
    expect(at("/backend-api/codex")).toEqual([
      "other",
      "https://api.openai.com/v1/",
    ]);
    expect(at("/status")).toBeUndefined();
    expect(at("/anthropicx/v1/messages")).toBeUndefined();
  });

  it("refuses a session at its budget with the vendor's own error shape, and records the refusal", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const paths = scratchPaths();
    const budget = { mode: "enforced" as const, session_limit_usd: 0.01 };
    const first = await boot(fake.url, { paths, bundle: { budget } });
    const uuid = await first.session("sess-budget");
    const ask = (port: number, path = "/anthropic/v1/messages") =>
      call(port, {
        path,
        headers: [
          "X-Api-Key",
          FAKE_KEY,
          "X-Claude-Code-Session-Id",
          "sess-budget",
        ],
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });

    // $0.0111 observed against a $0.01 limit: the call that crosses it finishes.
    expect((await ask(first.port)).status).toBe(200);
    const refused = await ask(first.port);
    expect(refused.status).toBe(403);
    expect(refused.headers["x-oxagen-refusal"]).toBe("session_budget_exceeded");
    expect(refused.headers["x-should-retry"]).toBe("false");
    const error = JSON.parse(refused.body.toString()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(error.type).toBe("error");
    expect(error.error.type).toBe("permission_error");
    expect(error.error.message).toContain("$0.01 observed of a $0.01 limit");
    expect(fake.requests).toHaveLength(1);

    const [decision] = first.frames(uuid, "policy_decision");
    expect(decision!.body).toMatchObject({
      policy_decision: "deny",
      policy_source: "bundle",
      policy_reason_code: "session_budget_exceeded",
    });
    expect(decision!.attrs).toMatchObject({
      "oxagen.refused": "model_call",
      "oxagen.session_spend_usd_micros": String(ANTHROPIC_COST),
    });
    expect(first.handle.api.status()["gateway"]).toMatchObject({
      calls_observed: 1,
    });

    // An OpenAI-shaped refusal for the same session on the other route.
    const openai = await call(first.port, {
      path: "/openai/v1/responses",
      headers: ["x-oxagen-session", "sess-budget"],
      body: "{}",
    });
    expect(JSON.parse(openai.body.toString())).toMatchObject({
      error: { type: "invalid_request_error", code: "session_budget_exceeded" },
    });

    // A restart does not hand the budget back: the chain is read before admission.
    await first.handle.stop();
    const second = await boot(fake.url, { paths, bundle: { budget } });
    expect((await ask(second.port)).status).toBe(403);
    expect(fake.requests).toHaveLength(1);
    expect(verifyChain(second.handle.wal.read(uuid)).ok).toBe(true);
  });

  it("fails open: an observed budget, an unpriced model and an uncorrelated call all go through", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, port, session, frames } = await boot(fake.url, {
      bundle: {
        budget: { mode: "observed", session_limit_usd: 0.000001 },
        model_prices: [],
      },
    });
    const uuid = await session("sess-open");
    for (let i = 0; i < 2; i += 1) {
      const answer = await call(port, {
        path: "/anthropic/v1/messages",
        headers: ["X-Claude-Code-Session-Id", "sess-open"],
        body: "{}",
      });
      expect(answer.status).toBe(200);
    }
    expect(
      frames(uuid).map((f) => (f.body as { cost_basis: string }).cost_basis),
    ).toEqual(["observed_unpriced", "observed_unpriced"]);

    // Two live sessions and no id: nobody's chain is guessed at.
    await session("sess-other");
    const orphan = await call(port, {
      path: "/anthropic/v1/messages",
      body: "not json",
    });
    expect(orphan.status).toBe(200);
    const hostFrames = frames(handle.hostRecorder.sessionUuid);
    expect(hostFrames.at(-1)!.attrs["oxagen.correlation"]).toBe("unattributed");
  });

  it("correlates by the session id inside metadata.user_id, and by the one live session", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { port, session, frames } = await boot(fake.url);
    const uuid = await session("9d1f6a54-0000-4000-8000-00000000abcd");
    await call(port, {
      path: "/anthropic/v1/messages",
      body: JSON.stringify({
        model: "m",
        metadata: {
          user_id: JSON.stringify({
            device_id: "d",
            session_id: "9d1f6a54-0000-4000-8000-00000000abcd",
          }),
        },
      }),
    });
    await call(port, {
      path: "/anthropic/v1/messages",
      body: JSON.stringify({
        model: "m",
        metadata: {
          user_id:
            "user_abc_account_def_session_9d1f6a54-0000-4000-8000-00000000abcd",
        },
      }),
    });
    await call(port, {
      path: "/anthropic/v1/messages",
      body: JSON.stringify({ model: "m" }),
    });
    expect(frames(uuid).map((f) => f.attrs["oxagen.correlation"])).toEqual([
      "request_metadata",
      "request_metadata",
      "sole_live_session",
    ]);
  });

  it("interrupts in-flight calls on pause, refuses new ones, and resumes", async () => {
    const fake = await vendor((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(ANTHROPIC_EVENTS[0]);
      // Then silence: the vendor is still thinking when the operator pauses.
    });
    const { handle, plane, port, session, frames, log } = await boot(fake.url);
    const uuid = await session("sess-pause");
    const ask = () =>
      call(port, {
        path: "/anthropic/v1/messages",
        headers: ["X-Claude-Code-Session-Id", "sess-pause"],
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });
    const inFlight = ask();
    await until(() => fake.requests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    plane.queue({
      id: "cmd_pause",
      command: "pause",
      session_uuid: uuid,
      reason: "reviewing this run",
    });
    await handle.tick();
    const cut = await inFlight;
    expect(cut.error).toBeDefined();
    await until(() => fake.closed.length === 1);
    await until(() => frames(uuid).length === 1);
    expect(frames(uuid)[0]!.body).toMatchObject({
      api_error_class: "interrupted",
      input_tokens: 1000,
    });
    expect(frames(uuid)[0]!.attrs["oxagen.interrupted"]).toBe("1");
    expect(log.filter((line) => line.includes("failed mid-response"))).toEqual(
      [],
    );

    const refused = await ask();
    expect(refused.status).toBe(403);
    expect(refused.headers["x-oxagen-refusal"]).toBe("session_paused");
    expect(refused.body.toString()).toContain("reviewing this run");
    expect(fake.requests).toHaveLength(1);
    expect(frames(uuid, "policy_decision").at(-1)!.body).toMatchObject({
      policy_source: "human",
      policy_reason_code: "session_paused",
    });

    plane.queue({ id: "cmd_resume", command: "resume", session_uuid: uuid });
    await handle.tick();
    const resumed = ask();
    await until(() => fake.requests.length === 2);
    handle.registry.get("sess-pause")!.control.cancelled = "stopped";
    expect(
      await call(port, {
        path: "/anthropic/v1/messages",
        headers: ["X-Claude-Code-Session-Id", "sess-pause"],
        body: "{}",
      }),
    ).toMatchObject({ status: 403 });
    void resumed;
  });

  it("marks a steer delivered as interrupt, and answers before headers when it can", async () => {
    const fake = await vendor(() => undefined);
    const { handle, plane, port, session } = await boot(fake.url);
    const uuid = await session("sess-steer");
    const inFlight = call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Claude-Code-Session-Id", "sess-steer"],
      body: "{}",
    });
    await until(() => fake.requests.length === 1);
    plane.queue({
      id: "cmd_steer",
      command: "steer",
      session_uuid: uuid,
      payload: { text: "stop and read the brief" },
      requested_mode: "interrupt",
      delivery_mode: "interrupt",
    });
    await handle.tick();
    const answer = await inFlight;
    expect(answer.status).toBe(403);
    expect(answer.headers["x-oxagen-refusal"]).toBe("interrupted_by_operator");
    expect(
      handle.registry.get("sess-steer")!.control.messages[0]!.interrupted,
    ).toBe(true);
    const outcome = await handle.api.handleHook({
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-steer",
        prompt: "go on",
      },
    });
    expect(JSON.stringify(outcome)).toContain("stop and read the brief");
    const applied = handle.wal
      .read(uuid)
      .filter((e) => e.kind === "oxagen:command_applied")
      .at(-1)!;
    expect(applied.attrs["command.interrupted"]).toBe("1");
  });

  it("refuses every model call while the host is suspended", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, port } = await boot(fake.url, {
      bundle: { host_status: "suspended" },
    });
    const answer = await call(port, {
      path: "/openai/v1/chat/completions",
      body: "{}",
    });
    expect(answer.status).toBe(403);
    expect(answer.headers["x-oxagen-refusal"]).toBe("host_suspended");
    expect(
      handle.wal
        .read(handle.hostRecorder.sessionUuid)
        .some((e) => e.kind === "policy_decision"),
    ).toBe(true);
  });

  it("offers beforeForward the request and sends what it returns, streaming intact", async () => {
    const fake = await vendor((req, res) => {
      if ((req.url ?? "").includes("messages"))
        streamingAnthropic(60)(req, res, undefined as never);
      else {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end("data: {}\n\n");
      }
    });
    const seenSessions: Array<string | undefined> = [];
    const { port, session, frames } = await boot(fake.url, {
      daemon: {
        beforeForward: (request) => {
          seenSessions.push(request.session?.harnessSessionId);
          if (request.json === undefined) return request;
          return {
            ...request,
            json:
              request.provider === "anthropic"
                ? withAnthropicSystemBlock(
                    request.json,
                    "STEER: prefer small diffs",
                  )
                : withOpenAiInstructions(
                    request.json,
                    "STEER: prefer small diffs",
                  ),
          };
        },
      },
    });
    const uuid = await session("sess-seam");
    const answer = await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Claude-Code-Session-Id",
        "sess-seam",
        "Content-Type",
        "application/json",
      ],
      body: JSON.stringify({
        model: "claude-sonnet-5",
        stream: true,
        system: "you are helpful",
        messages: [],
      }),
    });
    expect(answer.body.toString()).toBe(ANTHROPIC_EVENTS.join(""));
    expect(
      answer.arrivals.at(-1)! - answer.arrivals[0]!,
    ).toBeGreaterThanOrEqual(100);
    const sent = fake.requests[0]!;
    expect(JSON.parse(sent.body.toString()).system).toEqual([
      { type: "text", text: "you are helpful" },
      { type: "text", text: "STEER: prefer small diffs" },
    ]);
    expect(sent.rawHeaders[sent.rawHeaders.indexOf("Content-Length") + 1]).toBe(
      String(sent.body.length),
    );
    expect(frames(uuid)[0]!.attrs).toMatchObject({
      "oxagen.request_injected": "1",
      "oxagen.request_digest": sha(sent.body),
    });
    expect(seenSessions).toEqual(["sess-seam"]);

    // OpenAI, from a zstd body: the changed body goes out as plain JSON.
    await call(port, {
      path: "/openai/v1/responses",
      headers: ["x-oxagen-session", "sess-seam", "Content-Encoding", "zstd"],
      body: zstdCompressSync(
        Buffer.from(
          JSON.stringify({ model: "gpt-5", instructions: "base", input: [] }),
        ),
      ),
    });
    const openai = fake.requests[1]!;
    expect(JSON.parse(openai.body.toString()).instructions).toBe(
      "base\n\nSTEER: prefer small diffs",
    );
    expect(openai.rawHeaders.map((h) => h.toLowerCase())).not.toContain(
      "content-encoding",
    );
  });

  it("sends the original when beforeForward throws or stalls", async () => {
    const fake = await vendor(streamingAnthropic(1));
    let mode: "throw" | "stall" = "throw";
    const { port, log } = await boot(fake.url, {
      daemon: {
        beforeForward: (request) => {
          if (mode === "throw") throw new Error("assembler down");
          return new Promise(() => undefined).then(() => request);
        },
      },
    });
    const body = JSON.stringify({ model: "claude-sonnet-5" });
    expect(
      (await call(port, { path: "/anthropic/v1/messages", body })).status,
    ).toBe(200);
    mode = "stall";
    expect(
      (await call(port, { path: "/anthropic/v1/messages", body })).status,
    ).toBe(200);
    expect(fake.requests.map((r) => r.body.toString())).toEqual([body, body]);
    expect(log.filter((line) => line.includes("beforeForward"))).toHaveLength(
      2,
    );
  });

  it("answers only loopback: Host, Origin and the peer address are all checked", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { port } = await boot(fake.url);
    const rebound = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["Host", "evil.example"],
      body: "{}",
    });
    expect(rebound.status).toBe(403);
    const browser = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["Origin", "https://evil.example"],
      body: "{}",
    });
    expect(browser.status).toBe(403);
    expect(fake.requests).toHaveLength(0);

    // A peer that is not loopback, which the bind address already keeps out.
    const proxy = createModelProxy({
      registry: undefined as never,
      hostRecorder: () => undefined as never,
      record: () => undefined,
      policy: () => undefined as never,
      port: () => 4319,
      log: () => undefined,
      now: Date.now,
    });
    const sent: { status?: number } = {};
    proxy.handle(
      {
        headers: { host: "127.0.0.1:4319" },
        socket: { remoteAddress: "10.0.0.7" },
        method: "POST",
        resume: () => undefined,
      } as never,
      {
        writeHead: (status: number) => {
          sent.status = status;
        },
        end: () => undefined,
      } as never,
    );
    await until(() => sent.status !== undefined);
    expect(sent.status).toBe(403);
    proxy.close();
  });

  it("binds 127.0.0.1 and nothing else", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { port } = await boot(fake.url);
    const { networkInterfaces } = await import("node:os");
    const external = Object.values(networkInterfaces())
      .flat()
      .find((n) => n !== undefined && n.family === "IPv4" && !n.internal);
    if (external === undefined) return;
    const outcome = await new Promise<string>((resolve) => {
      const socket = connect({ host: external.address, port, timeout: 1500 });
      socket.on("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.on("error", () => resolve("refused"));
      socket.on("timeout", () => {
        socket.destroy();
        resolve("refused");
      });
    });
    expect(outcome).toBe("refused");
  });

  it("survives malformed input, an upstream reset and an unreachable upstream", async () => {
    let mode: "reset" | "ok" = "reset";
    const fake = await vendor((req, res, seen) => {
      if (mode === "ok") return streamingAnthropic(1)(req, res, seen);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(ANTHROPIC_EVENTS[0]);
      setTimeout(() => res.destroy(), 30);
    });
    const { handle, port, session, frames, log } = await boot(fake.url);
    const uuid = await session("sess-hard");
    const headers = ["X-Claude-Code-Session-Id", "sess-hard"];

    const garbage = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () =>
        socket.write("NOT HTTP AT ALL\r\n\x00\x01\r\n\r\n"),
      );
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
    });
    expect(garbage).toContain("400 Bad Request");

    const reset = await call(port, {
      path: "/anthropic/v1/messages",
      headers,
      body: "{}",
    });
    expect(reset.error).toBeDefined();
    await until(() => frames(uuid).length === 1);
    expect(frames(uuid)[0]!.body).toMatchObject({
      api_error_class: "upstream_reset",
      input_tokens: 1000,
    });
    expect(
      log.filter((line) => line.includes("failed mid-response")),
    ).toHaveLength(1);

    const upgrade = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () =>
        socket.write(
          "GET /backend-api/codex/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        ),
      );
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("close", () => resolve(text));
    });
    expect(upgrade).toContain("426 Upgrade Required");

    expect((await call(port, { path: "/nope", body: "{}" })).status).toBe(404);
    const large = await call(port, {
      path: "/anthropic/v1/messages",
      headers,
      body: Buffer.alloc(70 * 1024 * 1024, 0x61),
    });
    expect([413, 0]).toContain(large.status);

    mode = "ok";
    const fine = await call(port, {
      path: "/anthropic/v1/messages",
      headers,
      body: "{}",
    });
    expect(fine.status).toBe(200);
    const health = await call(port, { method: "GET", path: "/healthz" });
    expect(JSON.parse(health.body.toString())).toMatchObject({
      ok: true,
      gateway: { listening: true, port },
    });
    expect(handle.api.status()["gateway"]).toEqual({
      listening: true,
      port,
      routes: ["/anthropic", "/backend-api/codex", "/openai/v1", "/v1"],
      calls_observed: 2,
    });

    await fake.close();
    const dead = await call(port, {
      path: "/anthropic/v1/messages",
      headers,
      body: "{}",
    });
    expect(dead.status).toBe(502);
    expect(JSON.parse(dead.body.toString())).toMatchObject({
      type: "error",
      error: { type: "api_error" },
    });
    expect(frames(uuid).at(-1)!.body).toMatchObject({
      api_error_class: "upstream_unreachable",
      cost_basis: "observed_no_usage",
    });
  });

  it("serves concurrent streams without mixing their frames", async () => {
    const fake = await vendor(streamingAnthropic(20));
    const { port, session, frames } = await boot(fake.url);
    const ids = ["c-1", "c-2", "c-3", "c-4", "c-5", "c-6"];
    const uuids = await Promise.all(ids.map((id) => session(id)));
    const answers = await Promise.all(
      ids.map((id) =>
        call(port, {
          path: "/anthropic/v1/messages",
          headers: ["X-Claude-Code-Session-Id", id],
          body: "{}",
        }),
      ),
    );
    expect(
      answers.every((a) => a.body.toString() === ANTHROPIC_EVENTS.join("")),
    ).toBe(true);
    for (const uuid of uuids) expect(frames(uuid)).toHaveLength(1);
  });

  it("computes the gateway tier from traffic, never from a written base URL", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const paths = scratchPaths();
    const home = join(paths.root, "..");
    // The base URL is written for both harnesses before any session runs.
    await applyModelBaseUrls({
      home,
      port: 4319,
      harnesses: ["claude-code", "codex"],
    });
    const { handle, port, session } = await boot(fake.url, { paths });
    await session("routed");
    await session("bypassed");
    const tiers = () =>
      Object.fromEntries(
        (handle.api.status()["sessions"] as Array<Record<string, unknown>>)
          .filter(
            (s) =>
              s["session_id"] === "routed" || s["session_id"] === "bypassed",
          )
          .map((s) => [
            s["session_id"],
            [s["enforcement_tier"], s["model_calls_observed"]],
          ]),
      );
    expect(tiers()).toEqual({
      routed: ["harness", 0],
      bypassed: ["harness", 0],
    });
    await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Claude-Code-Session-Id", "routed"],
      body: "{}",
    });
    expect(tiers()).toEqual({
      routed: ["gateway", 1],
      bypassed: ["harness", 0],
    });
  });

  it("forwards to the base URL enrollment displaced, so a corporate gateway still gets the call", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const paths = scratchPaths();
    const home = join(paths.root, "..");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: `${fake.url}/corp/anthropic` },
      }),
    );
    await applyModelBaseUrls({ home, port: 4319, harnesses: ["claude-code"] });
    const { port } = await boot("http://127.0.0.1:1", {
      paths,
      daemon: { modelUpstreams: {} },
    });
    expect(
      (await call(port, { path: "/anthropic/v1/messages", body: "{}" })).status,
    ).toBe(200);
    expect(fake.requests[0]!.url).toBe("/corp/anthropic/v1/messages");
  });
});

describe("the model proxy listener", () => {
  it("rebinds after the port is freed, and says it is not listening until then", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const port = (blocker.address() as { port: number }).port;
    const log: string[] = [];
    const listener = createModelProxyListener({
      proxy: {
        handle: (_req: IncomingMessage, res: ServerResponse) => res.end("ok"),
        handleUpgrade: () => undefined,
      } as never,
      port,
      log: (line) => log.push(line),
      retryMs: 20,
      maxRetryMs: 40,
    });
    await listener.start();
    expect(listener.listening()).toBe(false);
    expect(log[0]).toContain("EADDRINUSE");
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await until(() => listener.listening());
    expect(listener.port()).toBe(port);
    expect(listener.restarts()).toBeGreaterThanOrEqual(1);
    const answer = await call(port, { method: "GET", path: "/" });
    expect(answer.body.toString()).toBe("ok");
    await listener.close();
    expect(listener.listening()).toBe(false);
    await listener.close();
  });
});

describe("the wire and the host file", () => {
  it("parses model_prices, refuses a row it does not know, and advertises the feature", () => {
    const bundle = bundleSigner().sign(
      unsignedBundle({ model_prices: PRICES }),
    );
    expect(policyBundleSchema.parse(bundle).model_prices).toEqual(PRICES);
    const bad = { ...bundle, model_prices: [{ ...PRICES[0], surprise: 1 }] };
    expect(policyBundleSchema.safeParse(bad).success).toBe(false);
    // The whole advertised list, not a subset: a field added to
    // `policyBundleSchema` without its name here would ship a daemon that
    // parses it and never says so, and the control plane would keep gating it.
    expect(TACHO_BUNDLE_FEATURES).toEqual([
      "gateway_tools",
      "model_prices",
      "hook_fail_open",
    ]);
  });

  it("puts the proxy next to the collector's port unless the host file pins one", () => {
    expect(modelProxyPortFor({ port: 47001 })).toBe(47002);
    expect(modelProxyPortFor({ port: 65535 })).toBe(65534);
    expect(modelProxyPortFor({ port: 47001, model_proxy_port: 5123 })).toBe(
      5123,
    );
  });
});
