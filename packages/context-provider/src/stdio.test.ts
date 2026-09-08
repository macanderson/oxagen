/**
 * The provider answering a host over a pipe.
 *
 * #1084 asks for a provider that is *reachable*, not for one that would be if
 * something ran it. Every other test in this package calls the provider as a
 * function; this one starts a process, writes envelopes to its stdin, and
 * reads envelopes off its stdout — the shape the reference host and the
 * conformance suite drive.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_NAME } from "./provider";
import { FIXTURE_RECORD_ID, FIXTURE_VERSION } from "./testing/fixture-data";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The workspace root, found by the file that defines it. */
function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not find the workspace root from " + HERE);
}

interface Session {
  send(envelope: unknown): void;
  /** Write a line verbatim — the only way to send something that is not JSON. */
  sendRaw(line: string): void;
  next(): Promise<Record<string, unknown>>;
  stop(): void;
}

function startProvider(): Session {
  const tsx = join(repoRoot(), "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) {
    throw new Error(
      `tsx not found at ${tsx} — run pnpm install at the workspace root`,
    );
  }
  const child = spawn(tsx, [join(HERE, "testing", "stdio-fixture.ts")], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending: Array<(value: Record<string, unknown>) => void> = [];
  const ready: Array<Record<string, unknown>> = [];
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        const envelope = JSON.parse(line) as Record<string, unknown>;
        const waiter = pending.shift();
        if (waiter) waiter(envelope);
        else ready.push(envelope);
      }
      newline = buffer.indexOf("\n");
    }
  });

  return {
    send: (envelope) => child.stdin.write(`${JSON.stringify(envelope)}\n`),
    sendRaw: (line) => child.stdin.write(`${line}\n`),
    next: () =>
      new Promise((resolvePromise, rejectPromise) => {
        const immediate = ready.shift();
        if (immediate) return resolvePromise(immediate);
        const timer = setTimeout(
          () => rejectPromise(new Error("no envelope within 15s")),
          15_000,
        );
        pending.push((value) => {
          clearTimeout(timer);
          resolvePromise(value);
        });
      }),
    stop: () => child.kill(),
  };
}

describe("the provider over stdio", () => {
  let session: Session;

  beforeAll(() => {
    session = startProvider();
  });
  afterAll(() => session?.stop());

  it("answers a handshake with its identity and capabilities", async () => {
    session.send({
      type: "handshake",
      protocol_version: "contextgraph/1.0-draft",
    });
    const reply = await session.next();
    expect(reply.type).toBe("handshake_ack");
    expect(reply.provider).toMatchObject({
      name: PROVIDER_NAME,
      version: FIXTURE_VERSION,
      data_flow: { reads: true, writes: false, egress: false },
    });
    expect(reply.capabilities).toMatchObject({
      correlation: true,
      verify: true,
    });
  });

  it("answers a query with frames, echoing the correlation id", async () => {
    session.send({
      type: "query",
      id: "q-1",
      query: {
        goal: "why did the deploy fail",
        query_text: "deploy",
        max_frames: 5,
        max_tokens: 500,
      },
    });
    const reply = await session.next();
    expect(reply.type).toBe("frames");
    expect(reply.id).toBe("q-1");
    const result = reply.result as {
      frames: Array<{ id: string; token_cost: number; content: string }>;
      truncated: boolean;
    };
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.id).toBe(FIXTURE_RECORD_ID);
    expect(result.truncated).toBe(false);
  });

  it("verifies a frame it issued", async () => {
    session.send({
      type: "verify",
      request: {
        frames: [{ provider_id: PROVIDER_NAME, frame_id: FIXTURE_RECORD_ID }],
      },
    });
    const reply = await session.next();
    expect(reply.type).toBe("verified");
    const response = reply.response as {
      verdicts: Array<{ status: string }>;
    };
    expect(response.verdicts[0]?.status).toBe("valid");
  });

  // A host that writes one bad line must not lose the provider.
  it("stays alive on a malformed line and says so", async () => {
    session.sendRaw("not json at all");
    const reply = await session.next();
    expect(reply.type).toBe("error");
    expect(reply.code).toBe("bad_request");

    session.send({
      type: "query",
      id: "q-2",
      query: { goal: "still here", max_frames: 1, max_tokens: 100 },
    });
    const after = await session.next();
    expect(after.type).toBe("frames");
    expect(after.id).toBe("q-2");
  });
});
