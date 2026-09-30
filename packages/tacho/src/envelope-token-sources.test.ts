/**
 * The token source members of an `llm_call` body (#4493): what ingest
 * accepts (`tachoEventWireSchema` is `tachoEventSchema`), and how the members
 * flatten to `tacho_events` columns. A frame from a recorder that predates
 * them parses and flattens as before, with no value for any of them, and
 * ClickHouse stores a missing `Nullable` column as null.
 */
import { describe, expect, it } from "vitest";
import { flattenEvent } from "./columns";
import {
  type BodyOf,
  parseTachoEvent,
  SYSTEM_CONTEXT_PARTS_MAX,
  type TachoEvent,
  TOKEN_SOURCE_COUNTS,
} from "./envelope";
import { minimalSession, sealAll, unsealed } from "./test-helpers";
import { tachoEventWireSchema } from "./wire";

const DIGEST = `sha256:${"b".repeat(64)}`;

const MEMBERS = [
  "tool_definition_tokens",
  "tool_definition_tokens_basis",
  "context_frame_tokens",
  "context_frame_tokens_basis",
  "steering_tokens",
  "steering_tokens_basis",
  "system_context_digest",
  "system_context_parts",
] as const;

const PARTS = [
  { kind: "system", name: "system", digest: DIGEST, tokens: 5_200 },
  {
    kind: "tool",
    name: "mcp__oxagen__search",
    provider: "oxagen",
    digest: DIGEST,
    tokens: 310,
  },
  { kind: "steering", name: "no-force-push", digest: DIGEST, tokens: 40 },
];

const MEASURED = {
  tool_definition_tokens: 12_400,
  tool_definition_tokens_basis: "estimated",
  steering_tokens: 40,
  steering_tokens_basis: "estimated",
  system_context_digest: DIGEST,
  system_context_parts: PARTS,
};

/** One sealed `llm_call` frame with `extra` in its body. */
function llmCall(extra: Record<string, unknown>): TachoEvent {
  const body = {
    model: "claude-opus-4-5",
    input_tokens: 10,
    output_tokens: 5,
    ...extra,
  } as BodyOf<"llm_call">;
  const [event] = sealAll([
    unsealed("llm_call", body, { source: "collector", fidelity: "proxy" }),
  ]);
  if (event === undefined) throw new Error("nothing sealed");
  return event;
}

/** The frame as it crosses the wire. */
function wire(event: TachoEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
}

describe("the token source members at ingest", () => {
  it("accepts the three sources, their bases, and the part list", () => {
    const parsed = parseTachoEvent(wire(llmCall(MEASURED)));
    expect(parsed.body).toMatchObject(MEASURED);
  });

  it("accepts a count the harness reported and a measured zero", () => {
    const parsed = parseTachoEvent(
      wire(
        llmCall({
          context_frame_tokens: 0,
          context_frame_tokens_basis: "reported",
        }),
      ),
    );
    expect(parsed.body).toMatchObject({
      context_frame_tokens: 0,
      context_frame_tokens_basis: "reported",
    });
  });

  it("refuses a body that carries text, an unknown basis, or too many parts", () => {
    const base = wire(llmCall({}));
    const first = PARTS[0];
    for (const bad of [
      { tool_definition_tokens_basis: "guessed" },
      { steering_tokens: -1 },
      { context_frame_tokens: 1.5 },
      { system_context_digest: "sha256:short" },
      { system_context_parts: [{ ...first, text: "You are Claude Code." }] },
      { system_context_parts: [{ ...first, kind: "memory" }] },
      {
        system_context_parts: Array.from(
          { length: SYSTEM_CONTEXT_PARTS_MAX + 1 },
          () => first,
        ),
      },
    ]) {
      const body = { ...(base["body"] as Record<string, unknown>), ...bad };
      expect(() => parseTachoEvent({ ...base, body })).toThrow();
    }
  });

  // #4508 item 5. A count with no basis cannot say whether it was reported
  // or estimated, and a basis with no count names nothing.
  it("refuses a count without its basis and a basis without its count, for each source", () => {
    const base = wire(llmCall({}));
    const baseBody = base["body"] as Record<string, unknown>;
    for (const count of TOKEN_SOURCE_COUNTS) {
      const basis = `${count}_basis`;
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ [count]: 120 }, basis],
        [{ [basis]: "estimated" }, count],
      ];
      for (const [bad, missing] of cases) {
        const event = { ...base, body: { ...baseBody, ...bad } };
        const parsed = tachoEventWireSchema.safeParse(event);
        expect(parsed.success).toBe(false);
        const paths = parsed.error?.issues.map((issue) => issue.path.join("."));
        expect(paths).toEqual([`body.${missing}`]);
        expect(() => parseTachoEvent(event)).toThrow();
      }
      // Both together, and neither, still parse.
      const paired = {
        ...base,
        body: { ...baseBody, [count]: 120, [basis]: "reported" },
      };
      expect(tachoEventWireSchema.safeParse(paired).success).toBe(true);
    }
    expect(tachoEventWireSchema.safeParse(base).success).toBe(true);
  });

  it("holds the pair on every kind whose body carries the sources, and on no other", () => {
    const [error, manifest] = sealAll([
      unsealed("error", { model: "claude-opus-4-5" }),
      unsealed("steering.manifest", { items: [] }),
    ]);
    const unpaired = { steering_tokens: 40 };
    const refuse = wire(error!);
    expect(
      tachoEventWireSchema.safeParse({
        ...refuse,
        body: { ...(refuse["body"] as Record<string, unknown>), ...unpaired },
      }).success,
    ).toBe(false);
    // A steering manifest's body is opaque on the wire, and a member of that
    // name there is not a token source.
    const opaque = wire(manifest!);
    expect(
      tachoEventWireSchema.safeParse({
        ...opaque,
        body: { ...(opaque["body"] as Record<string, unknown>), ...unpaired },
      }).success,
    ).toBe(true);
  });

  it("parses a frame from a recorder that predates the members, as before", () => {
    const calls = minimalSession().filter((event) => event.kind === "llm_call");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const parsed = parseTachoEvent(wire(call));
      for (const member of MEMBERS) {
        expect(parsed.body).not.toHaveProperty(member);
      }
    }
  });
});

describe("the token source columns", () => {
  it("flattens the counts as numbers and the part list as JSON text", () => {
    const row = flattenEvent(llmCall(MEASURED));
    expect(row["tool_definition_tokens"]).toBe(12_400);
    expect(row["tool_definition_tokens_basis"]).toBe("estimated");
    expect(row["steering_tokens"]).toBe(40);
    expect(row["system_context_digest"]).toBe(DIGEST);
    expect(JSON.parse(String(row["system_context_parts"]))).toEqual(PARTS);
    // An unmeasured source sends no column, which the store reads as null.
    expect(row).not.toHaveProperty("context_frame_tokens");
    expect(row).not.toHaveProperty("context_frame_tokens_basis");
  });

  it("flattens a frame from an older recorder with none of the columns", () => {
    for (const event of minimalSession()) {
      const row = flattenEvent(event);
      for (const member of MEMBERS) expect(row).not.toHaveProperty(member);
    }
  });
});
