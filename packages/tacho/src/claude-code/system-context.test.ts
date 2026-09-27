/**
 * The system context and the token sources the recorder adds to a model call
 * (#4493): the parts a request resolves to, which digests hold from call to
 * call, and when a turn lists its parts. Each test builds the proxy's
 * exchange body the way `model-proxy.ts` does and hands the tracker its own
 * memory, so no test reads another's requests.
 */
import { budgetTokens } from "@contextgraphprotocol/typescript-sdk";
import { describe, expect, it } from "vitest";
import {
  type PrefixFold,
  RequestPrefixMemory,
} from "../collector/request-prefix";
import { digestBytes, type JsonValue, jcs } from "../digest";
import { SYSTEM_CONTEXT_PARTS_MAX } from "../envelope";
import { type DraftContent, jsonContent } from "../evidence/frame-body";
import {
  REQUEST_FULL_DIGEST_ATTR,
  resolveRequest,
  SYSTEM_CONTEXT_PARTS_OMITTED_ATTR,
  SystemContextMemory,
  SystemContextTracker,
  steeringParts,
  systemContextDigest,
  toolProvider,
} from "./system-context";

const PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude. Answer the " +
  "question the operator asked, read the files it names, then stop.";
const STYLE = "Keep answers short and name the file each claim comes from.";

const READ = {
  name: "Read",
  description: "Read a file from the local filesystem.",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  },
};

const SEARCH = {
  name: "mcp__oxagen__search",
  description: "Search the workspace graph.",
  input_schema: { type: "object", properties: { query: { type: "string" } } },
};

const ASKED = { role: "user", content: "What does recorder.ts do?" };
const ANSWERED = { role: "assistant", content: "It seals the frames." };
const FOLLOWED = { role: "user", content: "And hooks.ts?" };

type Request = Record<string, JsonValue>;

/** An Anthropic Messages request as Claude Code sends it. */
function request(over: Request = {}): Request {
  return {
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system: [
      { type: "text", text: PROMPT },
      { type: "text", text: STYLE, cache_control: { type: "ephemeral" } },
    ],
    tools: [READ, SEARCH],
    messages: [ASKED],
    ...over,
  };
}

/** The proxy's exchange body for a request it stored as `text`. */
function stored(text: string): DraftContent {
  return jsonContent(jcs({ request: text, response: '{"type":"message"}' }));
}

function exchange(body: Request): DraftContent {
  return stored(JSON.stringify(body));
}

function tracker(memory = new SystemContextMemory()): SystemContextTracker {
  return new SystemContextTracker(undefined, memory);
}

/** Measure one call and commit it, as the recorder does once it seals. */
function measured(
  on: SystemContextTracker,
  content: DraftContent | undefined,
  turn = "turn:1",
  attrs: Record<string, string> = {},
) {
  const measure = on.measure(content, attrs, turn);
  measure.commit();
  return measure;
}

const MANIFEST = {
  items: [
    {
      id: "no-force-push",
      kind: "record",
      force: "must",
      recorded_at: "2026-09-20T00:00:00.000Z",
      tokens: 40,
      outcome: "included",
    },
    {
      id: "prefer-rg",
      kind: "record",
      force: "should",
      recorded_at: "2026-09-21T00:00:00.000Z",
      tokens: 25,
      outcome: "included",
    },
    {
      id: "old-style-guide",
      kind: "record",
      force: "should",
      recorded_at: "2026-09-01T00:00:00.000Z",
      tokens: 900,
      outcome: "cut",
    },
  ],
};

