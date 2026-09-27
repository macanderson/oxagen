// sender.ts: the grpc Sender, end to end through the carrier to an in-process
// ledger server built from M0's ledger.proto fixture.
import type { JsonObject } from "@bufbuild/protobuf";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendResult } from "../sender";
import { createGrpcCarrier } from "./carrier";
import {
  API_KEY_AUTH,
  GET_ENTRY,
  LIST_ENTRIES,
  POST_ENTRY,
  REVERSE_ENTRY,
  ledgerContext,
  type LedgerContextOptions,
} from "./__tests__/ledger-context";
import { entry, GrpcFailure, startLedgerServer, type LedgerServer } from "./__tests__/ledger-server";
import { createGrpcSender } from "./sender";

const UNAVAILABLE = 14;

const carrier = createGrpcCarrier();
const sender = createGrpcSender({ backoff_ms: () => 1 });

let server: LedgerServer;

beforeAll(async () => {
  server = await startLedgerServer();
});

afterAll(() => server.close());

beforeEach(() => {
  server.handlers = {};
  server.calls.length = 0;
});

function context(options: Partial<LedgerContextOptions> = {}): ReturnType<typeof ledgerContext> {
  return ledgerContext({ transport: carrier, url: `http://127.0.0.1:${server.port}`, ...options });
}

const idOf = (request: JsonObject): string => (typeof request.id === "string" ? request.id : "");

/** A handler that fails with UNAVAILABLE the first `failures` times, then answers. */
function flaky(failures: number): (request: JsonObject) => JsonObject {
  let calls = 0;
  return (request) => {
    calls += 1;
    if (calls <= failures) throw new GrpcFailure(UNAVAILABLE, "The ledger is restarting.");
    return entry(idOf(request));
  };
}

function expectError(result: SendResult, title: string, status: number | undefined): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.title).toBe(title);
    expect(result.error.status).toBe(status);
  }
}

describe("a unary call", () => {
  it("returns the response as proto3 JSON and sends the credential as metadata", async () => {
    server.handlers.GetEntry = (request) => entry(idOf(request), { labels: { team: "ops" } });
    const result = await sender.send(
      GET_ENTRY,
      { id: "e_1" },
      context({ credential: { type: "bearer", token: "tok_1" } }),
    );
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      value: {
        id: "e_1",
        accountId: "acct_1",
        kind: "ENTRY_KIND_DEBIT",
        money: { amount: "1250", currency: "USD" },
        labels: { team: "ops" },
        relatedIds: [],
        reversed: false,
      },
    });
    const [received] = server.callsTo("GetEntry");
    expect(received?.request).toEqual({ id: "e_1" });
    expect(received?.metadata.authorization).toEqual(["Bearer tok_1"]);
  });

  it("sends a basic credential as an authorization header", async () => {
    server.handlers.GetEntry = (request) => entry(idOf(request));
    const result = await sender.send(
      GET_ENTRY,
      { id: "e_1" },
      context({ credential: { type: "basic", username: "svc", password: "pw" } }),
    );
    expect(result.ok).toBe(true);
    const expected = `Basic ${Buffer.from("svc:pw").toString("base64")}`;
    expect(server.callsTo("GetEntry")[0]?.metadata.authorization).toEqual([expected]);
  });

  it("sends an API key in the header its scheme names", async () => {
    server.handlers.GetEntry = (request) => entry(idOf(request));
    const result = await sender.send(
      GET_ENTRY,
      { id: "e_1" },
      context({ auth: API_KEY_AUTH, credential: { type: "api_key", value: "key_1" } }),
    );
    expect(result.ok).toBe(true);
    expect(server.callsTo("GetEntry")[0]?.metadata["x-api-key"]).toEqual(["key_1"]);
  });

  it("returns a status other than OK with its code and message", async () => {
    server.handlers.GetEntry = () => {
      throw new GrpcFailure(5, "No entry e_9.");
    };
    const result = await sender.send(GET_ENTRY, { id: "e_9" }, context());
    expect(result).toEqual({
      ok: false,
      error: { title: "NOT_FOUND", detail: "No entry e_9.", status: 5 },
      attempts: 1,
    });
  });

  it("refuses arguments that do not encode, and sends nothing", async () => {
    const result = await sender.send(GET_ENTRY, { id: "e_1", color: "red" }, context());
    expect(result.attempts).toBe(0);
    expectError(result, "Invalid arguments", undefined);
    expect(server.calls).toEqual([]);
  });
});

