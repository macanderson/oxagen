/**
 * The memory recall (`memory-recall.ts`) against a fake control plane: the
 * request it makes, the memories it returns, and the empty answer every
 * failure turns into, the timeout among them.
 */
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../host/control-client";
import {
  createMemoryRecall,
  MEMORY_RECALL_PATH,
  MEMORY_RECALL_TEXT_MAX_CHARS,
  MEMORY_RECALL_TIMEOUT_MS,
} from "./memory-recall";

const HOST_ENROLLMENT_ID = "tch_0123456789abcdefghjkmn";

const HOST = {
  api_url: "https://api.oxagen.test/",
  api_key: "oxk_host",
  host_enrollment_id: HOST_ENROLLMENT_ID,
};

const ITEMS = [
  {
    id: "a-intel.memory.pnpm",
    source: "record",
    statement: "Use pnpm.",
    score: 0.9,
    tokens: 3,
  },
  {
    id: "mem_01",
    source: "memory",
    statement: "Run the gate in CI.",
    score: 0.4,
    tokens: 6,
  },
];

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

type Answer = { status: number; body: string } | Error | "hang";

/** A control plane that answers each ask with the next answer. */
function plane(answers: Answer[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    });
    const answer = answers.shift() ?? {
      status: 200,
      body: JSON.stringify({ items: [] }),
    };
    if (answer === "hang") return new Promise<never>(() => undefined);
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => answer.body,
    };
  };
  return { fetch, calls };
}

function ok(items: unknown[] = ITEMS): Answer {
  return { status: 200, body: JSON.stringify({ items }) };
}

function recall(fetch: FetchLike, options: { timeoutMs?: number } = {}) {
  const lines: string[] = [];
  let clock = Date.parse("2026-09-27T01:00:00.000Z");
  const ask = createMemoryRecall({
    host: () => HOST,
    fetch,
    log: (line) => lines.push(line),
    now: () => clock,
    ...options,
  });
  return {
    ask,
    lines,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const REQUEST = { repository: null, text: "How do I install?" };

describe("a recall", () => {
  it("posts the host, the prompt, and no tools or paths with the host key", async () => {
    const { fetch, calls } = plane([ok()]);
    await recall(fetch).ask(REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `https://api.oxagen.test${MEMORY_RECALL_PATH}`,
      method: "POST",
      headers: {
        Authorization: "Bearer oxk_host",
        "Content-Type": "application/json",
      },
      body: {
        host_enrollment_id: HOST_ENROLLMENT_ID,
        repository: null,
        tools: [],
        paths: [],
        text: "How do I install?",
      },
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the memories in the order the control plane ranked them", async () => {
    const { fetch } = plane([ok()]);
    const { ask, lines } = recall(fetch);
    expect(await ask(REQUEST)).toEqual([
      { id: "a-intel.memory.pnpm", statement: "Use pnpm." },
      { id: "mem_01", statement: "Run the gate in CI." },
    ]);
    expect(lines).toEqual([]);
  });

  it("cuts a long prompt to what the route takes", async () => {
    const { fetch, calls } = plane([ok()]);
    await recall(fetch).ask({
      repository: null,
      text: "x".repeat(MEMORY_RECALL_TEXT_MAX_CHARS + 50),
    });
    const body = calls[0]?.body as { text: string };
    expect(body.text).toHaveLength(MEMORY_RECALL_TEXT_MAX_CHARS);
  });

  it("never ends the cut prompt on half a surrogate pair", async () => {
    const { fetch, calls } = plane([ok()]);
    await recall(fetch).ask({
      repository: null,
      text: `${"x".repeat(MEMORY_RECALL_TEXT_MAX_CHARS - 1)}😀`,
    });
    const body = calls[0]?.body as { text: string };
    expect(body.text).toBe("x".repeat(MEMORY_RECALL_TEXT_MAX_CHARS - 1));
  });

  it("returns nothing, and logs nothing, when the control plane recalls nothing", async () => {
    const { fetch } = plane([ok([])]);
    const { ask, lines } = recall(fetch);
    expect(await ask(REQUEST)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("gives up after its timeout, aborts the request, and returns nothing", async () => {
    const { fetch, calls } = plane(["hang"]);
    const { ask, lines } = recall(fetch, { timeoutMs: 20 });
    expect(await ask(REQUEST)).toEqual([]);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(lines).toEqual([
      "memory recall: the control plane took longer than 20 ms to answer; prompts go on without recalled memories",
    ]);
  });

  it("waits one second by default", () => {
    expect(MEMORY_RECALL_TIMEOUT_MS).toBe(1_000);
  });

  it("returns nothing when the control plane is unreachable, and logs the failure once", async () => {
    const { fetch } = plane([
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
    ]);
    const { ask, lines } = recall(fetch);
    expect(await ask(REQUEST)).toEqual([]);
    expect(await ask(REQUEST)).toEqual([]);
    expect(lines).toEqual([
      "memory recall: the control plane is unreachable (ECONNREFUSED); prompts go on without recalled memories",
    ]);
  });

  it("returns nothing on an error status, and logs a changed failure again", async () => {
    const { fetch } = plane([
      { status: 500, body: "boom" },
      { status: 500, body: "boom" },
      ok(),
      { status: 500, body: "boom" },
    ]);
    const { ask, lines } = recall(fetch);
    expect(await ask(REQUEST)).toEqual([]);
    expect(await ask(REQUEST)).toEqual([]);
    expect(await ask(REQUEST)).toHaveLength(2);
    expect(await ask(REQUEST)).toEqual([]);
    expect(lines).toEqual([
      "memory recall: the control plane answered 500; prompts go on without recalled memories",
      "memory recall: the control plane answered 500; prompts go on without recalled memories",
    ]);
  });

  it("returns nothing when the answer is not a list of memories", async () => {
    const { fetch } = plane([
      { status: 200, body: "<html>" },
      { status: 200, body: JSON.stringify({ items: [{ id: "" }] }) },
    ]);
    const { ask, lines } = recall(fetch);
    expect(await ask(REQUEST)).toEqual([]);
    expect(await ask(REQUEST)).toEqual([]);
    expect(lines).toEqual([
      "memory recall: the control plane's answer is not JSON; prompts go on without recalled memories",
      "memory recall: the control plane's answer is not a list of memories; prompts go on without recalled memories",
    ]);
  });

  it("reads an answer that carries fields this collector does not know", async () => {
    const { fetch } = plane([
      ok([{ ...ITEMS[0], rank_reason: "matched the prompt" }]),
    ]);
    expect(await recall(fetch).ask(REQUEST)).toEqual([
      { id: "a-intel.memory.pnpm", statement: "Use pnpm." },
    ]);
  });

  it("logs a missing route once and stops asking for fifteen minutes", async () => {
    const { fetch, calls } = plane([
      { status: 404, body: "not found" },
      { status: 404, body: "not found" },
      ok(),
    ]);
    const { ask, lines, advance } = recall(fetch);
    expect(await ask(REQUEST)).toEqual([]);
    advance(14 * 60_000);
    expect(await ask(REQUEST)).toEqual([]);
    expect(calls).toHaveLength(1);
    advance(60_000);
    expect(await ask(REQUEST)).toEqual([]);
    expect(calls).toHaveLength(2);
    advance(15 * 60_000);
    expect(await ask(REQUEST)).toHaveLength(2);
    expect(lines).toEqual([
      `memory recall: the control plane has no ${MEMORY_RECALL_PATH} route yet; prompts go on without recalled memories, and the daemon asks again every 15 minutes`,
    ]);
  });
});
