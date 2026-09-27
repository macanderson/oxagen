// sender.ts: how the grpc Sender handles a Transport that fails, stalls, or
// sends what the method does not allow. A fake Transport stands in for the
// network, so each case is exact.
import { create, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { AnySchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";
import type { SendResult } from "../sender";
import {
  TransportError,
  type GrpcStatus,
  type GrpcTransportRequest,
  type GrpcTransportResponse,
  type Transport,
  type TransportErrorCode,
} from "../transport";
import { resolveMethod } from "./descriptors";
import {
  API_KEY_AUTH,
  GET_ENTRY,
  LIST_ENTRIES,
  POST_ENTRY,
  ledgerContext,
  type LedgerContextOptions,
} from "./__tests__/ledger-context";
import { LEDGER_DESCRIPTOR_SET } from "./__tests__/ledger-descriptor-set";
import { createGrpcSender, grpcSender } from "./sender";

const entryMethod = resolveMethod(LEDGER_DESCRIPTOR_SET, GET_ENTRY);

function entryBytes(json: JsonValue): Uint8Array {
  return toBinary(entryMethod.output, fromJson(entryMethod.output, json, { registry: entryMethod.registry }));
}

const OK: GrpcStatus = { code: 0, message: "", metadata: [] };

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

interface Fake {
  transport: Transport;
  requests: GrpcTransportRequest[];
}

/** A Transport whose grpc() runs `open` for each attempt and records the request. */
function fakeTransport(open: (request: GrpcTransportRequest, attempt: number) => Promise<GrpcTransportResponse>): Fake {
  const requests: GrpcTransportRequest[] = [];
  const unused = (): Promise<never> => Promise.reject(new Error("The test Transport sends gRPC only."));
  return {
    requests,
    transport: {
      http: unused,
      local: unused,
      grpc: (request) => {
        requests.push(request);
        return open(request, requests.length);
      },
    },
  };
}

function response(
  messages: AsyncIterable<Uint8Array> | Uint8Array[],
  status: () => Promise<GrpcStatus> = () => Promise.resolve(OK),
): GrpcTransportResponse & { cancel: ReturnType<typeof vi.fn> } {
  const iterable = Array.isArray(messages)
    ? (async function* () {
        yield* messages;
      })()
    : messages;
  return { messages: iterable, status, cancel: vi.fn() };
}

/** A Transport that answers every attempt with this one response. */
const returning = (sent: GrpcTransportResponse): Transport => fakeTransport(() => Promise.resolve(sent)).transport;

const answered = (): Promise<GrpcTransportResponse> =>
  Promise.resolve(response([entryBytes({ id: "e_1" })]));

const unavailable = (): Promise<GrpcTransportResponse> =>
  Promise.resolve(response([], () => Promise.resolve({ ...OK, code: 14, message: "The ledger is restarting." })));

function context(transport: Transport, options: Partial<LedgerContextOptions> = {}): ReturnType<typeof ledgerContext> {
  return ledgerContext({ transport, ...options });
}

function expectError(result: SendResult, title: string, status: number | undefined, attempts: number): string {
  expect(result.ok).toBe(false);
  expect(result.attempts).toBe(attempts);
  if (result.ok) return "";
  expect(result.error.title).toBe(title);
  expect(result.error.status).toBe(status);
  return result.error.detail;
}

const sender = createGrpcSender({ backoff_ms: () => 1 });

describe("the request the Sender hands the Transport", () => {
  it("carries the target, the encoded message, and the time left", async () => {
    const fake = fakeTransport(answered);
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(fake.transport, { deadline_ms: 5_000 }));
    expect(result.ok).toBe(true);
    const [request] = fake.requests;
    expect(request?.target).toEqual({
      kind: "grpc",
      scheme: "http",
      host: "127.0.0.1",
      port: 50051,
      service: "a_intel.ledger.v1.Ledger",
      method: "GetEntry",
    });
    expect(request?.network).toBe("cloud");
    expect(request?.metadata).toEqual([]);
    expect(request?.relay_credential).toBeUndefined();
    expect(request?.message).toEqual(toBinary(entryMethod.input, fromJson(entryMethod.input, { id: "e_1" })));
    expect(request?.deadline_ms).toBeGreaterThan(0);
    expect(request?.deadline_ms).toBeLessThanOrEqual(5_000);
  });

  it("leaves a relay credential for the relay to add", async () => {
    const fake = fakeTransport(answered);
    const relay = { name: "ledger-token", scheme: "bearer" as const };
    const result = await sender.send(
      GET_ENTRY,
      { id: "e_1" },
      context(fake.transport, { network: "relay:acme", credential: { type: "relay", credential: relay } }),
    );
    expect(result.ok).toBe(true);
    expect(fake.requests[0]?.network).toBe("relay:acme");
    expect(fake.requests[0]?.relay_credential).toEqual(relay);
    expect(fake.requests[0]?.metadata).toEqual([]);
  });
});

describe("a call that cannot be built", () => {
  it("refuses a server with no descriptor set", async () => {
    const fake = fakeTransport(answered);
    const result = await grpcSender.send(
      GET_ENTRY,
      { id: "e_1" },
      context(fake.transport, { descriptor_set: undefined }),
    );
    expect(expectError(result, "Invalid descriptor set", undefined, 0)).toMatch(/no descriptor_set/);
    expect(fake.requests).toEqual([]);
  });

  it("refuses an environment with no url", async () => {
    const fake = fakeTransport(answered);
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(fake.transport, { url: undefined }));
    expectError(result, "Invalid environment", undefined, 0);
    expect(fake.requests).toEqual([]);
  });

  it("refuses an API key with no api_key scheme", async () => {
    const fake = fakeTransport(answered);
    const result = await sender.send(
      GET_ENTRY,
      { id: "e_1" },
      context(fake.transport, { credential: { type: "api_key", value: "key_1" } }),
    );
    expectError(result, "Invalid credential", undefined, 0);
  });

  it("sends an API key under its scheme's header", async () => {
    const fake = fakeTransport(answered);
    const result = await sender.send(
      GET_ENTRY,
      { id: "e_1" },
      context(fake.transport, { auth: API_KEY_AUTH, credential: { type: "api_key", value: "key_1" } }),
    );
    expect(result.ok).toBe(true);
    expect(fake.requests[0]?.metadata).toEqual([["x-api-key", "key_1"]]);
  });
});