describe("the parts a request resolves to", () => {
  it("lists each system block and each tool with its provider, in request order", () => {
    const { facts, attrs } = measured(tracker(), exchange(request()));
    const parts = facts.system_context_parts ?? [];
    expect(parts.map((part) => [part.kind, part.name, part.provider])).toEqual(
      [
        ["system", "system[0]", undefined],
        ["system", "system[1]", undefined],
        ["tool", "Read", "builtin"],
        ["tool", "mcp__oxagen__search", "oxagen"],
      ],
    );
    expect(parts[0]?.tokens).toBe(budgetTokens(PROMPT));
    expect(parts[1]?.tokens).toBe(budgetTokens(STYLE));
    expect(parts[2]?.tokens).toBe(budgetTokens(jcs(READ)));
    expect(facts.tool_definition_tokens).toBe(
      budgetTokens(jcs(READ)) + budgetTokens(jcs(SEARCH)),
    );
    expect(facts.tool_definition_tokens_basis).toBe("estimated");
    expect(facts.system_context_digest).toBe(systemContextDigest(parts));
    expect(attrs).toEqual({});
  });

  it("leaves the context frame and steering sources absent when nothing measured them", () => {
    const { facts } = measured(tracker(), exchange(request()));
    expect(facts).not.toHaveProperty("context_frame_tokens");
    expect(facts).not.toHaveProperty("context_frame_tokens_basis");
    expect(facts).not.toHaveProperty("steering_tokens");
    expect(facts).not.toHaveProperty("steering_tokens_basis");
  });

  it("carries ids, digests, and counts, never the text", () => {
    const { facts } = measured(tracker(), exchange(request()));
    const text = JSON.stringify(facts);
    for (const phrase of [PROMPT, STYLE, READ.description, SEARCH.description])
      expect(text).not.toContain(phrase);
  });

  it("gives two calls with the same system context the same digests", () => {
    const first = measured(tracker(), exchange(request()), "turn:1");
    const second = measured(
      tracker(),
      exchange(request({ messages: [FOLLOWED] })),
      "turn:2",
    );
    expect(second.facts.system_context_digest).toBe(
      first.facts.system_context_digest,
    );
    expect(second.facts.system_context_parts).toEqual(
      first.facts.system_context_parts,
    );
  });

  it("changes only the changed tool's digest and the whole-context digest", () => {
    const before = measured(tracker(), exchange(request())).facts;
    const edited = { ...SEARCH, description: "Search the graph by name." };
    const after = measured(
      tracker(),
      exchange(request({ tools: [READ, edited] })),
    ).facts;
    const was = before.system_context_parts ?? [];
    const now = after.system_context_parts ?? [];
    expect(now.map((part) => part.name)).toEqual(was.map((part) => part.name));
    const changed = now
      .filter((part, index) => part.digest !== was[index]?.digest)
      .map((part) => part.name);
    expect(changed).toEqual(["mcp__oxagen__search"]);
    expect(after.system_context_digest).not.toBe(before.system_context_digest);
  });

  it("reads a moved cache breakpoint as the same parts", () => {
    const breakpoint = { type: "ephemeral" };
    const moved = measured(
      tracker(),
      exchange(
        request({
          system: [
            { type: "text", text: PROMPT, cache_control: breakpoint },
            { type: "text", text: STYLE },
          ],
          tools: [READ, { ...SEARCH, cache_control: breakpoint }],
        }),
      ),
    ).facts;
    const plain = measured(tracker(), exchange(request())).facts;
    expect(moved.system_context_parts).toEqual(plain.system_context_parts);
    expect(moved.system_context_digest).toBe(plain.system_context_digest);
  });

  it("reads a system prompt sent as one string as one part", () => {
    const { facts } = measured(
      tracker(),
      exchange(request({ system: PROMPT, tools: [] })),
    );
    expect(facts.system_context_parts).toEqual([
      expect.objectContaining({
        kind: "system",
        name: "system",
        tokens: budgetTokens(PROMPT),
      }),
    ]);
    expect(facts.tool_definition_tokens).toBe(0);
  });

  it("names a chat request's leading instructions and its function tools", () => {
    const { facts } = measured(
      tracker(),
      exchange({
        model: "gpt-5",
        messages: [
          { role: "system", content: "You are a careful reviewer." },
          { role: "developer", content: "Reply in JSON." },
          { role: "user", content: "Review this diff." },
          { role: "system", content: "A later system message is dialogue." },
        ],
        tools: [
          {
            type: "function",
            function: { name: "get_diff", parameters: { type: "object" } },
          },
        ],
      }),
    );
    const parts = facts.system_context_parts ?? [];
    expect(parts.map((part) => [part.kind, part.name, part.provider])).toEqual(
      [
        ["system", "messages[0]", undefined],
        ["system", "messages[1]", undefined],
        ["tool", "get_diff", "builtin"],
      ],
    );
    expect(parts[0]?.tokens).toBe(budgetTokens("You are a careful reviewer."));
  });

  it("names a Responses request's instructions and a hosted tool by its type", () => {
    const { facts } = measured(
      tracker(),
      exchange({
        model: "gpt-5",
        instructions: "Answer briefly.",
        input: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search" }, { parameters: {} }],
      }),
    );
    const parts = facts.system_context_parts ?? [];
    expect(parts.map((part) => [part.kind, part.name])).toEqual([
      ["system", "instructions"],
      ["tool", "web_search"],
      ["tool", "tools[1]"],
    ]);
  });

  it("measures nothing from a body that is not a JSON exchange", () => {
    const on = tracker();
    for (const content of [
      { content_type: "text/plain", bytes: new TextEncoder().encode("{}") },
      jsonContent("not json"),
      jsonContent("[]"),
      jsonContent(jcs({ response: "{}" })),
      stored("not json"),
      stored("[1, 2]"),
    ])
      expect(measured(on, content).facts).toEqual({});
    expect(measured(on, undefined).facts).toEqual({});
  });
});