describe("a server stream", () => {
  it("collects every message until the stream ends", async () => {
    server.handlers.ListEntries = (_, { write }) => {
      for (const id of ["e_1", "e_2", "e_3"]) write(entry(id));
    };
    const result = await sender.send(LIST_ENTRIES, { accountId: "acct_1" }, context());
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    if (result.ok) {
      expect(result.value).toMatchObject({
        items: [{ id: "e_1" }, { id: "e_2" }, { id: "e_3" }],
        truncated: false,
      });
    }
    expect(server.callsTo("ListEntries")[0]?.request).toEqual({ accountId: "acct_1" });
  });

  it("returns an empty stream as no items", async () => {
    server.handlers.ListEntries = () => undefined;
    const result = await sender.send(LIST_ENTRIES, {}, context());
    expect(result).toEqual({ ok: true, value: { items: [], truncated: false }, attempts: 1 });
  });

  it("stops at max_items and cancels the rest of the stream", async () => {
    let upstreamCancelled = false;
    server.handlers.ListEntries = async (_, { write, cancelled }) => {
      for (const id of ["e_1", "e_2", "e_3", "e_4", "e_5"]) write(entry(id));
      await cancelled;
      upstreamCancelled = true;
    };
    const result = await sender.send(LIST_ENTRIES, {}, context({ max_items: 2 }));
    expect(result).toMatchObject({ ok: true, value: { items: [{ id: "e_1" }, { id: "e_2" }], truncated: true } });
    await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
  });

  it("returns what it read by the deadline, marked truncated", async () => {
    server.handlers.ListEntries = async (_, { write, cancelled }) => {
      write(entry("e_1"));
      write(entry("e_2"));
      await cancelled;
    };
    const started = Date.now();
    const result = await sender.send(LIST_ENTRIES, {}, context({ deadline_ms: 300 }));
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      value: { items: [{ id: "e_1" }, { id: "e_2" }], truncated: true },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("the deadline", () => {
  it("fails a unary call that passes it with DEADLINE_EXCEEDED", async () => {
    server.handlers.GetEntry = async (request, { cancelled }) => {
      await cancelled;
      return entry(idOf(request));
    };
    const started = Date.now();
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context({ deadline_ms: 200 }));
    expectError(result, "DEADLINE_EXCEEDED", 4);
    expect(result.attempts).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("skips a retry that cannot start before it", async () => {
    server.handlers.GetEntry = flaky(1);
    const slow = createGrpcSender({ backoff_ms: () => 1_000 });
    const result = await slow.send(GET_ENTRY, { id: "e_1" }, context({ deadline_ms: 300 }));
    expectError(result, "UNAVAILABLE", UNAVAILABLE);
    expect(result.attempts).toBe(1);
    expect(server.callsTo("GetEntry")).toHaveLength(1);
  });
});

describe("retries on UNAVAILABLE", () => {
  it("retries a NO_SIDE_EFFECTS method until it answers", async () => {
    server.handlers.GetEntry = flaky(2);
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context());
    expect(result).toMatchObject({ ok: true, attempts: 3, value: { id: "e_1" } });
    expect(server.callsTo("GetEntry")).toHaveLength(3);
  });

  it("retries an IDEMPOTENT method", async () => {
    server.handlers.ReverseEntry = flaky(1);
    const result = await sender.send(REVERSE_ENTRY, { id: "e_1", reason: "duplicate" }, context());
    expect(result).toMatchObject({ ok: true, attempts: 2, value: { id: "e_1" } });
    expect(server.callsTo("ReverseEntry")).toHaveLength(2);
  });

  it("never retries a method with no idempotency level", async () => {
    server.handlers.PostEntry = flaky(1);
    const result = await sender.send(POST_ENTRY, { accountId: "acct_1" }, context());
    expectError(result, "UNAVAILABLE", UNAVAILABLE);
    expect(result.attempts).toBe(1);
    expect(server.callsTo("PostEntry")).toHaveLength(1);
  });

  it("stops after 3 retries", async () => {
    server.handlers.GetEntry = flaky(10);
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context());
    expect(result).toEqual({
      ok: false,
      error: { title: "UNAVAILABLE", detail: "The ledger is restarting.", status: UNAVAILABLE },
      attempts: 4,
    });
    expect(server.callsTo("GetEntry")).toHaveLength(4);
  });

  it("does not retry a status other than UNAVAILABLE", async () => {
    server.handlers.GetEntry = () => {
      throw new GrpcFailure(8, "Too many calls.");
    };
    const result = await sender.send(GET_ENTRY, { id: "e_1" }, context());
    expectError(result, "RESOURCE_EXHAUSTED", 8);
    expect(result.attempts).toBe(1);
    expect(server.callsTo("GetEntry")).toHaveLength(1);
  });

  it("retries a stream that failed before its first item", async () => {
    let calls = 0;
    server.handlers.ListEntries = (_, { write }) => {
      calls += 1;
      if (calls === 1) throw new GrpcFailure(UNAVAILABLE, "The ledger is restarting.");
      write(entry("e_1"));
      write(entry("e_2"));
    };
    const result = await sender.send(LIST_ENTRIES, {}, context());
    expect(result).toMatchObject({
      ok: true,
      attempts: 2,
      value: { items: [{ id: "e_1" }, { id: "e_2" }], truncated: false },
    });
  });

  it("does not retry a stream that already sent an item", async () => {
    server.handlers.ListEntries = (_, { write }) => {
      write(entry("e_1"));
      throw new GrpcFailure(UNAVAILABLE, "The ledger went away.");
    };
    const result = await sender.send(LIST_ENTRIES, {}, context());
    expect(result).toEqual({
      ok: false,
      error: { title: "UNAVAILABLE", detail: "The ledger went away.", status: UNAVAILABLE },
      attempts: 1,
    });
    expect(server.callsTo("ListEntries")).toHaveLength(1);
  });
});