describe("a response the method does not allow", () => {
  it("fails a unary call that sends two messages, and cancels it", async () => {
    const sent = response([entryBytes({ id: "e_1" }), entryBytes({ id: "e_2" })]);
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(returning(sent)));
    expect(expectError(result, "INTERNAL", 13, 1)).toBe(
      "a_intel.ledger.v1.Ledger/GetEntry is unary, but the upstream sent more than one response message.",
    );
    expect(sent.cancel).toHaveBeenCalled();
  });

  it("fails a unary call that ends with OK and no message", async () => {
    const result = await sender.send(
      GET_ENTRY,
      { id: "e_1" },
      context(returning(response([]))),
    );
    expect(expectError(result, "INTERNAL", 13, 1)).toBe(
      "a_intel.ledger.v1.Ledger/GetEntry ended with OK and sent no response message.",
    );
  });

  it("fails bytes that do not decode, and cancels the call", async () => {
    const sent = response([new Uint8Array([0xff])]);
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(returning(sent)));
    expect(expectError(result, "INTERNAL", 13, 1)).toMatch(
      /^The response does not decode as a_intel\.ledger\.v1\.Entry/,
    );
    expect(sent.cancel).toHaveBeenCalled();
  });

  it("fails an Any whose type the descriptor set does not hold", async () => {
    const detail = create(AnySchema, { typeUrl: "type.googleapis.com/acme.Unknown", value: new Uint8Array([8, 1]) });
    const bytes = toBinary(entryMethod.output, create(entryMethod.output, { id: "e_1", detail }));
    const result = await sender.send(
      GET_ENTRY,
      { id: "e_1" },
      context(returning(response([bytes]))),
    );
    expect(expectError(result, "INTERNAL", 13, 1)).toMatch(/acme\.Unknown/);
  });

  it("names a status with no message", async () => {
    const sent = response([], () => Promise.resolve({ ...OK, code: 7 }));
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(returning(sent)));
    expect(expectError(result, "PERMISSION_DENIED", 7, 1)).toBe(
      "The upstream returned PERMISSION_DENIED with no message.",
    );
  });
});

