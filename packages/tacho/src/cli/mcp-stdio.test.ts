/**
 * The shim is deliberately thin — every decision belongs to the gateway — so
 * what is worth testing is that it stays thin and that it never leaves a
 * connected app with a dead server: a client that loses its MCP server
 * mid-conversation shows the user nothing, so a failure has to come back as a
 * JSON-RPC error the app can render.
 */
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type McpStdioDeps,
  resolveTarget,
  runMcpStdio,
  shimError,
} from "./mcp-stdio";

const ENROLLMENT = "tch_abcdefghijklmnopqrstuv";

function lines(...messages: unknown[]): Readable {
  return Readable.from(messages.map((m) => `${JSON.stringify(m)}\n`));
}

function deps(
  overrides: Partial<McpStdioDeps> & { out?: string[] } = {},
): McpStdioDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdin: Readable.from([]),
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    env: {
      TACHO_LOCAL_TOKEN: "tok",
      TACHO_HOME: mkdtempSync(join(tmpdir(), "tacho-shim-")),
    },
    fetch: (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"jsonrpc":"2.0","id":1,"result":{}}',
    })) as unknown as typeof globalThis.fetch,
    ...overrides,
    out,
    err,
  };
}

describe("resolving where to post", () => {
  it("needs a port and a token", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-empty-"));
    const target = resolveTarget({}, { env: { TACHO_HOME: home }, home });
    expect(target.ok).toBe(false);
    if (!target.ok) {
      // The message a non-developer reads inside Claude Desktop, so it names
      // the app and the action rather than a file path.
      expect(target.message).toContain("not enrolled");
      expect(target.message).toContain("Oxagen app");
      expect(target.message).toContain("restart");
    }
  });

  it("builds the scoped loopback URL from the flags", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-empty-"));
    const target = resolveTarget(
      { port: 45231, enrollment: ENROLLMENT },
      { env: { TACHO_LOCAL_TOKEN: "tok", TACHO_HOME: home }, home },
    );
    expect(target).toEqual({
      ok: true,
      url: `http://127.0.0.1:45231/mcp/${ENROLLMENT}`,
      token: "tok",
    });
  });

  it("omits the scope when the entry carries no enrollment", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-empty-"));
    const target = resolveTarget(
      { port: 1234 },
      { env: { TACHO_LOCAL_TOKEN: "tok", TACHO_HOME: home }, home },
    );
    expect(target.ok && target.url).toBe("http://127.0.0.1:1234/mcp");
  });

  it("survives a host.json it cannot parse", () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-bad-"));
    const root = join(home, "root");
    writeFileSync(join(mkdtempSync(join(tmpdir(), "x-")), "ignored"), "");
    const target = resolveTarget(
      { port: 9, enrollment: ENROLLMENT },
      { env: { TACHO_LOCAL_TOKEN: "tok", TACHO_HOME: root }, home },
    );
    expect(target.ok).toBe(true);
  });
});

describe("the pump", () => {
  it("forwards each line and writes the answer back", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
    }));
    const d = deps({
      stdin: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await runMcpStdio({ port: 45231, enrollment: ENROLLMENT }, d);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:45231/mcp/${ENROLLMENT}`);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok",
    );
    expect(d.out).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n']);
  });

  it("carries the session id the gateway assigned on every later call", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name === "mcp-session-id" ? "mcp_abc" : null),
      },
      text: async () => '{"jsonrpc":"2.0","id":1,"result":{}}',
    }));
    const d = deps({
      stdin: lines(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await runMcpStdio({ port: 1, enrollment: ENROLLMENT }, d);
    const second = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(
      (second[1].headers as Record<string, string>)["Mcp-Session-Id"],
    ).toBe("mcp_abc");
  });

  it("answers rather than dying when the collector is down", async () => {
    const d = deps({
      stdin: lines({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch,
    });
    await runMcpStdio({ port: 1, enrollment: ENROLLMENT }, d);
    const answer = JSON.parse(d.out[0] as string) as {
      id: number;
      error: { message: string };
    };
    expect(answer.id).toBe(7);
    expect(answer.error.message).toContain("not answering");
    expect(answer.error.message).toContain("Oxagen app");
    expect(d.err.join("")).toContain("ECONNREFUSED");
  });

  it("answers rather than dying on a line that is not JSON", async () => {
    const d = deps({ stdin: Readable.from(["not json\n"]) });
    await runMcpStdio({ port: 1 }, d);
    expect(JSON.parse(d.out[0] as string).error.message).toContain("not JSON");
  });

  it("skips blank lines", async () => {
    const fetch = vi.fn();
    const d = deps({
      stdin: Readable.from(["\n", "   \n"]),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await runMcpStdio({ port: 1 }, d);
    expect(fetch).not.toHaveBeenCalled();
    expect(d.out).toEqual([]);
  });

  it("tells an unenrolled machine's client why there are no tools", async () => {
    const home = mkdtempSync(join(tmpdir(), "tacho-none-"));
    const d = deps({
      stdin: lines({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      env: { TACHO_HOME: home },
    });
    await runMcpStdio({}, d);
    const answer = JSON.parse(d.out[0] as string) as {
      id: number;
      error: { message: string };
    };
    expect(answer.id).toBe(3);
    expect(answer.error.message).toContain("not enrolled");
  });
});

describe("the error envelope", () => {
  it("is a JSON-RPC refusal, so a client renders it as a decision", () => {
    expect(shimError(4, "no")).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32002, message: "no" },
    });
  });

  it("uses a null id when the request had none", () => {
    expect(shimError(undefined, "no")).toHaveProperty("id", null);
  });
});
