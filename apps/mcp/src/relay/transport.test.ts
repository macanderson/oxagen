// transport.test.ts: the relay Transport a served call uses (lane M12).
//
// Each test binds a fake broker and a fake scope reader, so nothing here
// opens a socket or reads a database.
import type {
  GrpcTransportRequest,
  GrpcTransportResponse,
  HttpTransportRequest,
  HttpTransportResponse,
  RelayCredential,
  Transport,
} from "@oxagen/mcp-studio";
import { TransportError } from "@oxagen/mcp-studio";
import type { RelayBroker, RelayScope } from "@oxagen/relay-broker";
import { describe, expect, it, vi } from "vitest";
import { createRelayTransport, type RelayBrokerState } from "./transport";

const RUN = { orgId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const ROUTE = { network: "relay:billing", run: RUN };
const SCOPE: RelayScope = { ...RUN, workspacePublicId: "wrk_0123456789abcdefghijkl" };
const SCOPE_READ_FAILED =
  "Oxagen could not read the workspace for this relay call, so it sent nothing. Call the tool again in a minute.";

function httpRequest(): HttpTransportRequest {
  return {
    network: "relay:billing",
    deadline_ms: 30_000,
    signal: new AbortController().signal,
    relay_credential: undefined,
    target: { kind: "http", scheme: "https", method: "GET", host: "billing.internal", port: 443, path: "/invoices" },
    headers: [],
    body: new Uint8Array(),
  } as HttpTransportRequest;
}

function grpcRequest(): GrpcTransportRequest {
  return {
    network: "relay:billing",
    deadline_ms: 30_000,
    signal: new AbortController().signal,
    relay_credential: undefined,
    target: { kind: "grpc", scheme: "https", host: "ledger.internal", port: 50051, service: "ledger.v1.Ledger", method: "GetEntry" },
    metadata: [],
    message: new Uint8Array(),
  } as GrpcTransportRequest;
}

const HTTP_RESPONSE = { status: 200, headers: [], body: (async function* () {})(), cancel: () => {} } as HttpTransportResponse;
const GRPC_RESPONSE = { messages: (async function* () {})(), status: async () => ({ code: 0, message: "", metadata: [] }), cancel: () => {} } as GrpcTransportResponse;

function fakeBroker() {
  const inner: Transport = {
    http: vi.fn(async () => HTTP_RESPONSE),
    grpc: vi.fn(async () => GRPC_RESPONSE),
    local: vi.fn(async () => ({ content: [] })),
  };
  const broker = {
    handleUpgrade: vi.fn(async () => {}),
    transport: vi.fn((_scope: RelayScope) => inner),
    ready: vi.fn(async (_scope: RelayScope, _network: string, _credential: RelayCredential | undefined) => {}),
    status: vi.fn(() => "down" as const),
    close: vi.fn(async () => {}),
  } satisfies RelayBroker;
  return { broker, inner };
}

async function rejection(promise: Promise<unknown>): Promise<TransportError> {
  const error = await promise.then(
    () => {
      throw new Error("The call resolved, and the test expected a refusal.");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TransportError);
  return error as TransportError;
}

describe("createRelayTransport", () => {
  it("reads neither the broker nor the scope until the first call", () => {
    const broker = vi.fn((): RelayBrokerState => ({ broker: null, reason: "none" }));
    const scope = vi.fn(async () => SCOPE);
    createRelayTransport(ROUTE, { broker, scope });
    expect(broker).not.toHaveBeenCalled();
    expect(scope).not.toHaveBeenCalled();
  });

  it("refuses every call with the reason when the deployment has no broker, and reads no scope", async () => {
    const reason = "This deployment holds no key to sign relay calls, so Oxagen sent nothing.";
    const scope = vi.fn(async () => SCOPE);
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker: null, reason }), scope });

    const http = await rejection(transport.http(httpRequest()));
    expect(http.code).toBe("unsupported");
    expect(http.sent).toBe(false);
    expect(http.message).toBe(reason);

    const grpc = await rejection(transport.grpc(grpcRequest()));
    expect(grpc.code).toBe("unsupported");
    expect(grpc.sent).toBe(false);
    expect(scope).not.toHaveBeenCalled();
  });

  it("hands each call to the broker's Transport for the run's scope", async () => {
    const { broker, inner } = fakeBroker();
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker }), scope: async () => SCOPE });

    const request = httpRequest();
    await expect(transport.http(request)).resolves.toBe(HTTP_RESPONSE);
    expect(broker.transport).toHaveBeenCalledWith(SCOPE);
    expect(inner.http).toHaveBeenCalledWith(request);

    const call = grpcRequest();
    await expect(transport.grpc(call)).resolves.toBe(GRPC_RESPONSE);
    expect(inner.grpc).toHaveBeenCalledWith(call);
  });

  it("reads the scope once for every call in the run", async () => {
    const { broker } = fakeBroker();
    const scope = vi.fn(async () => SCOPE);
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker }), scope });

    await Promise.all([transport.http(httpRequest()), transport.http(httpRequest()), transport.grpc(grpcRequest())]);
    expect(scope).toHaveBeenCalledTimes(1);
    expect(scope).toHaveBeenCalledWith(RUN.orgId, RUN.workspaceId);
  });

  it("refuses a call as not sent when the scope read fails, and reads again on the next call", async () => {
    const { broker, inner } = fakeBroker();
    const scope = vi.fn<(orgId: string, workspaceId: string) => Promise<RelayScope>>();
    scope
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED postgres://oxagen:hunter2@db.internal:5432"))
      .mockResolvedValueOnce(SCOPE);
    const warn = vi.fn();
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker }), scope, warn });

    const error = await rejection(transport.http(httpRequest()));
    expect(error.code).toBe("not_sent");
    expect(error.sent).toBe(false);
    // The read's own message can quote a connection string, so neither the
    // refusal nor the log carries it.
    expect(error.message).toBe(SCOPE_READ_FAILED);
    expect(warn).toHaveBeenCalledWith("The relay call's workspace read failed, so the call was not sent.", {
      error: "Error",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("hunter2");
    expect(inner.http).not.toHaveBeenCalled();

    await expect(transport.http(httpRequest())).resolves.toBe(HTTP_RESPONSE);
    expect(scope).toHaveBeenCalledTimes(2);
  });

  it("keeps a scope read failure that is not an Error out of the refusal and the log", async () => {
    const { broker } = fakeBroker();
    const warn = vi.fn();
    const transport = createRelayTransport(ROUTE, {
      broker: () => ({ broker }),
      scope: () => Promise.reject("socket closed"),
      warn,
    });
    const error = await rejection(transport.grpc(grpcRequest()));
    expect(error.message).toBe(SCOPE_READ_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.any(String), { error: "string" });
  });

  it("passes the broker's own refusal through unchanged", async () => {
    const { broker, inner } = fakeBroker();
    const refusal = new TransportError("disconnected", "Relay billing is not connected to Oxagen.", false);
    vi.mocked(inner.http).mockRejectedValueOnce(refusal);
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker }), scope: async () => SCOPE });
    await expect(transport.http(httpRequest())).rejects.toBe(refusal);
  });

  it("refuses a local server call, because a relay carries only HTTP and gRPC", async () => {
    const { broker } = fakeBroker();
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker }), scope: async () => SCOPE });
    const error = await rejection(
      transport.local({
        tool: "files__read_file",
        upstream: "read_file",
        version: 1,
        definition_hash: "sha256:0",
        package_digest: "sha256:0",
        arguments: {},
        deadline_ms: 30_000,
        signal: new AbortController().signal,
      }),
    );
    expect(error.code).toBe("unsupported");
    expect(error.sent).toBe(false);
    expect(broker.transport).not.toHaveBeenCalled();
  });
});