describe("a Transport that fails", () => {
  const refusals: [Exclude<TransportErrorCode, "timeout" | "not_sent">, string][] = [
    ["refused_address", "Address refused"],
    ["refused_redirect", "Redirect refused"],
    ["refused_host", "Host refused"],
    ["unsupported", "Unsupported transport"],
    ["disconnected", "Not connected"],
  ];

  it.each(refusals)("reports %s without a retry", async (code, title) => {
    const fake = fakeTransport(() => Promise.reject(new TransportError(code, `The Transport said ${code}.`, false)));
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(fake.transport));
    expect(expectError(result, title, undefined, 1)).toBe(`The Transport said ${code}.`);
    expect(fake.requests).toHaveLength(1);
  });

  it("reports a Transport timeout on a unary call as DEADLINE_EXCEEDED", async () => {
    const fake = fakeTransport(() => Promise.reject(new TransportError("timeout", "The relay gave up.", true)));
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(fake.transport));
    expect(expectError(result, "DEADLINE_EXCEEDED", 4, 1)).toBe("The relay gave up.");
  });

  it("returns a stream's items when the Transport times out", async () => {
    async function* messages(): AsyncGenerator<Uint8Array> {
      yield entryBytes({ id: "e_1" });
      throw new TransportError("timeout", "The relay gave up.", true);
    }
    const sent = response(messages());
    const result = await sender.send(
      LIST_ENTRIES,
      {},
      context(returning(sent)),
    );
    expect(result).toMatchObject({ ok: true, attempts: 1, value: { items: [{ id: "e_1" }], truncated: true } });
    expect(sent.cancel).toHaveBeenCalled();
  });

  it("retries a call that was not sent, for a method marked safe", async () => {
    const fake = fakeTransport((_, attempt) =>
      attempt < 3 ? Promise.reject(new TransportError("not_sent", "The relay is offline.", false)) : answered(),
    );
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(fake.transport));
    expect(result).toMatchObject({ ok: true, attempts: 3, value: { id: "e_1" } });
  });

  it("refuses a tool that marks an unsafe method safe, and sends nothing", async () => {
    const fake = fakeTransport(unavailable);
    const mislabeled = { ...POST_ENTRY, idempotency_level: "IDEMPOTENT" as const };
    const result = await sender.send(mislabeled, { accountId: "acct_1" }, context(fake.transport));
    expect(expectError(result, "Invalid descriptor set", undefined, 0)).toContain("the tool marks it IDEMPOTENT");
    expect(fake.requests).toHaveLength(0);
  });

  it("reports a call that was not sent as UNAVAILABLE, with no retry for an unsafe method", async () => {
    const fake = fakeTransport(() => Promise.reject(new TransportError("not_sent", "The relay is offline.", false)));
    const result = await sender.send(POST_ENTRY, { accountId: "acct_1" }, context(fake.transport));
    expect(expectError(result, "UNAVAILABLE", 14, 1)).toBe("The relay is offline.");
  });

  it("does not retry a stream that failed after an item", async () => {
    async function* messages(): AsyncGenerator<Uint8Array> {
      yield entryBytes({ id: "e_1" });
      throw new TransportError("not_sent", "The relay dropped the call.", false);
    }
    const fake = fakeTransport(() => Promise.resolve(response(messages())));
    const result = await sender.send(LIST_ENTRIES, {}, context(fake.transport));
    expectError(result, "UNAVAILABLE", 14, 1);
    expect(fake.requests).toHaveLength(1);
  });

  it("reports an error that is not a TransportError", async () => {
    const fake = fakeTransport(() => Promise.reject(new Error("socket hang up")));
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(fake.transport));
    expect(expectError(result, "Transport error", undefined, 1)).toBe("socket hang up");
  });

  it("reports a Transport that throws before it returns a promise", async () => {
    const fake = fakeTransport(() => {
      throw new Error("The Transport has no route.");
    });
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(fake.transport));
    expect(expectError(result, "Transport error", undefined, 1)).toBe("The Transport has no route.");
  });

  it("reports a status that fails to arrive", async () => {
    const sent = response([], () => Promise.reject(new TransportError("disconnected", "The relay hung up.", true)));
    const result = await sender.send(
      LIST_ENTRIES,
      {},
      context(returning(sent)),
    );
    expect(expectError(result, "Not connected", undefined, 1)).toBe("The relay hung up.");
  });

  it("turns a defect in the Sender into an error result", async () => {
    const broken = { messages: null, status: () => Promise.resolve(OK), cancel: () => undefined };
    const fake = fakeTransport(() => Promise.resolve(broken as unknown as GrpcTransportResponse));
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(fake.transport));
    expect(expectError(result, "Internal error", undefined, 0)).toMatch(/^The gRPC Sender failed: /);
  });
});

describe("a status the upstream sends", () => {
  it("returns a stream's items when the status is DEADLINE_EXCEEDED", async () => {
    const sent = response([entryBytes({ id: "e_1" })], () => Promise.resolve({ ...OK, code: 4, message: "late" }));
    const result = await sender.send(
      LIST_ENTRIES,
      {},
      context(returning(sent)),
    );
    expect(result).toEqual({
      ok: true,
      attempts: 1,
      value: { items: [expect.objectContaining({ id: "e_1" })], truncated: true },
    });
  });

  it("fails a unary call whose status is DEADLINE_EXCEEDED", async () => {
    const sent = response([], () => Promise.resolve({ ...OK, code: 4, message: "Deadline exceeded." }));
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(returning(sent)));
    expect(expectError(result, "DEADLINE_EXCEEDED", 4, 1)).toBe("Deadline exceeded.");
  });
});

