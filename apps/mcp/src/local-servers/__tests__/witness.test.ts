// witness.test.ts: one local tool call from the agent to a machine and back
// (#4773).
//
// An agent calls files__read_file through the served-tools call path. The
// call waits in the process's broker. A fake local gateway holds the
// machine's long-poll on GET /v1/local-servers/next, reads the signed call
// with tacho's own schema, and answers on POST /v1/local-servers/replies.
// The agent then reads the machine's answer. Before #4773 no route served
// the poll, so every such call read "Not connected".
import {
  createInProcessBroker,
  LOCAL_SERVERS_NEXT_PATH,
  LOCAL_SERVERS_REPLY_PATH,
} from "@oxagen/handlers/mcp-studio/local-calls/broker";
import {
  deliveryOffTheWire,
  FILES_DIGEST,
  FILES_LAUNCH,
  MACHINE,
  readerOf,
  testSigner,
} from "@oxagen/handlers/mcp-studio/local-calls/test-support";
import type { ManifestServer } from "@oxagen/mcp-studio";
import { describe, expect, it, vi } from "vitest";
import { callServed } from "../../servers/call";
import { fakePorts, POLICIES, published, run, server, textOf, view } from "../../servers/__tests__/fixtures";
import { createMachineAuth, MACHINE_HEADER } from "../auth";
import { createLocalServersRoute } from "../route";
import { localTransport } from "../transport";
import { serve } from "./http";

const GATEWAY_PURPOSE = "tacho_gateway_v1";
const HEADERS = { authorization: "Bearer ox_gateway_key", [MACHINE_HEADER]: MACHINE };

/** The files server as a steering repo locks it: it runs on machines in the laptops group. */
function filesServer(): ManifestServer {
  const built = server({
    name: "files",
    source: "local",
    tools: [
      {
        key: "read_file",
        description: "Read one file on the machine.",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    ],
  });
  return {
    ...built,
    pinned: {
      type: "local",
      command: FILES_LAUNCH.command,
      package: FILES_LAUNCH.package,
      server_version: FILES_LAUNCH.package.version,
    },
    source: {
      type: "local",
      command: FILES_LAUNCH.command,
      args: FILES_LAUNCH.args,
      env: FILES_LAUNCH.env,
      machines: ["laptops"],
    },
  } as unknown as ManifestServer;
}

/**
 * The fixture policies that name no billing tool. A policy that names an
 * action the manifest lacks does not compile, and with no compiled policy the
 * call path denies every call.
 */
const FILES_POLICIES = POLICIES.filter((file) => file.path === "policy/approvals.cedar");

/** The call path, the broker, and the route, wired the way index.ts wires them. */
async function wire() {
  const broker = createInProcessBroker();
  const signer = testSigner();
  const { ports } = fakePorts({
    transport: (route) =>
      localTransport(route, {
        reader: readerOf({ [MACHINE]: ["laptops"] }),
        signer: () => signer,
        broker: () => broker,
      }),
  });
  const served = await view(
    published({ servers: [filesServer()], policies: FILES_POLICIES }),
    ports,
    run({ machine: MACHINE }),
  );
  const route = createLocalServersRoute({
    authenticate: createMachineAuth({
      gatewayPurpose: GATEWAY_PURPOSE,
      resolveKey: () =>
        Promise.resolve({ ok: true, apiKeyId: "key_1", orgId: "org_1", workspaceId: "ws_1", userId: null }),
      readScope: () => Promise.resolve({ kind: "purpose", purpose: GATEWAY_PURPOSE, hostEnrollmentId: MACHINE }),
      readHost: () =>
        Promise.resolve({ status: "active", expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null }),
    }),
    broker: () => broker,
    waitMs: 5_000,
  });
  const call = (args: Record<string, unknown>) => callServed(served, ports, "files__read_file", args);
  return { broker, route, call };
}

describe("a local tool call through the long-poll", () => {
  it("reaches the machine that polls, and returns the machine's answer to the agent", async () => {
    const { broker, route, call } = await wire();

    // The machine's local gateway polls, as tacho's cloud link does.
    const polled = serve(route, { method: "GET", path: LOCAL_SERVERS_NEXT_PATH, headers: HEADERS });
    await vi.waitFor(() => expect(broker.connected(MACHINE)).toBe(true));

    // The agent calls the tool. The call waits for the machine's reply.
    const answered = call({ path: "notes.txt" });

    const poll = await polled;
    if (poll === "passed") throw new Error("the route passed the machine's poll on");
    expect(poll.status).toBe(200);
    const delivery = deliveryOffTheWire(poll.body);
    if (delivery.kind !== "call") throw new Error(`the machine received a ${delivery.kind}, not a call`);
    expect(delivery.envelope.machine).toBe(MACHINE);
    expect(delivery.envelope.tool).toBe("files__read_file");
    expect(delivery.envelope.upstream).toBe("read_file");
    expect(delivery.launch.package.digest).toBe(FILES_DIGEST);
    expect(delivery.arguments).toEqual({ path: "notes.txt" });

    // The machine runs the server and answers.
    const replied = await serve(route, {
      method: "POST",
      path: LOCAL_SERVERS_REPLY_PATH,
      headers: HEADERS,
      body: {
        kind: "result",
        id: delivery.envelope.nonce,
        machine: MACHINE,
        result: { content: [{ type: "text", text: "read from the machine" }] },
        redactions: 0,
      },
    });
    expect(replied).toMatchObject({ status: 204 });

    const result = await answered;
    expect(result?.isError).not.toBe(true);
    expect(textOf(result)).toBe("read from the machine");
  });

  it("reads Not connected when no machine polls", async () => {
    const { call } = await wire();
    const result = await call({ path: "notes.txt" });
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain("Not connected");
  });
});