describe("the relay Transport's refusal", () => {
  const relayCredential: RelayCredential = { name: "billing-token", scheme: "bearer" };

  it("answers with the reason when the deployment has no broker, and reads no scope", async () => {
    const reason = "This deployment holds no key to sign relay calls, so Oxagen sent nothing.";
    const scope = vi.fn(async () => SCOPE);
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker: null, reason }), scope });
    await expect(transport.refusal(null)).resolves.toBe(reason);
    expect(scope).not.toHaveBeenCalled();
  });

  it("answers null when the broker would take the call, and hands it the run's scope and the route's network", async () => {
    const { broker, inner } = fakeBroker();
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker }), scope: async () => SCOPE });
    await expect(transport.refusal({ type: "bearer", token: "tok_1" })).resolves.toBeNull();
    // Only a relay credential reaches the broker: the others are sent as headers.
    expect(broker.ready).toHaveBeenCalledWith(SCOPE, "relay:billing", undefined);
    expect(inner.http).not.toHaveBeenCalled();
  });

  it("hands the broker a relay credential to check against the plan", async () => {
    const { broker } = fakeBroker();
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker }), scope: async () => SCOPE });
    await transport.refusal({ type: "relay", credential: relayCredential });
    expect(broker.ready).toHaveBeenCalledWith(SCOPE, "relay:billing", relayCredential);
  });

  it("answers with the broker's refusal", async () => {
    const { broker } = fakeBroker();
    const down = "Relay billing is not connected to Oxagen. Start the relay in your network, or read its logs for why it cannot connect.";
    vi.mocked(broker.ready).mockRejectedValueOnce(new TransportError("disconnected", down, false));
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker }), scope: async () => SCOPE });
    await expect(transport.refusal(null)).resolves.toBe(down);
  });

  it("answers with the fixed text when the scope read fails", async () => {
    const { broker } = fakeBroker();
    const transport = createRelayTransport(ROUTE, {
      broker: () => ({ broker }),
      scope: () => Promise.reject(new Error("relation workspaces does not exist")),
    });
    await expect(transport.refusal(null)).resolves.toBe(SCOPE_READ_FAILED);
    expect(broker.ready).not.toHaveBeenCalled();
  });

  it("shares one scope read with the send that follows it", async () => {
    const { broker } = fakeBroker();
    const scope = vi.fn(async () => SCOPE);
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker }), scope });
    await transport.refusal(null);
    await transport.http(httpRequest());
    expect(scope).toHaveBeenCalledTimes(1);
  });

  it("throws a failure that is not a TransportError, so runTool refuses the call", async () => {
    const { broker } = fakeBroker();
    const bug = new TypeError("ready is not a function");
    vi.mocked(broker.ready).mockRejectedValueOnce(bug);
    const transport = createRelayTransport(ROUTE, { broker: () => ({ broker }), scope: async () => SCOPE });
    await expect(transport.refusal(null)).rejects.toBe(bug);
  });
});