describe("a Transport that stalls", () => {
  it("fails a unary call whose status never arrives, at the deadline", async () => {
    const sent = response([entryBytes({ id: "e_1" })], never);
    const result = await sender.send(
      GET_ENTRY,
      { id: "e_1" },
      context(returning(sent), { deadline_ms: 50 }),
    );
    expect(expectError(result, "DEADLINE_EXCEEDED", 4, 1)).toBe("The call passed its deadline of 50 ms.");
    expect(sent.cancel).toHaveBeenCalled();
  });

  it("returns a stream's items when its status never arrives", async () => {
    const sent = response([entryBytes({ id: "e_1" })], never);
    const result = await sender.send(
      LIST_ENTRIES,
      {},
      context(returning(sent), { deadline_ms: 50 }),
    );
    expect(result).toMatchObject({ ok: true, value: { items: [{ id: "e_1" }], truncated: true } });
  });

  it("cancels a call that opens after the deadline", async () => {
    let open: (value: GrpcTransportResponse) => void = () => undefined;
    const fake = fakeTransport(
      () =>
        new Promise<GrpcTransportResponse>((resolve) => {
          open = resolve;
        }),
    );
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context(fake.transport, { deadline_ms: 50 }));
    expectError(result, "DEADLINE_EXCEEDED", 4, 1);
    expect(fake.requests[0]?.signal.aborted).toBe(true);
    const late = response([]);
    open(late);
    await vi.waitFor(() => expect(late.cancel).toHaveBeenCalled());
  });

  it("gives up when the wait before a retry ends past the deadline", async () => {
    // The wait fits before the deadline when it starts, but the clock moves
    // past the deadline while it runs, as a late timer would.
    let skew = 0;
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      const late = createGrpcSender({
        backoff_ms: () => {
          setTimeout(() => {
            skew = 10_000;
          }, 0);
          return 20;
        },
      });
      const fake = fakeTransport(unavailable);
      const result = await late.send(GET_ENTRY, { id: "e_1" }, context(fake.transport, { deadline_ms: 5_000 }));
      expect(expectError(result, "UNAVAILABLE", 14, 1)).toBe("The ledger is restarting.");
      expect(fake.requests).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("a caller that cancels", () => {
  it("stops a stream that is waiting for its next message", async () => {
    const controller = new AbortController();
    async function* messages(): AsyncGenerator<Uint8Array> {
      yield entryBytes({ id: "e_1" });
      controller.abort();
      await never();
    }
    const sent = response(messages());
    const result = await sender.send(
      LIST_ENTRIES,
      {},
      context(returning(sent), { signal: controller.signal }),
    );
    expect(expectError(result, "CANCELLED", 1, 1)).toBe("The call was cancelled before it finished.");
    expect(sent.cancel).toHaveBeenCalled();
  });

  it("sends nothing when the signal aborted before the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeTransport(answered);
    const result = await sender.send(
      GET_ENTRY,
      { id: "e_1" },
      context(fake.transport, { signal: controller.signal }),
    );
    expectError(result, "CANCELLED", 1, 1);
    expect(fake.requests[0]?.signal.aborted).toBe(true);
  });

  it("stops during the wait before a retry", async () => {
    const controller = new AbortController();
    const waiting = createGrpcSender({
      backoff_ms: () => {
        setTimeout(() => controller.abort(), 5);
        return 10_000;
      },
    });
    const fake = fakeTransport(unavailable);
    const started = Date.now();
    const result = await waiting.send(GET_ENTRY, { id: "e_1" }, context(fake.transport, { signal: controller.signal }));
    expectError(result, "CANCELLED", 1, 1);
    expect(fake.requests).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops before a retry when the signal aborted during the attempt", async () => {
    const controller = new AbortController();
    const waiting = createGrpcSender({
      backoff_ms: () => {
        controller.abort();
        return 1;
      },
    });
    const fake = fakeTransport(unavailable);
    const result = await waiting.send(GET_ENTRY, { id: "e_1" }, context(fake.transport, { signal: controller.signal }));
    expectError(result, "CANCELLED", 1, 1);
    expect(fake.requests).toHaveLength(1);
  });
});

describe("the stream byte cap", () => {
  it("cuts a stream that passes max_stream_bytes", async () => {
    const capped = createGrpcSender({ max_stream_bytes: 10 });
    const sent = response([entryBytes({ id: "e_1" }), entryBytes({ id: "e_2" }), entryBytes({ id: "e_3" })]);
    const result = await capped.send(LIST_ENTRIES, {}, context(returning(sent)));
    expect(result).toMatchObject({ ok: true, value: { items: [{ id: "e_1" }], truncated: true } });
    expect(sent.cancel).toHaveBeenCalled();
  });
});
