// end-to-end.test.ts: one call from the cloud gateway's Transport to a
// server on the machine and back, with both halves of lane M14 in one
// process. The in-process broker stands in for the two routes the local
// gateway calls, and a fake stdio server stands in for the package. The
// signer, envelope, broker, verifier, launch, digest check, MCP client, and
// screen are the real ones.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalCall } from "@oxagen/mcp-studio";
import {
  createLocalServers,
  type CloudLink,
  type Delivery,
  type LocalServers,
  type MachineEnv,
  type PackageDigester,
  type StdioChild,
  type StdioSpawn,
} from "@oxagen/recorder/local-servers";
import { createInProcessBroker, type LocalGatewayBroker } from "./broker";
import { createLocalTransport } from "./transport";
import { DEFINITION_HASH, FILES_DIGEST, FILES_LAUNCH, MACHINE, SCOPE, readerOf, testSigner } from "./test-support";

const WORK_DIR = "/home/dev/notes";
const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

interface Started {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A files server that reads one file whose text carries an AWS key. */
function filesServer(started: Started[]): StdioSpawn {
  return (command, args, options) => {
    started.push({ command, args, env: options.env });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    function answer(message: RpcMessage): void {
      // A notification carries no id and gets no answer.
      if (message.id === undefined) return;
      const path = (message.params?.arguments as { path?: string } | undefined)?.path;
      const results: Record<string, unknown> = {
        initialize: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "files", version: "2026.8.1" },
        },
        "tools/list": { tools: [{ name: "read_file", inputSchema: { type: "object" } }] },
        "tools/call": { content: [{ type: "text", text: `${String(path)}: key=${AWS_KEY}` }] },
      };
      const line = `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: results[message.method ?? ""] })}\n`;
      queueMicrotask(() => stdout.emit("data", line));
    }
    const child: StdioChild = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), {
        write(chunk: string): boolean {
          answer(JSON.parse(chunk) as RpcMessage);
          return true;
        },
        end: () => undefined,
      }),
      stdout,
      stderr,
      kill: () => true,
    });
    return child;
  };
}

/** The local gateway's link to the cloud, over the in-process broker instead of HTTP. */
function brokerLink(broker: LocalGatewayBroker, delivered: Delivery[]): CloudLink {
  return {
    async next(signal) {
      const delivery = await broker.next(MACHINE, signal ?? new AbortController().signal, 50);
      if (delivery !== undefined) delivered.push(delivery);
      return delivery;
    },
    reply(reply) {
      const outcome = broker.reply(MACHINE, reply);
      if (!outcome.accepted) return Promise.reject(new Error(`the broker refused the reply: ${outcome.reason}`));
      return Promise.resolve();
    },
  };
}

function localCall(): LocalCall {
  return {
    tool: "files__read_file",
    upstream: "read_file",
    version: 2,
    definition_hash: DEFINITION_HASH,
    package_digest: FILES_DIGEST,
    arguments: { path: "today.md" },
    deadline_ms: 5_000,
    signal: new AbortController().signal,
  };
}

interface Rig {
  call(): Promise<unknown>;
  started: Started[];
  delivered: Delivery[];
  servers: LocalServers;
  log: string[];
}

let running: LocalServers | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function rig(options: { env?: MachineEnv; digest?: `sha256:${string}` } = {}): Promise<Rig> {
  const signer = testSigner();
  const broker = createInProcessBroker();
  const started: Started[] = [];
  const delivered: Delivery[] = [];
  const log: string[] = [];
  const digester: Pick<PackageDigester, "digest"> = { digest: () => Promise.resolve(options.digest ?? FILES_DIGEST) };
  const servers = createLocalServers({
    machine: MACHINE,
    publicKeyPem: signer.publicKeyPem,
    link: brokerLink(broker, delivered),
    spawn: filesServer(started),
    env: options.env ?? { PATH: "/usr/bin", WORK_DIR, AWS_SECRET_ACCESS_KEY: "not passed" },
    digester,
    log: (line) => log.push(line),
  });
  running = servers;
  servers.start();
  await vi.waitFor(() => expect(broker.connected(MACHINE)).toBe(true));

  const transport = createLocalTransport({
    scope: SCOPE,
    machine: MACHINE,
    groups: ["dev-laptops"],
    reader: readerOf({ [MACHINE]: ["dev-laptops"] }),
    signer,
    broker,
    launch: FILES_LAUNCH,
  });
  return { call: () => transport.local(localCall()), started, delivered, servers, log };
}

describe("a local call from the Transport to the machine and back", () => {
  it("runs the locked package with ${WORK_DIR} filled and returns the screened result", async () => {
    const { call, started } = await rig();

    await expect(call()).resolves.toEqual({
      content: [{ type: "text", text: "today.md: key=[redacted:aws_access_key]" }],
    });

    expect(started).toHaveLength(1);
    expect(started[0]?.command).toBe("npx");
    expect(started[0]?.args).toEqual(["--yes", "@modelcontextprotocol/server-filesystem@2026.8.1", WORK_DIR]);
    expect(started[0]?.env).toEqual({ PATH: "/usr/bin", WORK_DIR });
  });

  it("refuses a replayed envelope on the machine", async () => {
    const { call, delivered, servers } = await rig();
    await call();
    const first = delivered[0];
    expect(first).toBeDefined();

    const replayed = await servers.handle(first as Delivery);

    expect(replayed).toMatchObject({ kind: "refused", machine: MACHINE, refusal: { code: "envelope_replayed" } });
  });

  it("refuses to start a package whose digest differs from the lock's", async () => {
    const { call, started } = await rig({ digest: `sha256:${"b".repeat(64)}` });

    const result = await call();

    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "digest_mismatch" } } });
    expect(started).toHaveLength(0);
  });

  it("refuses a machine that does not set a variable the launch lists", async () => {
    const { call, started } = await rig({ env: { PATH: "/usr/bin" } });

    const result = await call();

    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "missing_variable" } } });
    expect(JSON.stringify(result)).toContain("WORK_DIR");
    expect(started).toHaveLength(0);
  });
});