describe("a request the proxy stored with its prefix cut", () => {
  const firstText = JSON.stringify(request());
  const secondText = JSON.stringify(
    request({ messages: [ASKED, ANSWERED, FOLLOWED] }),
  );
  const thirdText = JSON.stringify(
    request({
      messages: [ASKED, ANSWERED, FOLLOWED, ANSWERED, FOLLOWED],
    }),
  );

  /** Measure a folded request with the attr the proxy sets beside it. */
  const proxied = (on: SystemContextTracker, fold: PrefixFold, turn: string) =>
    measured(on, stored(fold.text), turn, {
      [REQUEST_FULL_DIGEST_ATTR]: fold.fullDigest,
    });

  it("resolves each cut request to the parts of the call it names", () => {
    const prefix = new RequestPrefixMemory();
    const on = tracker();
    const first = prefix.fold("s", firstText);
    expect(first.prior).toBeUndefined();
    const a = proxied(on, first, "turn:1");

    const second = prefix.fold("s", secondText);
    expect(second.prior?.fields).toEqual(["system", "tools"]);
    const b = proxied(on, second, "turn:2");

    const third = prefix.fold("s", thirdText);
    expect(third.prior?.unchanged_from).toBe(second.fullDigest);
    const c = proxied(on, third, "turn:3");

    for (const later of [b, c]) {
      expect(later.facts.system_context_digest).toBe(
        a.facts.system_context_digest,
      );
      expect(later.facts.system_context_parts).toEqual(
        a.facts.system_context_parts,
      );
      expect(later.facts.tool_definition_tokens).toBe(
        a.facts.tool_definition_tokens,
      );
    }
  });

  it("remembers a request stored whole under the digest of its own text", () => {
    const prefix = new RequestPrefixMemory();
    const on = tracker();
    const first = prefix.fold("s", firstText);
    const a = measured(on, stored(first.text), "turn:1");
    expect(first.fullDigest).toBe(digestBytes(firstText));

    const second = prefix.fold("s", secondText);
    const b = proxied(on, second, "turn:2");
    expect(b.facts.system_context_digest).toBe(a.facts.system_context_digest);
  });

  it("measures no system context for a cut request whose earlier call it never saw", () => {
    const prefix = new RequestPrefixMemory();
    prefix.fold("s", firstText);
    const second = prefix.fold("s", secondText);
    const { facts, attrs } = proxied(tracker(), second, "turn:1");
    expect(facts).toEqual({});
    expect(attrs).toEqual({});
  });

  it("resolves nothing from a malformed cut marker", () => {
    const memory = new SystemContextMemory();
    for (const marker of [
      "not an object",
      { unchanged_from: "sha256:nope", messages: 0, fields: [] },
      { unchanged_from: digestBytes("x"), messages: -1, fields: [] },
      { unchanged_from: digestBytes("x"), messages: 1.5, fields: [] },
      { unchanged_from: digestBytes("x"), messages: 0, fields: "system" },
    ])
      expect(
        resolveRequest({ ...request(), $oxagen_prior: marker }, memory),
      ).toBeUndefined();
  });

  it("keeps a chat request's leading instructions when the cut took them", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_diff",
          description: "Read the diff of the pull request under review.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ];
    const lead = {
      role: "system",
      content: "You are a careful reviewer. Name each file you read.",
    };
    const ask = { role: "user", content: "Review this diff, please." };
    const prefix = new RequestPrefixMemory();
    const on = tracker();
    const first = prefix.fold(
      "s",
      JSON.stringify({ model: "gpt-5", messages: [lead, ask], tools }),
    );
    const a = proxied(on, first, "turn:1");
    const second = prefix.fold(
      "s",
      JSON.stringify({
        model: "gpt-5",
        messages: [lead, ask, ANSWERED, FOLLOWED],
        tools,
      }),
    );
    expect(second.prior?.messages).toBe(2);
    const b = proxied(on, second, "turn:2");
    expect(b.facts.system_context_parts).toEqual(a.facts.system_context_parts);
    expect(b.facts.system_context_parts?.[0]?.name).toBe("messages[0]");
  });
});

