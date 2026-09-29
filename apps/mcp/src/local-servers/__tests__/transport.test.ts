// transport.test.ts: the Transport a served call to a local server gets, and
// each reason it refuses to send (#4773).
import { TACHO_BUNDLE_SIGNING_KEY_ENV } from "@oxagen/handlers/lib/tacho-bundle-signing";
import type { LocalGatewayBroker } from "@oxagen/handlers/mcp-studio/local-calls/broker";
import {
  DEFINITION_HASH,
  FILES_DIGEST,
  FILES_LAUNCH,
  MACHINE,
  readerOf,
  testSigner,
} from "@oxagen/handlers/mcp-studio/local-calls/test-support";
import type { LocalCall, ManifestServer } from "@oxagen/mcp-studio";
import { describe, expect, it, vi } from "vitest";
import { run, server } from "../../servers/__tests__/fixtures";
import { ServedRouteError, type ServedRoute } from "../../servers/types";
import { localGatewayBroker } from "../broker";
import { localTransport, type LocalTransportDeps } from "../transport";

type Reply = Awaited<ReturnType<LocalGatewayBroker["dispatch"]>>;

/** A local files server whose lock and source say how a machine in laptops starts it. */
function filesServer(): ManifestServer {
  const built = server({ name: "files", source: "local", tools: [{ key: "read_file" }] });
  return {
    ...built,
    pinned: {
      type: "local",
      command: FILES_LAUNCH.command,
      package: FILES_LAUNCH.package,
      server_version: FILES_LAUNCH.package.version,
    },
    source: { type: "local", command: FILES_LAUNCH.command, args: FILES_LAUNCH.args, machines: ["laptops"] },
  } as unknown as ManifestServer;
}

function route(overrides: Partial<ServedRoute> = {}): ServedRoute {
  return { network: "local", server: filesServer(), run: run({ machine: MACHINE }), ...overrides };
}

function brokerWith(dispatch: LocalGatewayBroker["dispatch"]): LocalGatewayBroker {
  return {
    connected: () => true,
    dispatch,
    next: () => Promise.resolve(undefined),
    reply: () => ({ accepted: true }),
  };
}

function deps(overrides: Partial<LocalTransportDeps> = {}): LocalTransportDeps {
  const signer = testSigner();
  return {
    reader: readerOf({ [MACHINE]: ["laptops"] }),
    signer: () => signer,
    broker: () => brokerWith(() => Promise.reject(new Error("no call was expected"))),
    ...overrides,
  };
}

function call(): LocalCall {
  return {
    tool: "files__read_file",
    upstream: "read_file",
    version: 1,
    definition_hash: DEFINITION_HASH,
    package_digest: FILES_DIGEST,
    arguments: { path: "notes.txt" },
    deadline_ms: 30_000,
    signal: new AbortController().signal,
  };
}

function refusalOf(thrower: () => unknown): ServedRouteError {
  try {
    thrower();
  } catch (error) {
    if (error instanceof ServedRouteError) return error;
    throw error;
  }
  throw new Error("localTransport sent the call");
}

describe("localTransport", () => {
  it("refuses to send when this deployment holds no signing key, and names the setting", () => {
    const broker = vi.fn(() => brokerWith(() => Promise.reject(new Error("unused"))));
    const refused = refusalOf(() => localTransport(route(), deps({ signer: () => undefined, broker })));
    expect(refused.code).toBe("local_unavailable");
    expect(refused.message).toContain(TACHO_BUNDLE_SIGNING_KEY_ENV);
    expect(broker).not.toHaveBeenCalled();
  });

  it("refuses to send when the run names no enrolled machine", () => {
    const refused = refusalOf(() => localTransport(route({ run: run({ machine: null }) }), deps()));
    expect(refused.code).toBe("local_unavailable");
    expect(refused.message).toBe(
      "This run names no enrolled machine, so Oxagen sent nothing. Run the agent under tacho on an enrolled machine, then retry.",
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ["a lock that is not local", { pinned: { type: "remote" } }],
    [
      "a registry lock whose source names no machines",
      { pinned: { type: "registry", package: FILES_LAUNCH.package }, source: { type: "registry" } },
    ],
  ])("refuses to send for %s, and says to lock the tools again", (_name, change) => {
    const changed = { ...filesServer(), ...change } as unknown as ManifestServer;
    const refused = refusalOf(() => localTransport(route({ server: changed }), deps()));
    expect(refused.code).toBe("local_unavailable");
    expect(refused.message).toBe(
      "The lock does not say how a machine starts files, so Oxagen sent nothing. Run tools lock in the steering repo, then open a steering PR.",
    );
  });

  it("signs the call and hands it to the broker for the run's machine", async () => {
    const answer = { content: [{ type: "text", text: "read from the machine" }] };
    const dispatch = vi.fn((_machine: string, delivery: Parameters<LocalGatewayBroker["dispatch"]>[1]) =>
      Promise.resolve({
        kind: "result",
        id: delivery.kind === "call" ? delivery.envelope.nonce : delivery.id,
        machine: MACHINE,
        result: answer,
        redactions: 0,
      } as unknown as Reply),
    );
    const transport = localTransport(route(), deps({ broker: () => brokerWith(dispatch) }));
    await expect(transport.local(call())).resolves.toEqual(answer);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [machine, delivery] = dispatch.mock.calls[0] ?? [];
    expect(machine).toBe(MACHINE);
    expect(delivery).toMatchObject({
      kind: "call",
      envelope: { machine: MACHINE, tool: "files__read_file", package_digest: FILES_DIGEST },
      arguments: { path: "notes.txt" },
      launch: { server: "files", command: FILES_LAUNCH.command, package: { digest: FILES_DIGEST } },
    });
  });
});

describe("localGatewayBroker", () => {
  it("gives every caller in the process the same broker", () => {
    expect(localGatewayBroker()).toBe(localGatewayBroker());
  });
});
