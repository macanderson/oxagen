/**
 * The memory recall (`memory-recall.ts`) against a fake control plane: the
 * request it makes, the memories it returns, and the empty answer every
 * failure turns into, the timeout among them.
 */
import { describe, expect, it } from "vitest";
import { digestBytes } from "../../digest";
import type { FetchLike } from "../../host/control-client";
import {
  createMemoryRecall,
  MEMORY_RECALL_DIGESTS_MAX,
  MEMORY_RECALL_PATH,
  MEMORY_RECALL_PATH_MAX_CHARS,
  MEMORY_RECALL_PATHS_MAX,
  MEMORY_RECALL_TEXT_MAX_CHARS,
  MEMORY_RECALL_TIMEOUT_MS,
  MEMORY_RECALL_TOOL_MAX_CHARS,
  MEMORY_RECALL_TOOLS_MAX,
  type MemoryRecallRequest,
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

const REMOTE = digestBytes("github.com/acme/widgets");
const FOLDED = digestBytes("github.com/acme/widgets.folded");

const REQUEST: MemoryRecallRequest = {
  repositoryDigests: [],
  tools: [],
  paths: [],
  text: "How do I install?",
};

/** The body of the one ask `request` made. */
async function sent(request: MemoryRecallRequest) {
  const { fetch, calls } = plane([ok()]);
  await recall(fetch).ask(request);
  return calls[0]?.body as {
    repository_digests: string[];
    tools: string[];
    paths: string[];
    text: string;
  };
}

describe("a recall", () => {
  it("posts the whole body with the host key", async () => {
    const { fetch, calls } = plane([ok()]);
    await recall(fetch).ask({
      repositoryDigests: [REMOTE, FOLDED],
      tools: ["Edit", "Bash"],
      paths: ["src/app.ts", "README.md"],
      text: "How do I install?",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `https://api.oxagen.test${MEMORY_RECALL_PATH}`,
      method: "POST",
      headers: {
        Authorization: "Bearer oxk_host",
        "Content-Type": "application/json",
      },
    });
    // The whole body, so a field the route no longer takes fails here.
    expect(calls[0]?.body).toEqual({
      host_enrollment_id: HOST_ENROLLMENT_ID,
      repository_digests: [REMOTE, FOLDED],
      tools: ["Edit", "Bash"],
      paths: ["src/app.ts", "README.md"],
      text: "How do I install?",
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("posts empty lists when the session has none", async () => {
    expect(await sent(REQUEST)).toEqual({
      host_enrollment_id: HOST_ENROLLMENT_ID,
      repository_digests: [],
      tools: [],
      paths: [],
      text: "How do I install?",
    });
  });

  it("sends each digest once, drops a non-digest, and keeps 8", async () => {
    const many = Array.from({ length: MEMORY_RECALL_DIGESTS_MAX + 3 }, (_, i) =>
      digestBytes(`remote-${i}`),
    );
    const body = await sent({
      ...REQUEST,
      repositoryDigests: [REMOTE, REMOTE, "github.com/acme/widgets", ...many],
    });
    expect(body.repository_digests).toEqual([
      REMOTE,
      ...many.slice(0, MEMORY_RECALL_DIGESTS_MAX - 1),
    ]);
  });

  it("keeps 64 tools, each once, and drops an empty or long one", async () => {
    const many = Array.from(
      { length: MEMORY_RECALL_TOOLS_MAX + 5 },
      (_, i) => `tool_${i}`,
    );
    const body = await sent({
      ...REQUEST,
      tools: [
        "Edit",
        "",
        "t".repeat(MEMORY_RECALL_TOOL_MAX_CHARS + 1),
        "Edit",
        "t".repeat(MEMORY_RECALL_TOOL_MAX_CHARS),
        ...many,
      ],
    });
    expect(body.tools).toHaveLength(MEMORY_RECALL_TOOLS_MAX);
    expect(body.tools.slice(0, 3)).toEqual([
      "Edit",
      "t".repeat(MEMORY_RECALL_TOOL_MAX_CHARS),
      "tool_0",
    ]);
    expect(body.tools.at(-1)).toBe(`tool_${MEMORY_RECALL_TOOLS_MAX - 3}`);
  });

  it("keeps 64 paths, each once, and drops an empty or long one", async () => {
    const many = Array.from(
      { length: MEMORY_RECALL_PATHS_MAX + 5 },
      (_, i) => `src/file-${i}.ts`,
    );
    const long = `src/${"p".repeat(MEMORY_RECALL_PATH_MAX_CHARS)}`;
    const body = await sent({
      ...REQUEST,
      paths: ["src/app.ts", "", long, "src/app.ts", ...many],
    });
    expect(body.paths).toHaveLength(MEMORY_RECALL_PATHS_MAX);
    expect(body.paths.slice(0, 2)).toEqual(["src/app.ts", "src/file-0.ts"]);
    expect(body.paths.at(-1)).toBe(
      `src/file-${MEMORY_RECALL_PATHS_MAX - 2}.ts`,
    );
    expect(body.paths).not.toContain(long);
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
      ...REQUEST,
      text: "x".repeat(MEMORY_RECALL_TEXT_MAX_CHARS + 50),
    });
    const body = calls[0]?.body as { text: string };
    expect(body.text).toHaveLength(MEMORY_RECALL_TEXT_MAX_CHARS);
  });

  it("never ends the cut prompt on half a surrogate pair", async () => {
    const { fetch, calls } = plane([ok()]);
    await recall(fetch).ask({
      ...REQUEST,
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

  it("waits 500 ms by default", () => {
    expect(MEMORY_RECALL_TIMEOUT_MS).toBe(500);
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