describe("when a turn lists its parts", () => {
  it("lists the parts on a turn's first call and the digest alone after it", () => {
    const on = tracker();
    const first = measured(on, exchange(request()), "turn:1");
    const again = measured(on, exchange(request()), "turn:1");
    expect(first.facts.system_context_parts).toHaveLength(4);
    expect(again.facts.system_context_parts).toBeUndefined();
    expect(again.facts.system_context_digest).toBe(
      first.facts.system_context_digest,
    );
    expect(again.facts.tool_definition_tokens).toBe(
      first.facts.tool_definition_tokens,
    );
  });

  it("lists a context the turn has not listed, and lists again in the next turn", () => {
    const on = tracker();
    measured(on, exchange(request()), "turn:1");
    const fewer = measured(on, exchange(request({ tools: [READ] })), "turn:1");
    expect(fewer.facts.system_context_parts).toHaveLength(3);
    const back = measured(on, exchange(request()), "turn:1");
    expect(back.facts.system_context_parts).toBeUndefined();
    const next = measured(on, exchange(request()), "turn:2");
    expect(next.facts.system_context_parts).toHaveLength(4);
  });

  it("lists again when the frame that listed never sealed", () => {
    const on = tracker();
    on.measure(exchange(request()), {}, "turn:1");
    const retry = measured(on, exchange(request()), "turn:1");
    expect(retry.facts.system_context_parts).toHaveLength(4);
  });

  it("forgets the oldest listed context once a turn has listed sixteen more", () => {
    const on = tracker();
    measured(on, exchange(request()), "turn:1");
    for (let index = 0; index < 16; index += 1) {
      const variant = { ...SEARCH, description: `Variant ${index}.` };
      measured(on, exchange(request({ tools: [READ, variant] })), "turn:1");
    }
    const again = measured(on, exchange(request()), "turn:1");
    expect(again.facts.system_context_parts).toHaveLength(4);
  });

  it("lists no parts past the frame's limit, says so, and still counts", () => {
    const tools = Array.from({ length: SYSTEM_CONTEXT_PARTS_MAX }, (_, i) => ({
      name: `tool_${i}`,
    }));
    const { facts, attrs } = measured(tracker(), exchange(request({ tools })));
    expect(facts.system_context_parts).toBeUndefined();
    expect(attrs).toEqual({ [SYSTEM_CONTEXT_PARTS_OMITTED_ATTR]: "too_many" });
    expect(facts.system_context_digest).toMatch(/^sha256:/);
    expect(facts.tool_definition_tokens).toBeGreaterThan(0);
  });
});

