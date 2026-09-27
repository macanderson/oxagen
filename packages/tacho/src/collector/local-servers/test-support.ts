/** Builders shared by the local-servers tests. Not part of the public surface. */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { EventEmitter } from "node:events";
import { keyIdForPublicKey } from "../../host/key-id";
import type { StdioSpawn, StdioSpawnOptions } from "./stdio-client";
import {
  argumentsHashOf,
  envelopeSigningBytes,
  LOCAL_CALL_ENVELOPE_SCHEMA,
  type CallDelivery,
  type LaunchSpec,
  type LocalCallEnvelope,
} from "./wire";

/** The machine the tests run as: a host_enrollment_id. */
export const MACHINE = "tch_0123456789abcdefghjkmn";

/** The moment every test treats as now. */
export const NOW = Date.parse("2026-09-27T12:00:00.000Z");

export const NPM_DIGEST = `sha256:${"a".repeat(64)}` as const;
export const DEFINITION_HASH = `sha256:${"b".repeat(64)}` as const;

export interface SigningKey {
  privateKey: KeyObject;
  publicKeyPem: string;
  keyId: string;
}

/** A fresh Ed25519 key, as the cloud gateway holds one. */
export function signingKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, publicKeyPem, keyId: keyIdForPublicKey(publicKeyPem) };
}

/** A new nonce: 16 random bytes in base64url, 22 characters. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** Sign an envelope with the key, as the cloud gateway does. */
export function signEnvelope(key: SigningKey, unsigned: Omit<LocalCallEnvelope, "signature">): LocalCallEnvelope {
  const sig = sign(null, envelopeSigningBytes(unsigned), key.privateKey).toString("base64");
  return { ...unsigned, signature: { key_id: key.keyId, alg: "ed25519", sig } };
}

/** An npm launch that has the launch table's shape. */
export function npmLaunch(overrides?: Partial<LaunchSpec>): LaunchSpec {
  return {
    server: "files",
    command: "npx",
    args: ["--yes", "@modelcontextprotocol/server-filesystem@2026.8.1", "${WORK_DIR}"],
    env: ["WORK_DIR"],
    package: {
      name: "@modelcontextprotocol/server-filesystem",
      version: "2026.8.1",
      digest: NPM_DIGEST,
      registry_type: "npm",
    },
    ...overrides,
  };
}

export interface CallDeliveryOptions {
  key: SigningKey;
  launch: LaunchSpec;
  arguments: Record<string, unknown>;
  /** Fields that replace the builder's before it signs. */
  envelope?: Partial<Omit<LocalCallEnvelope, "signature">>;
}

/** A signed call for MACHINE, issued a second before NOW and expiring 20 seconds after it. */
export function callDelivery(options: CallDeliveryOptions): CallDelivery {
  const unsigned: Omit<LocalCallEnvelope, "signature"> = {
    schema: LOCAL_CALL_ENVELOPE_SCHEMA,
    tool: "files.read_file",
    upstream: "read_file",
    version: 1,
    definition_hash: DEFINITION_HASH,
    package_digest: options.launch.package.digest,
    arguments_hash: argumentsHashOf(options.arguments),
    machine: MACHINE,
    nonce: newNonce(),
    issued_at: new Date(NOW - 1_000).toISOString(),
    expires_at: new Date(NOW + 20_000).toISOString(),
    ...options.envelope,
  };
  return {
    kind: "call",
    envelope: signEnvelope(options.key, unsigned),
    arguments: options.arguments,
    launch: options.launch,
  };
}

/** One JSON-RPC message the client wrote to the server. */
export interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

/** How a fake server answers each message the client writes. */
export type RpcAnswer = (message: RpcMessage, child: FakeChild) => void;

/** A fake server's stdin. The client writes one JSON-RPC message per line. */
class FakeStdin extends EventEmitter {
  ended = false;

  constructor(private readonly receive: (message: RpcMessage) => void) {
    super();
  }

  write(chunk: string): boolean {
    this.receive(JSON.parse(chunk) as RpcMessage);
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

/** A server process the tests drive by hand. */
export class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: FakeStdin;
  /** Every message the client wrote, in order. */
  readonly received: RpcMessage[] = [];
  killed = false;

  constructor(answer: RpcAnswer) {
    super();
    this.stdin = new FakeStdin((message) => {
      this.received.push(message);
      answer(message, this);
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** Write one JSON-RPC message to the client on stdout. */
  send(message: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
}

export interface Started {
  command: string;
  args: string[];
  options: StdioSpawnOptions;
  child: FakeChild;
}

export interface FakeSpawn {
  spawn: StdioSpawn;
  /** Every server the spawn started, in order. */
  started: Started[];
}

export function fakeSpawn(answer: RpcAnswer): FakeSpawn {
  const started: Started[] = [];
  return {
    started,
    spawn(command, args, options) {
      const child = new FakeChild(answer);
      started.push({ command, args, options, child });
      return child;
    },
  };
}

export interface McpServerBehaviour {
  serverInfo: Record<string, unknown>;
  tools: Record<string, unknown>[];
  call(params: Record<string, unknown>): Record<string, unknown>;
}

/** A server that answers initialize, tools/list, and tools/call the way an MCP server does. */
export function mcpServer(behaviour: McpServerBehaviour): RpcAnswer {
  return (message, child) => {
    // A notification carries no id and gets no answer.
    if (message.id === undefined) return;
    const results: Record<string, () => unknown> = {
      initialize: () => ({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: behaviour.serverInfo }),
      "tools/list": () => ({ tools: behaviour.tools }),
      "tools/call": () => behaviour.call(message.params as Record<string, unknown>),
    };
    child.send({ id: message.id, result: (results[message.method as string] as () => unknown)() });
  };
}
