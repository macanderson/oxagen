/**
 * The loopback model proxy end to end: a real daemon on ephemeral ports, a
 * fake vendor behind it (a plain node http server), and a client that talks
 * to the proxy the way Claude Code and Codex do.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { TachoEvent } from "../envelope";
import type { FetchLike } from "../host/control-client";
import { openCredentialStore } from "../host/credential-store";
import { modelProxyPortFor, writeHostFile } from "../host/host-file";
import { applyModelBaseUrls } from "../host/model-base-url";
import {
  generateRunTokenKey,
  mintRunToken,
  peekRunTokenClaims,
  readRunTokenKey,
} from "../host/run-token";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import {
  type AgentDaySpend,
  type ControlEnvelope,
  controlEnvelopeSchema,
  type DeliveredCommand,
  type PolicyBundle,
  policyBundleSchema,
  TACHO_BUNDLE_FEATURES,
  TACHO_CREDENTIAL_BASIS_ATTR,
  TACHO_MAX_BODY_BYTES,
  TACHO_RUN_TOKEN_ATTR,
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
  // What the control plane has recorded of the agent's day, sent on every
  // envelope while set (ADR-160).
  let daySpend: AgentDaySpend | undefined;
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    // Built only for the routes that carry an envelope. The bundle route
    // does not, and splicing here would let a bundle poll swallow commands.
    const control = (): ControlEnvelope => ({
      host_status: "active",
      deny_generation: { org: 1, workspace: 1 },
      bundle_etag: "etag-3",
      commands: queue.splice(0),
      ...(daySpend !== undefined ? { agent_day_spend: daySpend } : {}),
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
    recordDaySpend: (next: AgentDaySpend) => {
      daySpend = next;
    },
    // Envelopes after this carry no day figure at all.
    clearDaySpend: () => {
      daySpend = undefined;
    },
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
  // A model is priced by its own row or its row plus a date stamp, never by
  // another model's prefix, so Codex's model needs a row of its own.
  {
    provider: "openai",
    model: "gpt-5-codex",
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
    const session = async (id: string, harness?: "codex" | "stella") => {
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
    expect(at("/stella/anthropic/v1/messages")).toEqual([
      "anthropic.messages",
      "https://api.anthropic.com/v1/messages",
    ]);
    expect(
      resolveModelRoute("/stella/anthropic/v1/messages", {})?.harness,
    ).toBe("stella");
    expect(
      resolveModelRoute("/anthropic/v1/messages", {})?.harness,
    ).toBeUndefined();
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

  it("refuses an agent at its daily budget across its sessions and a restart, and names the UTC day (ADR-160)", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const paths = scratchPaths();
    // A daily ceiling alone: no per-run figure. Before ADR-160 this mandate
    // enforced nothing.
    const budget = { mode: "enforced" as const, daily_limit_usd: 0.01 };
    let clock = Date.parse("2026-09-24T12:00:00.000Z");
    const daemon = { now: () => clock };
    const first = await boot(fake.url, { paths, bundle: { budget }, daemon });
    const a = await first.session("sess-day-a");
    const ask = (port: number, id: string) =>
      call(port, {
        path: "/anthropic/v1/messages",
        headers: ["X-Api-Key", FAKE_KEY, "X-Claude-Code-Session-Id", id],
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });

    // $0.0111 observed against a $0.01 day: the call that crosses it finishes.
    expect((await ask(first.port, "sess-day-a")).status).toBe(200);
    // A second session of the same agent is refused: the day is the agent's.
    const b = await first.session("sess-day-b");
    const refused = await ask(first.port, "sess-day-b");
    expect(refused.status).toBe(403);
    expect(refused.headers["x-oxagen-refusal"]).toBe("daily_budget_exceeded");
    const error = JSON.parse(refused.body.toString()) as {
      error: { message: string };
    };
    expect(error.error.message).toContain(
      "$0.01 observed of a $0.01 limit on 2026-09-24 (UTC)",
    );
    expect(error.error.message).toContain(
      "It resets at 2026-09-25T00:00:00.000Z",
    );
    expect(fake.requests).toHaveLength(1);
    const [decision] = first.frames(b, "policy_decision");
    expect(decision!.body).toMatchObject({
      policy_decision: "deny",
      policy_source: "bundle",
      policy_reason_code: "daily_budget_exceeded",
    });
    expect(decision!.attrs).toMatchObject({
      "oxagen.day": "2026-09-24",
      "oxagen.day_spend_usd_micros": String(ANTHROPIC_COST),
    });
    // The crossing call is on the record under the day it was charged to.
    const [call1] = first.frames(a);
    expect(call1!.ts.startsWith("2026-09-24T12:00:00")).toBe(true);

    // A restart reads the day back from the WAL before admitting a call.
    await first.handle.stop();
    const second = await boot(fake.url, { paths, bundle: { budget }, daemon });
    await second.session("sess-day-c");
    expect((await ask(second.port, "sess-day-c")).status).toBe(403);
    expect(fake.requests).toHaveLength(1);

    // 00:00 UTC opens a new day with that day's spend, which is none.
    clock = Date.parse("2026-09-25T00:00:00.000Z");
    expect((await ask(second.port, "sess-day-c")).status).toBe(200);
    expect(fake.requests).toHaveLength(2);
  });

  it("charges a call settling at 23:59:59.999 UTC to that day, and the next call to the next day", async () => {
    const fake = await vendor(streamingAnthropic(1));
    // A ceiling of two calls: one crossing call per day stays admitted.
    const budget = {
      mode: "enforced" as const,
      daily_limit_usd: (ANTHROPIC_COST * 1.5) / 1_000_000,
    };
    let clock = Date.parse("2026-09-24T23:59:59.999Z");
    const booted = await boot(fake.url, {
      bundle: { budget },
      daemon: { now: () => clock },
    });
    const uuid = await booted.session("sess-midnight");
    const ask = () =>
      call(booted.port, {
        path: "/anthropic/v1/messages",
        headers: [
          "X-Api-Key",
          FAKE_KEY,
          "X-Claude-Code-Session-Id",
          "sess-midnight",
        ],
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });

    expect((await ask()).status).toBe(200);
    clock = Date.parse("2026-09-25T00:00:00.000Z");
    // The first call belongs to the 24th, so the 25th starts at zero: two
    // calls fit before this day's ceiling, and the third is refused.
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    const third = await ask();
    expect(third.headers["x-oxagen-refusal"]).toBe("daily_budget_exceeded");
    expect(third.body.toString()).toContain("on 2026-09-25 (UTC)");
    const calls = booted.frames(uuid);
    expect(calls.map((frame) => frame.ts.slice(0, 10))).toEqual([
      "2026-09-24",
      "2026-09-25",
      "2026-09-25",
    ]);
  });

  it("counts the agent's other hosts from the control envelope, and ignores a figure for another day (negative)", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const budget = { mode: "enforced" as const, daily_limit_usd: 1 };
    const booted = await boot(fake.url, {
      bundle: { budget },
      daemon: { now: () => Date.parse("2026-09-24T09:00:00.000Z") },
    });
    await booted.session("sess-fleet");
    const ask = () =>
      call(booted.port, {
        path: "/anthropic/v1/messages",
        headers: [
          "X-Api-Key",
          FAKE_KEY,
          "X-Claude-Code-Session-Id",
          "sess-fleet",
        ],
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });

    // Yesterday's figure says nothing about today.
    booted.plane.recordDaySpend({
      day: "2026-09-23",
      this_host_usd_micros: 0,
      other_hosts_usd_micros: 5_000_000,
    });
    await booted.handle.tick();
    expect((await ask()).status).toBe(200);

    // Today's: the other hosts spent $0.995, and this host's own $0.0111
    // takes the agent past $1. Read with the two figures swapped, the total
    // would be $0.995 and the call would be admitted.
    booted.plane.recordDaySpend({
      day: "2026-09-24",
      this_host_usd_micros: 0,
      other_hosts_usd_micros: 995_000,
    });
    await booted.handle.tick();
    const refused = await ask();
    expect(refused.headers["x-oxagen-refusal"]).toBe("daily_budget_exceeded");
    expect(fake.requests).toHaveLength(1);

    // An envelope with no figure says nothing new: the last one stands.
    booted.plane.clearDaySpend();
    await booted.handle.tick();
    expect((await ask()).headers["x-oxagen-refusal"]).toBe(
      "daily_budget_exceeded",
    );
    expect(fake.requests).toHaveLength(1);
  });

  it("holds the day ceiling for a call no session was found for, and charges that call to the day", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const budget = { mode: "enforced" as const, daily_limit_usd: 0.01 };
    const clock = () => Date.parse("2026-09-24T09:00:00.000Z");
    const ask = (port: number, id?: string) =>
      call(port, {
        path: "/anthropic/v1/messages",
        headers: [
          "X-Api-Key",
          FAKE_KEY,
          ...(id !== undefined ? ["X-Claude-Code-Session-Id", id] : []),
        ],
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });

    // Two live sessions, so a call without a session header is unattributed.
    const first = await boot(fake.url, {
      bundle: { budget },
      daemon: { now: clock },
    });
    await first.session("sess-u-a");
    await first.session("sess-u-b");
    expect((await ask(first.port, "sess-u-a")).status).toBe(200);
    const unattributed = await ask(first.port);
    expect(unattributed.headers["x-oxagen-refusal"]).toBe(
      "daily_budget_exceeded",
    );
    expect(fake.requests).toHaveLength(1);

    // The other way round: an unattributed call spends the day, and a
    // session that has spent nothing of its own is refused.
    const second = await boot(fake.url, {
      bundle: { budget },
      daemon: { now: clock },
    });
    await second.session("sess-u-c");
    await second.session("sess-u-d");
    expect((await ask(second.port)).status).toBe(200);
    expect(
      (await ask(second.port, "sess-u-c")).headers["x-oxagen-refusal"],
    ).toBe("daily_budget_exceeded");
    expect(fake.requests).toHaveLength(2);
  });

  it("reads back only today's observed proxy calls after a restart (negative)", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const paths = scratchPaths();
    // Room for one call and a half: one more call is admitted after the
    // restart, then the next is refused.
    const budget = {
      mode: "enforced" as const,
      daily_limit_usd: (ANTHROPIC_COST * 1.5) / 1_000_000,
    };
    let clock = Date.parse("2026-09-24T23:59:59.000Z");
    const daemon = { now: () => clock };
    const first = await boot(fake.url, { paths, bundle: { budget }, daemon });
    await first.session("sess-restart");
    const ask = (port: number) =>
      call(port, {
        path: "/anthropic/v1/messages",
        headers: [
          "X-Api-Key",
          FAKE_KEY,
          "X-Claude-Code-Session-Id",
          "sess-restart",
        ],
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });
    // Yesterday's call, in the same session file as today's.
    expect((await ask(first.port)).status).toBe(200);
    clock = Date.parse("2026-09-25T00:01:00.000Z");
    expect((await ask(first.port)).status).toBe(200);
    // A priced llm_call the proxy did not observe (a harness's own
    // telemetry) is not the meter and must not count toward the day.
    const recorder = first.handle.registry.get("sess-restart")!.recorder;
    first.handle.wal.append([
      recorder.sealCollectorEvent("llm_call", { cost_usd_micros: 5_000_000 }),
    ]);
    await first.handle.stop();

    clock = Date.parse("2026-09-25T00:02:00.000Z");
    const second = await boot(fake.url, { paths, bundle: { budget }, daemon });
    await second.session("sess-restart");
    expect((await ask(second.port)).status).toBe(200);
    expect((await ask(second.port)).headers["x-oxagen-refusal"]).toBe(
      "daily_budget_exceeded",
    );
    expect(fake.requests).toHaveLength(3);
  });

  it("charges a stream cut before its closing count to the day at its estimate, and reads it back after a restart", async () => {
    // 4,000 bytes of text is about 1,000 output tokens, which puts the call
    // at $0.0186. Billed at the one output token the stream opened with, it
    // would be $0.0036 and leave the day's $0.01 open.
    const text = "t".repeat(4000);
    let cut = true;
    const fake = await vendor((req, res, seen) => {
      if (!cut) return streamingAnthropic(1)(req, res, seen);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(ANTHROPIC_EVENTS[0]);
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`,
      );
      setTimeout(() => res.destroy(), 30);
    });
    const paths = scratchPaths();
    const budget = { mode: "enforced" as const, daily_limit_usd: 0.01 };
    const daemon = { now: () => Date.parse("2026-09-24T09:00:00.000Z") };
    const first = await boot(fake.url, { paths, bundle: { budget }, daemon });
    const uuid = await first.session("sess-cut-day");
    const ask = (port: number) =>
      call(port, {
        path: "/anthropic/v1/messages",
        headers: [
          "X-Api-Key",
          FAKE_KEY,
          "X-Claude-Code-Session-Id",
          "sess-cut-day",
        ],
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });

    await ask(first.port);
    await until(() => first.frames(uuid).length === 1);
    expect(first.frames(uuid)[0]!.body).toMatchObject({
      api_error_class: "upstream_reset",
      output_tokens: 1000,
      cost_usd_micros: 3000 + 15_000 + 600,
      cost_basis: "estimated",
    });
    cut = false;
    expect((await ask(first.port)).headers["x-oxagen-refusal"]).toBe(
      "daily_budget_exceeded",
    );

    // The estimate is on the chain, so a restart counts it too.
    await first.handle.stop();
    const second = await boot(fake.url, { paths, bundle: { budget }, daemon });
    await second.session("sess-cut-day");
    expect((await ask(second.port)).headers["x-oxagen-refusal"]).toBe(
      "daily_budget_exceeded",
    );
    expect(fake.requests).toHaveLength(1);
  });

  it("refuses nothing on the day ceiling under an observed budget, and names the session ceiling first when both are spent", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const clock = () => Date.parse("2026-09-24T09:00:00.000Z");
    const ask = (port: number) =>
      call(port, {
        path: "/anthropic/v1/messages",
        headers: ["X-Api-Key", FAKE_KEY, "X-Claude-Code-Session-Id", "sess-m"],
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });

    const observed = await boot(fake.url, {
      bundle: { budget: { mode: "observed" as const, daily_limit_usd: 0.01 } },
      daemon: { now: clock },
    });
    await observed.session("sess-m");
    expect((await ask(observed.port)).status).toBe(200);
    expect((await ask(observed.port)).status).toBe(200);

    const both = await boot(fake.url, {
      bundle: {
        budget: {
          mode: "enforced" as const,
          session_limit_usd: 0.01,
          daily_limit_usd: 0.01,
        },
      },
      daemon: { now: clock },
    });
    await both.session("sess-m");
    expect((await ask(both.port)).status).toBe(200);
    expect((await ask(both.port)).headers["x-oxagen-refusal"]).toBe(
      "session_budget_exceeded",
    );
  });

  it("refuses a model the mandate does not permit, names it on the frame, and forwards a permitted one", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const paths = scratchPaths();
    const first = await boot(fake.url, {
      paths,
      bundle: {
        budget: { mode: "enforced" as const },
        models: { allow: ["claude-opus-*"], deny: ["claude-opus-5-legacy"] },
      },
    });
    const uuid = await first.session("sess-models");
    const ask = (model: string) =>
      call(first.port, {
        path: "/anthropic/v1/messages",
        headers: [
          "X-Api-Key",
          FAKE_KEY,
          "X-Claude-Code-Session-Id",
          "sess-models",
        ],
        body: JSON.stringify({ model, stream: true }),
      });

    // Off the allowlist.
    const off = await ask("claude-sonnet-5");
    expect(off.status).toBe(403);
    expect(off.headers["x-oxagen-refusal"]).toBe("model_not_permitted");
    expect(off.body.toString()).toContain("claude-sonnet-5");
    // A deny beats the allow it also matches.
    const denied = await ask("claude-opus-5-legacy");
    expect(denied.status).toBe(403);
    expect(denied.headers["x-oxagen-refusal"]).toBe("model_not_permitted");
    // Nothing reached the vendor yet: the refusal is before the forward.
    expect(fake.requests).toHaveLength(0);
    // On the allowlist, so it goes.
    expect((await ask("claude-opus-5-20260101")).status).toBe(200);
    expect(fake.requests).toHaveLength(1);

    const decisions = first.frames(uuid, "policy_decision");
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.body).toMatchObject({
      policy_decision: "deny",
      policy_source: "bundle",
      policy_reason_code: "model_not_permitted",
    });
    // The frame names the model, so an operator knows which entry to add.
    expect(decisions[0]!.attrs).toMatchObject({
      "oxagen.refused": "model_call",
      "oxagen.model": "claude-sonnet-5",
    });
    await first.handle.stop();
  });

  it("refuses a body that names two models rather than checking one and forwarding the other", async () => {
    // The bypass this closes: `leadingModel` reads the first `"model"` member
    // and `JSON.parse` keeps the last, so a body with two of them could pass
    // the allowlist on the first and reach the vendor asking for the second.
    // The proxy forwards the original bytes, so whatever it checked, the vendor
    // would run the duplicate. No single string describes such a request, so it
    // is refused rather than guessed at.
    const fake = await vendor(streamingAnthropic(1));
    const paths = scratchPaths();
    const first = await boot(fake.url, {
      paths,
      bundle: {
        budget: { mode: "enforced" as const },
        models: { allow: ["claude-opus-*"], deny: [] },
      },
    });
    const uuid = await first.session("sess-dup");
    const ask = (body: string) =>
      call(first.port, {
        path: "/anthropic/v1/messages",
        headers: [
          "X-Api-Key",
          FAKE_KEY,
          "X-Claude-Code-Session-Id",
          "sess-dup",
        ],
        body,
      });

    // The first member is on the allowlist, the second is not.
    const smuggled = await ask(
      '{"model":"claude-opus-5-20260101","model":"claude-sonnet-5","stream":true}',
    );
    expect(smuggled.status).toBe(403);
    expect(smuggled.headers["x-oxagen-refusal"]).toBe("model_ambiguous");
    // Nothing reached the vendor, so the denied model never ran.
    expect(fake.requests).toHaveLength(0);

    // The same body with one model goes through, so the refusal is about the
    // duplicate and not about the allowlist.
    expect(
      (await ask('{"model":"claude-opus-5-20260101","stream":true}')).status,
    ).toBe(200);
    expect(fake.requests).toHaveLength(1);

    const decisions = first.frames(uuid, "policy_decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.body).toMatchObject({
      policy_decision: "deny",
      policy_source: "bundle",
      policy_reason_code: "model_ambiguous",
    });
    // The frame names the model a JSON parser would hand the vendor, which is
    // the last duplicate, not the first one the old read returned.
    expect(decisions[0]!.attrs).toMatchObject({
      "oxagen.model": "claude-sonnet-5",
      "oxagen.model_ambiguous": "true",
    });
    await first.handle.stop();
  });

  it("forwards a body that names two models when no models clause is armed, and marks its frame ambiguous", async () => {
    // With no `models` clause there is no list for a duplicate to slip past,
    // so the call is forwarded. The frame still records and prices one of the
    // two names, so it says the request did not pin a single model (#3726).
    const fake = await vendor(streamingAnthropic(1));
    const host = await boot(fake.url, {
      paths: scratchPaths(),
      bundle: { budget: { mode: "enforced" as const } },
    });
    const uuid = await host.session("sess-dup-open");
    const ask = (body: string) =>
      call(host.port, {
        path: "/anthropic/v1/messages",
        headers: [
          "X-Api-Key",
          FAKE_KEY,
          "X-Claude-Code-Session-Id",
          "sess-dup-open",
        ],
        body,
      });

    const twice = await ask(
      '{"model":"claude-opus-5-20260101","model":"claude-sonnet-5","stream":true}',
    );
    expect(twice.status).toBe(200);
    expect(
      await ask('{"model":"claude-sonnet-5","stream":true}'),
    ).toMatchObject({ status: 200 });
    expect(fake.requests).toHaveLength(2);

    const calls = host.frames(uuid);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.attrs["oxagen.model_ambiguous"]).toBe("true");
    // A body naming one model is pinned, and its frame carries no mark.
    expect(calls[1]!.attrs["oxagen.model_ambiguous"]).toBeUndefined();
    await host.handle.stop();
  });

  it.each([true, false])(
    "enforces models with an observed budget and correlated run %s",
    async (correlated) => {
      const fake = await vendor(streamingAnthropic(1));
      const host = await boot(fake.url, {
        paths: scratchPaths(),
        bundle: {
          budget: { mode: "observed" as const },
          models: { allow: [], deny: ["*"] },
        },
      });
      if (correlated) await host.session("sess-observed");
      const answer = await call(host.port, {
        path: "/anthropic/v1/messages",
        headers: [
          "X-Api-Key",
          FAKE_KEY,
          "X-Claude-Code-Session-Id",
          "sess-observed",
        ],
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });
      expect(answer.status).toBe(403);
      expect(answer.headers["x-oxagen-refusal"]).toBe("model_not_permitted");
      expect(fake.requests).toHaveLength(0);
      await host.handle.stop();
    },
  );

  it("refuses an unreadable model call when lists are armed", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const host = await boot(fake.url, {
      paths: scratchPaths(),
      bundle: {
        budget: { mode: "observed" },
        models: { allow: ["claude-*"], deny: [] },
      },
    });
    const answer = await call(host.port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", FAKE_KEY],
      body: "{}",
    });
    expect(answer.status).toBe(403);
    expect(answer.headers["x-oxagen-refusal"]).toBe("model_ambiguous");
    expect(fake.requests).toHaveLength(0);
    await host.handle.stop();
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

  it("files a call that names a sealed session on the host's chain, never after the session's terminal", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, port, frames } = await boot(fake.url);
    // No cwd, so the end seals on the spot with no git read to wait for.
    await handle.api.handleHook({
      payload: {
        hook_event_name: "SessionStart",
        session_id: "sess-closed",
        source: "startup",
      },
    });
    const uuid = handle.registry.get("sess-closed")!.recorder.sessionUuid;
    await handle.api.handleHook({
      payload: {
        hook_event_name: "SessionEnd",
        session_id: "sess-closed",
        reason: "other",
      },
    });
    expect(handle.registry.get("sess-closed")?.sealed).toBe(true);
    const before = handle.wal.read(uuid).length;
    await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Claude-Code-Session-Id", "sess-closed"],
      body: JSON.stringify({ model: "m" }),
    });
    expect(handle.wal.read(uuid)).toHaveLength(before);
    expect(
      frames(handle.hostRecorder.sessionUuid).map(
        (f) => f.attrs["oxagen.correlation"],
      ),
    ).toEqual(["session_closed"]);
    expect(fake.requests.map((r) => r.url)).toEqual(["/v1/messages"]);
  });

  it("files a call on Stella's prefix under the live Stella session, never a Claude Code one", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { port, session, frames } = await boot(fake.url);
    const claude = await session("sess-claude");
    const stella = await session("sess-stella", "stella");
    // Stella sends no session header. A Claude Code header on this prefix is
    // some other harness's, so it is not read either.
    await call(port, {
      path: "/stella/anthropic/v1/messages",
      body: JSON.stringify({ model: "m" }),
    });
    await call(port, {
      path: "/stella/anthropic/v1/messages",
      headers: ["X-Claude-Code-Session-Id", "sess-claude"],
      body: JSON.stringify({ model: "m" }),
    });
    expect(frames(stella).map((f) => f.attrs["oxagen.correlation"])).toEqual([
      "sole_live_session",
      "sole_live_session",
    ]);
    expect(frames(claude)).toHaveLength(0);
    expect(fake.requests.map((r) => r.url)).toEqual([
      "/v1/messages",
      "/v1/messages",
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

  it("cuts a paused session's model calls when the state write fails", async () => {
    const fake = await vendor((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(ANTHROPIC_EVENTS[0]);
    });
    const { handle, plane, port, session, paths } = await boot(fake.url);
    const uuid = await session("sess-full-disk");
    await handle.tick();
    const inFlight = call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Claude-Code-Session-Id", "sess-full-disk"],
      body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
    });
    await until(() => fake.requests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The pause takes effect, and then daemon.json cannot be written. The
    // redelivered pause is answered from the ledger, so this tick is the only
    // one that can cut the call.
    rmSync(paths.daemonState, { force: true });
    mkdirSync(join(paths.daemonState, "blocked"), { recursive: true });
    plane.queue({
      id: "cmd_pause",
      command: "pause",
      session_uuid: uuid,
      reason: "reviewing this run",
    });
    await handle.tick().catch(() => undefined);
    const cut = await Promise.race([
      inFlight,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), 2_000),
      ),
    ]);
    rmSync(paths.daemonState, { recursive: true, force: true });
    expect(cut?.error).toBeDefined();
  });

  // A 403 here read to Claude Code as a failed login ("Please run /login"),
  // so every launchd restart told the person their credentials were bad.
  it("answers a call cut off by the daemon stopping as retryable, not as a refusal", async () => {
    const fake = await vendor(() => undefined);
    const { handle, port, session } = await boot(fake.url);
    await session("sess-restart");
    const inFlight = call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Claude-Code-Session-Id", "sess-restart"],
      body: "{}",
    });
    await until(() => fake.requests.length === 1);
    await handle.stop();
    const answer = await inFlight;
    expect(answer.status).toBe(503);
    expect(answer.headers["x-oxagen-refusal"]).toBe("daemon_stopping");
    expect(answer.headers["x-should-retry"]).toBe("true");
    expect(answer.body.toString()).toContain("api_error");
  });

  // A 403 ended the turn in StopFailure, whose answer Claude Code ignores, so
  // the steer the cut made room for never reached the agent (#4019).
  it("marks a steer delivered as interrupt, and answers the cut call as retryable", async () => {
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
    expect(answer.status).toBe(503);
    expect(answer.headers["x-oxagen-refusal"]).toBe("steered_by_operator");
    expect(answer.headers["x-should-retry"]).toBe("true");
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
      routes: [
        "/anthropic",
        "/stella/anthropic",
        "/backend-api/codex",
        "/openai/v1",
        "/v1",
      ],
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

  it("folds a request over the cap once it has a prior, and ships the fold (P0-1)", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, port, session, frames } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-huge-fold");
    const headers = [
      "X-Api-Key",
      FAKE_KEY,
      "X-Claude-Code-Session-Id",
      "sess-huge-fold",
    ];
    // Under the cap on its own, so the first call ships and establishes a
    // prior a second call can actually dereference.
    const system = [{ type: "text", text: "S".repeat(900_000) }];
    const first = JSON.stringify({
      model: "claude-sonnet-5",
      stream: true,
      system,
      messages: [{ role: "user", content: PROMPT }],
    });
    await call(port, { path: "/anthropic/v1/messages", headers, body: first });
    await until(() => frames(uuid).length === 1);
    expect(
      frames(uuid)[0]!.attrs["oxagen.request_body_omitted"],
    ).toBeUndefined();

    // A big new message pushes the second call's raw body over the cap, even
    // though `system` repeats unchanged. Checking the raw bytes here — the
    // bug — would skip folding and ship no request half at all; folding
    // first brings the stored text down to just the new messages, which
    // fits comfortably.
    const bigReply = "C".repeat(200_000);
    const second = JSON.stringify({
      model: "claude-sonnet-5",
      stream: true,
      system,
      messages: [
        { role: "user", content: PROMPT },
        { role: "assistant", content: bigReply },
        { role: "user", content: "and then?" },
      ],
    });
    expect(Buffer.byteLength(second, "utf8")).toBeGreaterThan(
      TACHO_MAX_BODY_BYTES,
    );
    await call(port, {
      path: "/anthropic/v1/messages",
      headers,
      body: second,
    });
    await until(() => frames(uuid).length === 2);

    const [, two] = frames(uuid);
    expect(two!.attrs["oxagen.request_body_omitted"]).toBeUndefined();
    expect(two!.attrs["oxagen.request_prior_digest"]).toBe(sha(first));
    const [body] = handle.wal.bodiesFor([two!]);
    expect(body).toBeDefined();
    const exchange = JSON.parse(
      Buffer.from(body!.bytes_base64, "base64").toString("utf8"),
    ) as { request: string; response: string };
    const stored = JSON.parse(exchange.request) as Record<string, unknown>;
    expect(stored["messages"]).toEqual([
      { role: "assistant", content: bigReply },
      { role: "user", content: "and then?" },
    ]);
    expect(stored).not.toHaveProperty("system");
    // The response half renders too: `content-blocks.ts`'s `responseWire`
    // used to require both halves as strings, so a request-only exchange
    // rendered fine but a response paired with a folded request also had to
    // keep working.
    expect(exchange.response).toBe(ANTHROPIC_EVENTS.join(""));
  });

  it("forgets a session's remembered prior when this call's own body never shipped (P1-4)", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { port, session, frames } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-forget-prior");
    const headers = [
      "X-Api-Key",
      FAKE_KEY,
      "X-Claude-Code-Session-Id",
      "sess-forget-prior",
    ];
    const system = [
      { type: "text", text: "S".repeat(TACHO_MAX_BODY_BYTES + 4096) },
    ];
    const first = JSON.stringify({
      model: "claude-sonnet-5",
      stream: true,
      system,
      messages: [{ role: "user", content: PROMPT }],
    });
    await call(port, { path: "/anthropic/v1/messages", headers, body: first });
    await until(() => frames(uuid).length === 1);
    expect(frames(uuid)[0]!.attrs["oxagen.request_body_omitted"]).toBe(
      "too_large",
    );

    // A second call that repeats the same oversized `system` block. Had the
    // first call's digest stayed remembered as a valid prior (the bug this
    // guards), this would fold `system` out, ship a small body, and point
    // `unchanged_from` at a call whose own body the WAL never holds. The fix
    // forgets the session's memory instead, so this call has nothing to fold
    // against and is, correctly, over the cap again.
    const second = JSON.stringify({
      model: "claude-sonnet-5",
      stream: true,
      system,
      messages: [{ role: "user", content: "a different question" }],
    });
    await call(port, {
      path: "/anthropic/v1/messages",
      headers,
      body: second,
    });
    await until(() => frames(uuid).length === 2);
    const [, two] = frames(uuid);
    expect(two!.attrs["oxagen.request_prior_digest"]).toBeUndefined();
    expect(two!.attrs["oxagen.request_body_omitted"]).toBe("too_large");
  });

  it("keeps usage and cost when the response is too large to hold (P1-5)", async () => {
    const oversized = "y".repeat(TACHO_MAX_BODY_BYTES + 4096);
    const reply = `{"id":"msg_big2","model":"claude-sonnet-5","content":[{"type":"text","text":"${oversized}"}],"usage":{"input_tokens":7,"output_tokens":3}}`;
    const fake = await vendor((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(reply);
    });
    const { port, session, frames } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-huge-usage");
    await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Api-Key",
        FAKE_KEY,
        "X-Claude-Code-Session-Id",
        "sess-huge-usage",
      ],
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    await until(() => frames(uuid).length === 1);
    const [frame] = frames(uuid);
    // The response body is too large to hold, but the usage the vendor
    // reported crossed the wire before the cap did and is still on the frame.
    expect(frame!.body).toMatchObject({ input_tokens: 7, output_tokens: 3 });
    expect(frame!.attrs["oxagen.response_body_omitted"]).toBe("too_large");
  });

  it("clamps an absurd model name so sealing the frame never throws, and the call still answers (P0-2)", async () => {
    const fake = await vendor((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":{"message":"bad model"}}');
    });
    const { port, session, frames } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-huge-model");
    const hugeModel = "m".repeat(600);
    const answer = await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Api-Key",
        FAKE_KEY,
        "X-Claude-Code-Session-Id",
        "sess-huge-model",
      ],
      body: JSON.stringify({ model: hugeModel, messages: [] }),
    });
    // The client got its answer: an unclamped model name used to throw
    // sealing the frame, from inside an event listener nothing above it
    // could catch, which left nothing here to answer at all.
    expect(answer.status).toBe(400);
    await until(() => frames(uuid).length === 1);
    const model = (frames(uuid)[0]!.body as Record<string, unknown>)["model"];
    expect(typeof model).toBe("string");
    expect((model as string).length).toBeLessThanOrEqual(512);

    // The daemon is still standing: a second, ordinary call still answers.
    const again = await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Api-Key",
        FAKE_KEY,
        "X-Claude-Code-Session-Id",
        "sess-huge-model",
      ],
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    expect(again.status).toBe(400);
  });

  it("settles and frees the in-flight slot when the response cannot be decoded (P1-3)", async () => {
    const fake = await vendor((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      });
      // Not gzip at all: the decoder errors instead of ending normally.
      res.end(Buffer.from("this is not gzip"));
    });
    const { port, session, frames } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-bad-gzip");
    const answer = await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Api-Key",
        FAKE_KEY,
        "X-Claude-Code-Session-Id",
        "sess-bad-gzip",
      ],
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    expect(answer.status).toBe(200);
    // A frame still seals: a decoder failure used to hang forever waiting on
    // an `end` gzip was never going to emit, leaking the in-flight entry.
    await until(() => frames(uuid).length === 1);
    expect(frames(uuid)[0]!.attrs["oxagen.response_body_omitted"]).toBe(
      "not_decoded",
    );
  });

  it("decodes a deflate request, and records why one it cannot decode has no body (P2-9)", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, port, session, frames } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-deflate");
    const sent = JSON.stringify({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hello deflate" }],
    });
    await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Api-Key",
        FAKE_KEY,
        "X-Claude-Code-Session-Id",
        "sess-deflate",
        "Content-Encoding",
        "deflate",
      ],
      body: deflateSync(Buffer.from(sent)),
    });
    await until(() => frames(uuid).length === 1);
    const [first] = frames(uuid);
    const [body] = handle.wal.bodiesFor([first!]);
    expect(body).toBeDefined();
    const exchange = JSON.parse(
      Buffer.from(body!.bytes_base64, "base64").toString("utf8"),
    ) as { request: string };
    expect(JSON.parse(exchange.request)).toMatchObject({
      messages: [{ role: "user", content: "hello deflate" }],
    });
    expect(first!.attrs["oxagen.request_body_omitted"]).toBeUndefined();

    // A body sent under an encoding this build cannot decode (or a
    // corrupted one) is still forwarded, and the frame says why it has no
    // request half rather than silently shipping nothing.
    await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Api-Key",
        FAKE_KEY,
        "X-Claude-Code-Session-Id",
        "sess-deflate",
        "Content-Encoding",
        "compress",
      ],
      body: Buffer.from(sent),
    });
    await until(() => frames(uuid).length === 2);
    const [, second] = frames(uuid);
    expect(second!.attrs["oxagen.request_body_omitted"]).toBe("not_decoded");
  });

  it("correlates a Codex call by session_id as well as session-id (P2-12)", async () => {
    const fake = await vendor((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        '{"id":"chatcmpl-1","model":"gpt-5","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      );
    });
    const { port, session, frames } = await boot(fake.url, {
      bundle: RETAIN_MODEL_CALLS,
    });
    const uuid = await session("sess-underscore", "codex");
    await call(port, {
      path: "/openai/v1/chat/completions",
      headers: ["session_id", "sess-underscore"],
      body: JSON.stringify({ model: "gpt-5", messages: [] }),
    });
    await until(() => frames(uuid).length === 1);
    expect(frames(uuid)[0]!.attrs["oxagen.correlation"]).toBe("harness_header");
  });
});

describe("the credential seam (ADR-143)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  const OPENAI_KEY = "sk-proj-FAKE-OPENAI-IN-CUSTODY-4242";

  /** A daemon whose gateway holds the Anthropic key (and, on request, OpenAI's). */
  async function bootBrokered(
    vendorUrl: string,
    providers: Array<"anthropic" | "openai"> = ["anthropic"],
    bundleOverrides: Partial<Omit<PolicyBundle, "signature">> = {},
    hostOverrides: Partial<ReturnType<typeof testHostFile>> = {},
  ) {
    const plane = controlPlane();
    const paths = scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({ model_prices: PRICES, ...bundleOverrides }),
    );
    const hostFile = testHostFile(signer, bundle, hostOverrides);
    writeHostFile(paths.hostFile, hostFile);
    const store = openCredentialStore({
      file: paths.credentials,
      key: paths.credentialsKey,
    });
    if (providers.includes("anthropic"))
      store.take(
        "anthropic",
        { kind: "api_key", secret: FAKE_KEY },
        "claude-code:settings.env",
        Date.now(),
      );
    if (providers.includes("openai"))
      store.take(
        "openai",
        { kind: "bearer", secret: OPENAI_KEY },
        "codex:auth.json",
        Date.now(),
      );
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
    });
    cleanups.push(() => handle.stop());
    const port = handle.modelProxyPort as number;
    const issue = (harness: "claude-code" | "codex", placement?: "static") => {
      const answer = handle.api.issueRunToken!({
        harness,
        ...(placement !== undefined ? { placement } : {}),
      });
      expect(answer.status).toBe(200);
      return answer.body as { token: string; token_id: string };
    };
    const session = async (id: string, harness?: "codex" | "stella") => {
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
    return { handle, plane, paths, log, port, store, hostFile, issue, session };
  }

  async function vendor(handler: VendorHandler) {
    const fake = await fakeVendor(handler);
    cleanups.push(() => fake.close());
    return fake;
  }

  const headerOf = (raw: string[], name: string) => {
    const index = raw.findIndex(
      (h, i) => i % 2 === 0 && h.toLowerCase() === name,
    );
    return index === -1 ? undefined : raw[index + 1];
  };

  it("swaps a run token for the key in custody, records the basis and the token id, and never the secret or the token", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, plane, paths, port, log, issue, session } =
      await bootBrokered(fake.url);
    const uuid = await session("sess-brokered");
    const { token, token_id } = issue("claude-code");
    expect(token.startsWith("oxrt_")).toBe(true);

    const answer = await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Api-Key",
        token,
        "X-Claude-Code-Session-Id",
        "sess-brokered",
        "anthropic-version",
        "2023-06-01",
      ],
      body: JSON.stringify({
        model: "claude-sonnet-5",
        stream: true,
        messages: [{ role: "user", content: PROMPT }],
      }),
    });
    expect(answer.status).toBe(200);
    expect(answer.body.toString()).toContain(COMPLETION);

    // The vendor saw the real key and nothing that looks like a run token.
    const seen = fake.requests[0]!;
    expect(headerOf(seen.rawHeaders, "x-api-key")).toBe(FAKE_KEY);
    expect(headerOf(seen.rawHeaders, "authorization")).toBeUndefined();
    expect(headerOf(seen.rawHeaders, "anthropic-version")).toBe("2023-06-01");
    expect(JSON.stringify(seen.rawHeaders)).not.toContain("oxrt_");

    await until(() => handle.wal.read(uuid).some((e) => e.kind === "llm_call"));
    const frame = handle.wal.read(uuid).find((e) => e.kind === "llm_call")!;
    expect(frame.attrs[TACHO_CREDENTIAL_BASIS_ATTR]).toBe("gateway_brokered");
    expect(frame.attrs[TACHO_RUN_TOKEN_ATTR]).toBe(token_id);
    expect(frame.attrs["oxagen.metering"]).toBe("observed");

    // The issue itself is on the host's chain, by id and expiry only.
    const issued = handle.wal
      .read(handle.hostRecorder.sessionUuid)
      .find((e) => e.kind === "token_issued")!;
    expect(issued.body).toMatchObject({ token_id });
    expect(issued.attrs[TACHO_RUN_TOKEN_ATTR]).toBe(token_id);
    expect(issued.attrs["oxagen.provider"]).toBe("anthropic");

    await handle.tick();
    const haystacks = [
      ...walkFiles(paths.root).map((file) => readFileSync(file, "latin1")),
      JSON.stringify(plane.ingested),
      log.join("\n"),
      JSON.stringify(handle.api.status()),
      JSON.stringify(handle.api.health()),
    ];
    for (const needle of [FAKE_KEY, token, PROMPT])
      for (const haystack of haystacks)
        expect(haystack.includes(needle)).toBe(false);
    // The health report says which providers are brokered, and no more.
    expect(handle.api.health()["credentials"]).toEqual([
      { provider: "anthropic", basis: "gateway_brokered" },
      { provider: "openai", basis: "harness_held" },
    ]);
    expect(handle.api.status()["credential_custody"]).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        kind: "api_key",
        source: "claude-code:settings.env",
      }),
    ]);
  });

  it("forwards Stella's own key on its prefix, because custody was never taken from Stella", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, port, session } = await bootBrokered(fake.url);
    const uuid = await session("sess-stella-own", "stella");
    const own = await call(port, {
      path: "/stella/anthropic/v1/messages",
      headers: ["X-Api-Key", LEAKED_KEY],
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    expect(own.status).toBe(200);
    expect(fake.requests).toHaveLength(1);
    const [frame] = handle.wal.read(uuid).filter((e) => e.kind === "llm_call");
    expect(frame!.attrs[TACHO_CREDENTIAL_BASIS_ATTR]).toBe("harness_held");
  });

  it("refuses a call that brings its own vendor key, or none, to a brokered provider", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, port, session } = await bootBrokered(fake.url);
    const uuid = await session("sess-foreign");
    const own = await call(port, {
      path: "/anthropic/v1/messages",
      headers: [
        "X-Api-Key",
        LEAKED_KEY,
        "X-Claude-Code-Session-Id",
        "sess-foreign",
      ],
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    expect(own.status).toBe(403);
    expect(own.headers["x-oxagen-refusal"]).toBe("foreign_credential");
    expect(own.body.toString()).toContain("ANTHROPIC_API_KEY");
    const none = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Claude-Code-Session-Id", "sess-foreign"],
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    expect(none.status).toBe(403);
    expect(none.headers["x-oxagen-refusal"]).toBe("run_token_required");
    expect(fake.requests).toHaveLength(0);
    const refusals = handle.wal
      .read(uuid)
      .filter((e) => e.kind === "policy_decision");
    expect(refusals.map((e) => e.body["policy_reason_code"])).toEqual([
      "foreign_credential",
      "run_token_required",
    ]);
    expect(refusals[0]!.attrs[TACHO_CREDENTIAL_BASIS_ATTR]).toBe(
      "gateway_brokered",
    );
  });

  it("answers an expired or foreign-signed token with a 401 the harness acts on, and a mismatched one with a 403", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, paths, port, hostFile, issue } = await bootBrokered(
      fake.url,
      ["anthropic", "openai"],
    );
    const key = readRunTokenKey(paths.runTokenKey)!;
    const expired = mintRunToken({
      key,
      host: hostFile.host_enrollment_id,
      harness: "claude-code",
      provider: "anthropic",
      placement: "helper",
      now: Date.now() - 20 * 60_000,
    });
    const gone = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", expired.token],
      body: "{}",
    });
    expect(gone.status).toBe(401);
    expect(gone.headers["x-oxagen-refusal"]).toBe("run_token_expired");
    expect(JSON.parse(gone.body.toString()).error.type).toBe(
      "authentication_error",
    );
    const forged = mintRunToken({
      key: generateRunTokenKey(),
      host: hostFile.host_enrollment_id,
      harness: "claude-code",
      provider: "anthropic",
      placement: "helper",
      now: Date.now(),
    });
    const fake401 = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", forged.token],
      body: "{}",
    });
    expect(fake401.status).toBe(401);
    expect(fake401.headers["x-oxagen-refusal"]).toBe("run_token_invalid");
    // A Codex token spent at the Anthropic route.
    const codex = issue("codex", "static");
    const crossed = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", codex.token],
      body: "{}",
    });
    expect(crossed.status).toBe(403);
    expect(crossed.headers["x-oxagen-refusal"]).toBe("run_token_mismatch");
    expect(fake.requests).toHaveLength(0);
    const refused = handle.wal
      .read(handle.hostRecorder.sessionUuid)
      .filter((e) => e.kind === "policy_decision");
    // Each refusal cites the token it refused, read off the token.
    expect(refused.map((e) => e.attrs[TACHO_RUN_TOKEN_ATTR])).toEqual([
      expired.claims.tid,
      forged.claims.tid,
      codex.token_id,
    ]);
  });

  it("speaks each vendor's 401 shape, and reads a token that only looks like one as malformed", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { paths, port, hostFile } = await bootBrokered(fake.url, [
      "anthropic",
      "openai",
    ]);
    const junk = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", "oxrt_not-a-token-at-all"],
      body: "{}",
    });
    expect(junk.status).toBe(401);
    expect(junk.headers["x-oxagen-refusal"]).toBe("run_token_malformed");
    expect(JSON.parse(junk.body.toString())).toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: expect.stringMatching(
          /not a run token.*\(run_token_malformed\)$/,
        ),
      },
    });
    // Codex reads OpenAI's shape: `invalid_api_key` is the code its SDK
    // surfaces as an authentication failure rather than retrying.
    const key = readRunTokenKey(paths.runTokenKey)!;
    const expired = mintRunToken({
      key,
      host: hostFile.host_enrollment_id,
      harness: "codex",
      provider: "openai",
      placement: "static",
      now: Date.now() - 40 * 24 * 60 * 60_000,
    });
    const codex = await call(port, {
      path: "/backend-api/codex/responses",
      headers: ["Authorization", `Bearer ${expired.token}`],
      body: "{}",
    });
    expect(codex.status).toBe(401);
    expect(codex.headers["x-oxagen-refusal"]).toBe("run_token_expired");
    expect(JSON.parse(codex.body.toString())).toEqual({
      error: {
        message: expect.stringContaining("expired"),
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      },
    });
    // A 403 keeps the seam's own code where OpenAI's SDK shows it.
    const foreign = await call(port, {
      path: "/backend-api/codex/responses",
      headers: ["Authorization", "Bearer sk-proj-THEIR-OWN"],
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body.toString()).error).toMatchObject({
      type: "invalid_request_error",
      code: "foreign_credential",
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("lets the operator's pause outrank the credential seam", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { port } = await bootBrokered(fake.url, ["anthropic"], {
      host_status: "paused",
    });
    // A foreign key on a brokered provider would be `foreign_credential`;
    // the person is told the host is paused first, since that is the
    // decision that stands whatever they present.
    const answer = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", LEAKED_KEY],
      body: "{}",
    });
    expect(answer.status).toBe(403);
    expect(answer.headers["x-oxagen-refusal"]).toBe("host_paused");
    expect(fake.requests).toHaveLength(0);
  });

  it("fails closed for a run token when the store cannot be read, and reports every provider harness held", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, paths, port, log, issue } = await bootBrokered(fake.url);
    const { token } = issue("claude-code");
    writeFileSync(paths.credentials, "{ not a store");
    const answer = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", token],
      body: "{}",
    });
    expect(answer.status).toBe(403);
    expect(answer.headers["x-oxagen-refusal"]).toBe("credential_unavailable");
    expect(fake.requests).toHaveLength(0);
    expect(log.some((l) => l.includes("credential store unreadable"))).toBe(
      true,
    );
    expect(handle.api.health()["credentials"]).toEqual([
      { provider: "anthropic", basis: "harness_held" },
      { provider: "openai", basis: "harness_held" },
    ]);
    expect(handle.api.status()["credential_custody"]).toEqual([]);
    // No token is minted over a store nobody can open.
    expect(handle.api.issueRunToken!({ harness: "claude-code" })).toMatchObject(
      { status: 403, body: { code: "credential_unavailable" } },
    );
  });

  it("brokers Codex with a bearer, and passes a provider with nothing in custody through untouched", async () => {
    const fake = await vendor((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_1",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    const { port, issue, handle, store } = await bootBrokered(fake.url, [
      "openai",
    ]);
    const { token } = issue("codex", "static");
    const brokered = await call(port, {
      path: "/backend-api/codex/responses",
      headers: ["Authorization", `Bearer ${token}`],
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
    });
    expect(brokered.status).toBe(200);
    const seen = fake.requests[0]!;
    expect(headerOf(seen.rawHeaders, "authorization")).toBe(
      `Bearer ${OPENAI_KEY}`,
    );
    expect(headerOf(seen.rawHeaders, "x-api-key")).toBeUndefined();

    // Anthropic is not in custody on this host: the harness's own key crosses.
    const own = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["X-Api-Key", FAKE_KEY],
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    expect(own.status).toBe(200);
    expect(headerOf(fake.requests[1]!.rawHeaders, "x-api-key")).toBe(FAKE_KEY);
    await until(
      () =>
        handle.wal
          .read(handle.hostRecorder.sessionUuid)
          .filter((e) => e.kind === "llm_call").length >= 2,
    );
    const bases = handle.wal
      .read(handle.hostRecorder.sessionUuid)
      .filter((e) => e.kind === "llm_call")
      .map((e) => e.attrs[TACHO_CREDENTIAL_BASIS_ATTR]);
    expect(bases).toEqual(["gateway_brokered", "harness_held"]);

    // A run token spent where nothing is in custody is refused with a reason.
    store.release("openai");
    const orphan = await call(port, {
      path: "/backend-api/codex/responses",
      headers: ["Authorization", `Bearer ${token}`],
      body: "{}",
    });
    expect(orphan.status).toBe(403);
    expect(orphan.headers["x-oxagen-refusal"]).toBe("credential_unavailable");
    // And no token is issued for it any more.
    expect(handle.api.issueRunToken!({ harness: "codex" })).toMatchObject({
      status: 403,
      body: { code: "credential_unavailable" },
    });
    expect(handle.api.issueRunToken!({ harness: "stella" })).toMatchObject({
      status: 400,
      body: { code: "harness_not_brokered" },
    });
  });

  it("lets a ChatGPT login cross as the harness's own even when an OpenAI key is in custody", async () => {
    const fake = await vendor((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_2",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    const { port, handle } = await bootBrokered(fake.url, ["openai"]);
    const answer = await call(port, {
      path: "/backend-api/codex/responses",
      headers: [
        "Authorization",
        `Bearer ${FAKE_BEARER}`,
        "ChatGPT-Account-ID",
        "acct_1",
      ],
      body: JSON.stringify({ model: "gpt-5", input: "hi" }),
    });
    expect(answer.status).toBe(200);
    const seen = fake.requests[0]!;
    // chatgpt.com takes the login, never an API key, so the bearer crossed.
    expect(seen.url).toBe("/backend-api/codex/responses");
    expect(headerOf(seen.rawHeaders, "authorization")).toBe(
      `Bearer ${FAKE_BEARER}`,
    );
    await until(() =>
      handle.wal
        .read(handle.hostRecorder.sessionUuid)
        .some((e) => e.kind === "llm_call"),
    );
    const frame = handle.wal
      .read(handle.hostRecorder.sessionUuid)
      .find((e) => e.kind === "llm_call")!;
    expect(frame.attrs[TACHO_CREDENTIAL_BASIS_ATTR]).toBe("harness_held");
  });

  it("prefers a run token over a login sent beside it, and strips both on the way out", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { port, issue } = await bootBrokered(fake.url);
    const { token } = issue("claude-code");
    const answer = await call(port, {
      path: "/anthropic/v1/messages",
      headers: ["Authorization", `Bearer ${FAKE_BEARER}`, "X-Api-Key", token],
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    expect(answer.status).toBe(200);
    const seen = fake.requests[0]!;
    expect(headerOf(seen.rawHeaders, "x-api-key")).toBe(FAKE_KEY);
    expect(headerOf(seen.rawHeaders, "authorization")).toBeUndefined();
  });

  it("renews Codex's static token on the tick when it nears its expiry, and records the mint", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, paths, hostFile } = await bootBrokered(
      fake.url,
      ["openai"],
      {},
      { harnesses: ["claude-code", "codex"] },
    );
    const home = join(paths.root, "..");
    const key = readRunTokenKey(paths.runTokenKey)!;
    const nearlyOver = mintRunToken({
      key,
      host: hostFile.host_enrollment_id,
      harness: "codex",
      provider: "openai",
      placement: "static",
      now: Date.now(),
      ttlMs: 60 * 60_000,
    });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: nearlyOver.token, keep: "me" }),
    );
    await handle.tick();
    const written = JSON.parse(
      readFileSync(join(home, ".codex", "auth.json"), "utf8"),
    ) as { OPENAI_API_KEY: string; keep: string };
    expect(written.keep).toBe("me");
    expect(written.OPENAI_API_KEY).not.toBe(nearlyOver.token);
    const claims = peekRunTokenClaims(written.OPENAI_API_KEY)!;
    expect(claims.host).toBe(hostFile.host_enrollment_id);
    expect(claims.exp - Date.now()).toBeGreaterThan(20 * 24 * 60 * 60_000);
    expect(
      handle.wal
        .read(handle.hostRecorder.sessionUuid)
        .some(
          (e) =>
            e.kind === "token_issued" &&
            e.attrs["oxagen.run_token_placement"] === "static",
        ),
    ).toBe(true);
    // A second tick inside the hour changes nothing.
    await handle.tick();
    expect(
      (
        JSON.parse(readFileSync(join(home, ".codex", "auth.json"), "utf8")) as {
          OPENAI_API_KEY: string;
        }
      ).OPENAI_API_KEY,
    ).toBe(written.OPENAI_API_KEY);
  });

  it("issues a token over the collector's socket route with the local bearer, and to nobody else", async () => {
    const fake = await vendor(streamingAnthropic(1));
    const { handle, hostFile } = await bootBrokered(fake.url);
    const post = (bearer: string | undefined, body: unknown) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: handle.port,
            method: "POST",
            path: "/credential/issue",
            headers: {
              "Content-Type": "application/json",
              ...(bearer !== undefined
                ? { Authorization: `Bearer ${bearer}` }
                : {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.end(JSON.stringify(body));
      });
    const denied = await post(undefined, { harness: "claude-code" });
    expect(denied.status).toBe(401);
    const wrong = await post(hostFile.local_token, { harness: "stella" });
    expect(wrong.status).toBe(400);
    expect(JSON.parse(wrong.body)).toMatchObject({
      code: "harness_not_brokered",
    });
    const issued = await post(hostFile.local_token, { harness: "claude-code" });
    expect(issued.status).toBe(200);
    const parsed = JSON.parse(issued.body) as {
      token: string;
      expires_at: string;
    };
    expect(parsed.token.startsWith("oxrt_")).toBe(true);
    expect(Date.parse(parsed.expires_at) - Date.now()).toBeLessThanOrEqual(
      15 * 60_000,
    );
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
      "models",
      "models_independent",
      "hook_fail_open",
      "steering_manifest",
      "containment",
      "daily_budget",
      "steer_next_step",
    ]);
  });

  it("reads the day figure off a control envelope, and drops one it cannot read rather than the envelope (negative)", () => {
    const envelope = {
      host_status: "active",
      deny_generation: { org: 1, workspace: 1 },
      bundle_etag: "etag-1",
      commands: [],
    };
    expect(
      controlEnvelopeSchema.parse({
        ...envelope,
        agent_day_spend: {
          day: "2026-09-24",
          this_host_usd_micros: 1,
          other_hosts_usd_micros: 2,
        },
      }).agent_day_spend,
    ).toEqual({
      day: "2026-09-24",
      this_host_usd_micros: 1,
      other_hosts_usd_micros: 2,
    });
    const odd = controlEnvelopeSchema.parse({
      ...envelope,
      agent_day_spend: { day: "Thursday", this_host_usd_micros: -1 },
    });
    expect(odd.agent_day_spend).toBeUndefined();
    expect(odd.bundle_etag).toBe("etag-1");
  });

  it("parses models, keeps a null allowlist apart from an empty one, and refuses a stray key", () => {
    const signer = bundleSigner();
    // `null` (no allowlist) and `[]` (permit nothing) are different decisions,
    // and the wire has to carry both or "permit nothing" becomes "permit
    // everything" on the host. Nothing signs this clause today; the schema
    // carries it so the host is ready when the control plane does.
    const none = policyBundleSchema.parse(
      signer.sign(unsignedBundle({ models: { allow: null, deny: [] } })),
    );
    expect(none.models).toEqual({ allow: null, deny: [] });
    const nothing = policyBundleSchema.parse(
      signer.sign(unsignedBundle({ models: { allow: [], deny: [] } })),
    );
    expect(nothing.models).toEqual({ allow: [], deny: [] });
    const bad = {
      ...signer.sign(unsignedBundle({})),
      models: { allow: null, deny: [], surprise: 1 },
    };
    expect(policyBundleSchema.safeParse(bad).success).toBe(false);
  });

  it("puts the proxy next to the collector's port unless the host file pins one", () => {
    expect(modelProxyPortFor({ port: 47001 })).toBe(47002);
    expect(modelProxyPortFor({ port: 65535 })).toBe(65534);
    expect(modelProxyPortFor({ port: 47001, model_proxy_port: 5123 })).toBe(
      5123,
    );
  });
});
