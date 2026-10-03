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
  type RequestContext,
  resolveRequest,
  STEERING_ASSEMBLY_PART,
  SYSTEM_CONTEXT_PARTS_OMITTED_ATTR,
  SystemContextMemory,
  SystemContextTracker,
  steeringContext,
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

/**
 * The same manifest as the assembler writes it: its text spent 80 tokens,
 * 15 more than the two included items, on the header and the headings.
 */
const ASSEMBLED = {
  ...MANIFEST,
  spent_tokens: 80,
  text_digest: digestBytes("# Steering\n\n## Must\n..."),
};

/** An operator message the host delivered beside the assembled text. */
const STEER = {
  id: "stp_0192d4a8",
  kind: "steer",
  force: "must",
  recorded_at: "2026-09-26T00:00:00.000Z",
  tokens: 12,
  outcome: "included",
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

  it("names a Responses request's leading developer message from its input", () => {
    const { facts } = measured(
      tracker(),
      exchange({
        model: "gpt-5",
        input: [
          { role: "developer", content: "Reply in JSON." },
          { role: "user", content: "Review this diff." },
          { role: "developer", content: "A later message is dialogue." },
        ],
        tools: [{ type: "web_search" }],
      }),
    );
    const parts = facts.system_context_parts ?? [];
    expect(parts.map((part) => [part.kind, part.name])).toEqual([
      ["system", "input[0]"],
      ["tool", "web_search"],
    ]);
    expect(parts[0]?.tokens).toBe(budgetTokens("Reply in JSON."));
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

  /** Fold a call and remember it at once, as a call that lands before the next is sent. */
  const folded = (prefix: RequestPrefixMemory, key: string, text: string) => {
    const fold = prefix.fold(key, text);
    prefix.remember(key, fold);
    return fold;
  };

  it("resolves each cut request to the parts of the call it names", () => {
    const prefix = new RequestPrefixMemory();
    const on = tracker();
    const first = folded(prefix, "s", firstText);
    expect(first.prior).toBeUndefined();
    const a = proxied(on, first, "turn:1");

    const second = folded(prefix, "s", secondText);
    expect(second.prior?.fields).toEqual(["system", "tools"]);
    const b = proxied(on, second, "turn:2");

    const third = folded(prefix, "s", thirdText);
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
    const first = folded(prefix, "s", firstText);
    const a = measured(on, stored(first.text), "turn:1");
    expect(first.fullDigest).toBe(digestBytes(firstText));

    const second = folded(prefix, "s", secondText);
    const b = proxied(on, second, "turn:2");
    expect(b.facts.system_context_digest).toBe(a.facts.system_context_digest);
  });

  it("measures no system context for a cut request whose earlier call it never saw", () => {
    const prefix = new RequestPrefixMemory();
    folded(prefix, "s", firstText);
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
    const first = folded(
      prefix,
      "s",
      JSON.stringify({ model: "gpt-5", messages: [lead, ask], tools }),
    );
    const a = proxied(on, first, "turn:1");
    const second = folded(
      prefix,
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

  it("keeps a Responses request's leading developer message when the cut took it", () => {
    const lead = {
      role: "developer",
      content: "You are a careful reviewer. Name each file you read.",
    };
    const ask = { role: "user", content: "Review this diff, please." };
    const tools = [
      {
        type: "function",
        name: "get_diff",
        description: "Read the diff of the pull request under review.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ];
    const prefix = new RequestPrefixMemory();
    const on = tracker();
    const first = folded(
      prefix,
      "s",
      JSON.stringify({ model: "gpt-5", input: [lead, ask], tools }),
    );
    const a = proxied(on, first, "turn:1");
    const second = folded(
      prefix,
      "s",
      JSON.stringify({
        model: "gpt-5",
        input: [lead, ask, ANSWERED, FOLLOWED],
        tools,
      }),
    );
    expect(second.prior?.messages).toBe(2);
    const b = proxied(on, second, "turn:2");
    expect(b.facts.system_context_parts).toEqual(a.facts.system_context_parts);
    expect(b.facts.system_context_parts?.[0]?.name).toBe("input[0]");
  });
});

describe("a cut request resolves by the proxy's rule (#4348, #4508)", () => {
  /** Call `index` of one session: the first message names the session. */
  function turnOf(session: string, index: number): string {
    const messages: JsonValue[] = [
      { role: "user", content: `${session}: ${ASKED.content}` },
    ];
    for (let turn = 1; turn <= index; turn += 1) {
      messages.push({ role: "assistant", content: `answer ${turn}` });
      messages.push({ role: "user", content: `question ${turn}` });
    }
    return JSON.stringify(request({ messages }));
  }

  /**
   * The settle half of one proxied call, in the order `model-proxy.ts` runs
   * it: the context of the call the fold cut against goes back in the
   * memory, the frame is measured as it seals, and once the frame is on the
   * WAL the call is remembered with its own context.
   */
  function settle(
    prefix: RequestPrefixMemory<RequestContext>,
    memory: SystemContextMemory,
    on: SystemContextTracker,
    session: string,
    fold: PrefixFold<RequestContext>,
  ) {
    memory.restorePrior(fold);
    const measure = measured(on, stored(fold.text), "turn:1", {
      [REQUEST_FULL_DIGEST_ATTR]: fold.fullDigest,
    });
    prefix.remember(session, fold, memory.get(fold.fullDigest));
    return measure.facts;
  }

  /** The digest every call here resolves to: the request's own system and tools. */
  const expected = () => {
    const digest = measured(tracker(), exchange(request())).facts
      .system_context_digest;
    expect(digest).toMatch(/^sha256:/);
    return digest;
  };

  it("resolves every folded call when more than 256 sessions interleave", () => {
    const memory = new SystemContextMemory();
    const prefix = new RequestPrefixMemory<RequestContext>();
    const sessions = Array.from({ length: 300 }, (_, i) => `session-${i}`);
    const trackers = new Map(sessions.map((s) => [s, tracker(memory)]));
    const digest = expected();
    let cut = 0;
    for (let round = 0; round < 3; round += 1) {
      for (const session of sessions) {
        const fold = prefix.fold(session, turnOf(session, round));
        if (fold.prior !== undefined) cut += 1;
        const facts = settle(
          prefix,
          memory,
          trackers.get(session)!,
          session,
          fold,
        );
        expect(facts.system_context_digest).toBe(digest);
        expect(facts.tool_definition_tokens).toBeGreaterThan(0);
      }
    }
    // Every call after a session's first was stored with its prefix cut.
    expect(cut).toBe(sessions.length * 2);
  });

  it("loses folded calls under the same interleaving when the proxy puts no context back (negative)", () => {
    const memory = new SystemContextMemory();
    const prefix = new RequestPrefixMemory();
    const sessions = Array.from({ length: 300 }, (_, i) => `session-${i}`);
    const trackers = new Map(sessions.map((s) => [s, tracker(memory)]));
    let unresolved = 0;
    for (let round = 0; round < 3; round += 1) {
      for (const session of sessions) {
        const fold = prefix.fold(session, turnOf(session, round));
        const { facts } = measured(
          trackers.get(session)!,
          stored(fold.text),
          "turn:1",
          { [REQUEST_FULL_DIGEST_ATTR]: fold.fullDigest },
        );
        prefix.remember(session, fold);
        if (facts.system_context_digest === undefined) unresolved += 1;
      }
    }
    // The shared memory alone evicts a session's prior before its next call.
    expect(unresolved).toBeGreaterThan(0);
  });

  it("resolves two overlapping calls of one session whichever settles first", () => {
    const memory = new SystemContextMemory();
    const prefix = new RequestPrefixMemory<RequestContext>();
    const on = tracker(memory);
    const digest = expected();
    const first = prefix.fold("s", turnOf("s", 0));
    expect(settle(prefix, memory, on, "s", first).system_context_digest).toBe(
      digest,
    );
    // Both calls are forwarded before either answers.
    const a = prefix.fold("s", turnOf("s", 1));
    const b = prefix.fold("s", turnOf("s", 2));
    // Neither points at the other: both cut against the call that landed.
    expect(a.prior?.unchanged_from).toBe(first.fullDigest);
    expect(b.prior?.unchanged_from).toBe(first.fullDigest);
    // The second settles first.
    const later = settle(prefix, memory, on, "s", b);
    const earlier = settle(prefix, memory, on, "s", a);
    expect(later.system_context_digest).toBe(digest);
    expect(later.tool_definition_tokens).toBeGreaterThan(0);
    expect(earlier.system_context_digest).toBe(digest);
    expect(earlier.tool_definition_tokens).toBeGreaterThan(0);
  });

  it("loses the second call's context when a call is remembered as it is forwarded (negative)", () => {
    const memory = new SystemContextMemory();
    const prefix = new RequestPrefixMemory<RequestContext>();
    const on = tracker(memory);
    settle(prefix, memory, on, "s", prefix.fold("s", turnOf("s", 0)));
    // The order this rule replaced: A becomes the prior before its frame
    // seals, so B cuts against a call nothing has measured yet.
    const a = prefix.fold("s", turnOf("s", 1));
    prefix.remember("s", a);
    const b = prefix.fold("s", turnOf("s", 2));
    expect(b.prior?.unchanged_from).toBe(a.fullDigest);
    expect(settle(prefix, memory, on, "s", b)).toEqual({});
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

  it("counts no steering on a side call, whose request declares no tools", () => {
    const on = tracker();
    on.noteSteeringManifest(MANIFEST);
    const { tools: _tools, ...untooled } = request();
    const sides: Array<[string, Request]> = [
      ["turn:empty", request({ tools: [] })],
      ["turn:absent", untooled],
    ];
    for (const [turn, side] of sides) {
      const { facts } = measured(on, exchange(side), turn);
      expect(facts).not.toHaveProperty("steering_tokens");
      expect(facts).not.toHaveProperty("steering_tokens_basis");
      expect(facts.tool_definition_tokens).toBe(0);
      expect(facts.system_context_parts?.map((part) => part.kind)).toEqual([
        "system",
        "system",
      ]);
    }
    // The session's next main call still counts its steering.
    expect(measured(on, exchange(request())).facts.steering_tokens).toBe(65);
  });

  it("counts steering on a call whose request it could not read", () => {
    const on = tracker();
    on.noteSteeringManifest(MANIFEST);
    expect(measured(on, undefined).facts).toEqual({
      steering_tokens: 65,
      steering_tokens_basis: "estimated",
    });
  });

  it("counts steering alone for a call whose request it never saw", () => {
    const on = tracker();
    expect(on.measureUnseen()).toEqual({});
    on.noteSteeringManifest(MANIFEST);
    expect(on.measureUnseen()).toEqual({
      steering_tokens: 65,
      steering_tokens_basis: "estimated",
    });
    // Measuring an unseen call lists nothing, so the turn's next proxied
    // call still lists its parts.
    expect(on.state().listed).toBeUndefined();
    expect(
      measured(on, exchange(request())).facts.system_context_parts,
    ).toBeDefined();
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
    const steering = steeringContext({
      items: [
        "not an item",
        { outcome: "included", tokens: 5 },
        { id: "no-count", outcome: "included" },
        { id: "counted", outcome: "included", tokens: 3 },
      ],
    });
    expect(steering?.parts.map((part) => part.name)).toEqual(["counted"]);
    expect(steering?.tokens).toBe(3);
    expect(steeringContext({})).toBeUndefined();
  });

  it("counts the assembled text's spent tokens as one part, header and headings included", () => {
    const on = tracker();
    on.noteSteeringManifest(ASSEMBLED);
    const { facts } = measured(on, exchange(request()));
    expect(facts.steering_tokens).toBe(80);
    const steering = (facts.system_context_parts ?? []).filter(
      (part) => part.kind === "steering",
    );
    expect(steering.map((part) => [part.name, part.tokens])).toEqual([
      [STEERING_ASSEMBLY_PART, 80],
    ]);
    expect(steering[0]?.digest).toBe(ASSEMBLED.text_digest);
  });

  it("adds each steer the host delivered beside the assembled text", () => {
    const on = tracker();
    on.noteSteeringManifest({ ...ASSEMBLED, items: [...MANIFEST.items, STEER] });
    const { facts } = measured(on, exchange(request()));
    expect(facts.steering_tokens).toBe(92);
    const steering = (facts.system_context_parts ?? []).filter(
      (part) => part.kind === "steering",
    );
    expect(steering.map((part) => [part.name, part.tokens])).toEqual([
      [STEERING_ASSEMBLY_PART, 80],
      [STEER.id, 12],
    ]);
  });

  // #4508 item 4. The assembler can build the same text again under new
  // record ids and timestamps. The model reads the same bytes, so the
  // system context has not changed and its digest must not either.
  it("keeps the system context digest when the same text is assembled under a new id and time", () => {
    const again = {
      ...ASSEMBLED,
      items: MANIFEST.items.map((item, index) => ({
        ...item,
        id: `reissued-${index}`,
        recorded_at: "2026-09-29T12:00:00.000Z",
      })),
    };
    const first = tracker();
    first.noteSteeringManifest(ASSEMBLED);
    const second = tracker();
    second.noteSteeringManifest(again);
    const a = measured(first, exchange(request())).facts;
    const b = measured(second, exchange(request())).facts;
    expect(b.system_context_digest).toBe(a.system_context_digest);
    expect(b.system_context_parts).toEqual(a.system_context_parts);
    expect(b.steering_tokens).toBe(a.steering_tokens);
  });

  it("changes the digest when a delivered steer changes beside the same assembled text", () => {
    const base = tracker();
    base.noteSteeringManifest({
      ...ASSEMBLED,
      items: [...MANIFEST.items, STEER],
    });
    const other = tracker();
    other.noteSteeringManifest({
      ...ASSEMBLED,
      items: [...MANIFEST.items, { ...STEER, id: "stp_0192d4b9" }],
    });
    const a = measured(base, exchange(request())).facts;
    const b = measured(other, exchange(request())).facts;
    expect(b.system_context_digest).not.toBe(a.system_context_digest);
  });

  it("changes only the assembly part's digest when the header alone changes", () => {
    const before = tracker();
    before.noteSteeringManifest(ASSEMBLED);
    const after = tracker();
    after.noteSteeringManifest({
      ...ASSEMBLED,
      text_digest: digestBytes("# Steering records\n\n## Must\n..."),
    });
    const was = measured(before, exchange(request())).facts;
    const now = measured(after, exchange(request())).facts;
    const wasParts = was.system_context_parts ?? [];
    const changed = (now.system_context_parts ?? [])
      .filter((part, index) => part.digest !== wasParts[index]?.digest)
      .map((part) => part.name);
    expect(changed).toEqual([STEERING_ASSEMBLY_PART]);
    expect(now.system_context_digest).not.toBe(was.system_context_digest);
    expect(now.steering_tokens).toBe(was.steering_tokens);
  });

  it("counts the items alone when the manifest lacks a text digest or a spent count", () => {
    const { spent_tokens: _spent, ...unspent } = ASSEMBLED;
    for (const manifest of [{ ...ASSEMBLED, text_digest: null }, unspent]) {
      const steering = steeringContext(manifest);
      expect(steering?.tokens).toBe(65);
      expect(steering?.parts.map((part) => part.name)).toEqual([
        "no-force-push",
        "prefer-rg",
      ]);
    }
  });

  it("takes the spent count when the items' own counts add up to more", () => {
    const steering = steeringContext({ ...ASSEMBLED, spent_tokens: 50 });
    expect(steering?.tokens).toBe(50);
    expect(steering?.parts).toEqual([
      expect.objectContaining({ name: STEERING_ASSEMBLY_PART, tokens: 50 }),
    ]);
  });
});

/** Text an Oxagen hook answer handed the agent, such as a recall. */
const RECALL =
  "Memories Oxagen recalled for this prompt, most relevant first:\n" +
  "- Use pnpm, never npm.\n- Run the gate in CI.";
const MESSAGE = "Stop and read the brief before the next edit.";

const BEFORE = "2026-10-03T09:59:00.000Z";
const HANDED = "2026-10-03T10:00:00.000Z";
const LATER = "2026-10-03T10:05:00.000Z";
const AFTER = "2026-10-03T10:10:00.000Z";

describe("the context Oxagen's hooks handed the session (#5339)", () => {
  it("counts the handed text on a call it never saw, with an estimated basis", () => {
    const on = tracker();
    on.noteInjectedContext(RECALL, HANDED);
    expect(on.measureUnseen(AFTER)).toEqual({
      context_frame_tokens: budgetTokens(RECALL),
      context_frame_tokens_basis: "estimated",
    });
  });

  it("writes no count, never zero, when no hook handed the agent text", () => {
    const on = tracker();
    expect(on.measureUnseen(AFTER)).toEqual({});
    on.noteInjectedContext("", HANDED);
    expect(on.measureUnseen(AFTER)).toEqual({});
    expect(on.state()).toEqual({});
  });

  it("keeps the steering count beside the context count", () => {
    const on = tracker();
    on.noteSteeringManifest(MANIFEST);
    on.noteInjectedContext(RECALL, HANDED);
    expect(on.measureUnseen(AFTER)).toEqual({
      steering_tokens: 65,
      steering_tokens_basis: "estimated",
      context_frame_tokens: budgetTokens(RECALL),
      context_frame_tokens_basis: "estimated",
    });
  });

  it("counts every answer so far on each later call", () => {
    const on = tracker();
    on.noteInjectedContext(RECALL, HANDED);
    on.noteInjectedContext(MESSAGE, LATER);
    const total = budgetTokens(RECALL) + budgetTokens(MESSAGE);
    expect(on.measureUnseen(AFTER).context_frame_tokens).toBe(total);
    expect(on.measureUnseen(AFTER).context_frame_tokens).toBe(total);
  });

  it("gives a call the total as of when it was made", () => {
    const on = tracker();
    on.noteInjectedContext(RECALL, HANDED);
    on.noteInjectedContext(MESSAGE, LATER);
    // A record that arrives late for a call made before any answer.
    expect(on.measureUnseen(BEFORE)).toEqual({});
    // A call made at the first answer's time carries that answer alone.
    expect(on.measureUnseen(HANDED).context_frame_tokens).toBe(
      budgetTokens(RECALL),
    );
    // A call with no readable time takes the latest total.
    expect(on.measureUnseen(undefined).context_frame_tokens).toBe(
      budgetTokens(RECALL) + budgetTokens(MESSAGE),
    );
  });

  it("empties the total at a compaction and keeps it for calls made before", () => {
    const on = tracker();
    on.noteInjectedContext(RECALL, HANDED);
    on.clearInjectedContext(LATER);
    expect(on.measureUnseen(AFTER)).toEqual({});
    expect(on.measureUnseen(HANDED).context_frame_tokens).toBe(
      budgetTokens(RECALL),
    );
    on.noteInjectedContext(MESSAGE, AFTER);
    expect(on.measureUnseen(AFTER).context_frame_tokens).toBe(
      budgetTokens(MESSAGE),
    );
  });

  it("clears nothing on a session that was handed no text", () => {
    const on = tracker();
    on.clearInjectedContext(LATER);
    expect(on.state()).toEqual({});
  });

  it("keeps the last answers and reads the total before them for an older call", () => {
    const on = tracker();
    const step = budgetTokens(MESSAGE);
    for (let minute = 0; minute < 40; minute += 1)
      on.noteInjectedContext(
        MESSAGE,
        new Date(Date.parse(HANDED) + minute * 60_000).toISOString(),
      );
    const state = on.state();
    expect(state.injected).toHaveLength(32);
    // Eight answers fell off the front, so the floor is the eighth total.
    expect(state.injectedFloor).toBe(8 * step);
    expect(on.measureUnseen(BEFORE).context_frame_tokens).toBe(8 * step);
    // The eleventh answer left at 10:10, the same instant as the call, so
    // the call carries eleven.
    expect(on.measureUnseen(AFTER).context_frame_tokens).toBe(11 * step);
    expect(
      on.measureUnseen("2026-10-03T11:00:00.000Z").context_frame_tokens,
    ).toBe(40 * step);
  });

  it("adds the count to a proxied main call and to one it could not read", () => {
    const on = tracker();
    on.noteInjectedContext(RECALL, HANDED);
    const main = measured(on, exchange(request()), "turn:1", {});
    expect(main.facts.context_frame_tokens).toBe(budgetTokens(RECALL));
    expect(main.facts.context_frame_tokens_basis).toBe("estimated");
    expect(measured(on, undefined).facts).toEqual({
      context_frame_tokens: budgetTokens(RECALL),
      context_frame_tokens_basis: "estimated",
    });
  });

  it("adds no count to a proxied side call, whose request declares no tools", () => {
    const on = tracker();
    on.noteInjectedContext(RECALL, HANDED);
    const { facts } = measured(on, exchange(request({ tools: [] })));
    expect(facts).not.toHaveProperty("context_frame_tokens");
    expect(facts).not.toHaveProperty("context_frame_tokens_basis");
  });

  it("names no part for the handed text, so the system context digest holds", () => {
    const plain = tracker();
    const handed = tracker();
    handed.noteInjectedContext(RECALL, HANDED);
    const a = measured(plain, exchange(request())).facts;
    const b = measured(handed, exchange(request())).facts;
    expect(b.system_context_digest).toBe(a.system_context_digest);
    expect(b.system_context_parts).toEqual(a.system_context_parts);
  });

  it("carries the totals over a restart", () => {
    const before = tracker();
    before.noteInjectedContext(RECALL, HANDED);
    before.noteInjectedContext(MESSAGE, LATER);
    const after = new SystemContextTracker(before.state());
    expect(after.measureUnseen(AFTER)).toEqual(before.measureUnseen(AFTER));
    expect(after.measureUnseen(HANDED)).toEqual(before.measureUnseen(HANDED));
  });

  it("drops a malformed mark from a saved state", () => {
    const after = new SystemContextTracker({
      injected: [
        { at: HANDED, tokens: 12 },
        { at: LATER } as unknown as { at: string; tokens: number },
        "junk" as unknown as { at: string; tokens: number },
      ],
    });
    expect(after.measureUnseen(AFTER).context_frame_tokens).toBe(12);
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

  it("carries the steering count over a restart where the parts add up to more", () => {
    const before = tracker();
    before.noteSteeringManifest({ ...ASSEMBLED, spent_tokens: 50 });
    const state = before.state();
    expect(state.steeringTokens).toBe(50);
    const after = new SystemContextTracker(state);
    expect(measured(after, undefined).facts.steering_tokens).toBe(50);
  });

  it("sums the parts of a state saved before the count was carried", () => {
    const before = tracker();
    before.noteSteeringManifest(MANIFEST);
    const { steeringTokens: _count, ...older } = before.state();
    const after = new SystemContextTracker(older);
    expect(measured(after, undefined).facts.steering_tokens).toBe(65);
  });

  it("writes no state before it has anything to carry", () => {
    expect(tracker().state()).toEqual({});
  });
});