describe("the steering a session was delivered", () => {
  it("sums the included items of the latest steering manifest", () => {
    const on = tracker();
    on.noteSteeringManifest(MANIFEST);
    const { facts } = measured(on, exchange(request()));
    expect(facts.steering_tokens).toBe(65);
    expect(facts.steering_tokens_basis).toBe("estimated");
    const steering = (facts.system_context_parts ?? []).filter(
      (part) => part.kind === "steering",
    );
    expect(steering.map((part) => [part.name, part.tokens])).toEqual([
      ["no-force-push", 40],
      ["prefer-rg", 25],
    ]);
  });

  it("counts steering on a call whose request it could not read", () => {
    const on = tracker();
    on.noteSteeringManifest(MANIFEST);
    expect(measured(on, undefined).facts).toEqual({
      steering_tokens: 65,
      steering_tokens_basis: "estimated",
    });
  });

  it("reads a manifest that included nothing as zero steering, not absent", () => {
    const on = tracker();
    on.noteSteeringManifest({ items: [MANIFEST.items[2]] });
    expect(measured(on, undefined).facts.steering_tokens).toBe(0);
  });

  it("keeps the steering it had when a manifest names no items", () => {
    const on = tracker();
    on.noteSteeringManifest(MANIFEST);
    on.noteSteeringManifest({ bundle_version: "v2" });
    expect(measured(on, undefined).facts.steering_tokens).toBe(65);
  });

  it("changes the whole-context digest when the steering changes", () => {
    const all = tracker();
    all.noteSteeringManifest(MANIFEST);
    const one = tracker();
    one.noteSteeringManifest({ items: [MANIFEST.items[0]] });
    const a = measured(all, exchange(request())).facts;
    const b = measured(one, exchange(request())).facts;
    expect(a.system_context_digest).not.toBe(b.system_context_digest);
    expect(a.tool_definition_tokens).toBe(b.tool_definition_tokens);
  });

  it("skips an item with no id or no token count", () => {
    const parts = steeringParts({
      items: [
        "not an item",
        { outcome: "included", tokens: 5 },
        { id: "no-count", outcome: "included" },
        { id: "counted", outcome: "included", tokens: 3 },
      ],
    });
    expect(parts?.map((part) => part.name)).toEqual(["counted"]);
    expect(steeringParts({})).toBeUndefined();
  });
});

describe("toolProvider", () => {
  it.each([
    ["Read", "builtin"],
    ["mcp__oxagen__search", "oxagen"],
    ["mcp__claude_ai_Linear__list_issues", "claude_ai_Linear"],
    ["mcp__plugin_engineering_datadog__query", "plugin_engineering_datadog"],
    ["mcp__oxagen", "builtin"],
  ])("reads %s as served by %s", (name, provider) => {
    expect(toolProvider(name)).toBe(provider);
  });
});

describe("SystemContextMemory", () => {
  it("forgets the least recently used request past its capacity", () => {
    const memory = new SystemContextMemory(2);
    const context = { system: [], instructions: [], leading: [], tools: [] };
    const a = digestBytes("a");
    const b = digestBytes("b");
    const c = digestBytes("c");
    memory.set(a, context);
    memory.set(b, context);
    expect(memory.get(a)).toBe(context);
    memory.set(c, context);
    expect(memory.get(b)).toBeUndefined();
    expect(memory.get(a)).toBe(context);
    expect(memory.get(c)).toBe(context);
  });
});

describe("the tracker's state", () => {
  it("carries the steering and the turn's listed contexts over a restart", () => {
    const memory = new SystemContextMemory();
    const before = tracker(memory);
    before.noteSteeringManifest(MANIFEST);
    const first = measured(before, exchange(request()), "turn:1");
    const after = new SystemContextTracker(before.state(), memory);
    const again = measured(after, exchange(request()), "turn:1");
    expect(again.facts.system_context_parts).toBeUndefined();
    expect(again.facts.steering_tokens).toBe(65);
    expect(again.facts.system_context_digest).toBe(
      first.facts.system_context_digest,
    );
  });

  it("writes no state before it has anything to carry", () => {
    expect(tracker().state()).toEqual({});
  });
});
