/**
 * Engram record kinds and Context Graph Protocol frame kinds are two
 * vocabularies for the same records, and this is the whole of the translation
 * between them.
 *
 * The mapping is stated once, in one table, and read in both directions —
 * `query` filters on CGP kinds and the store filters on engram kinds, so a
 * one-way table would have to be inverted by hand at the call site and would
 * drift the first time a kind was added.
 *
 * | engram       | CGP       | why |
 * |---|---|---|
 * | `episodic`   | `episode` | the same concept under two names |
 * | `semantic`   | `fact`    | a claim about the world, not about a moment |
 * | `procedural` | `memory`  | learned how-to; CGP has no procedural kind |
 * | `entity`     | `graph`   | a node, meaningful through its edges |
 * | `edge`       | `graph`   | an edge, likewise |
 *
 * `entity` and `edge` both landing on `graph` is why the reverse direction
 * returns a list rather than one kind: asking for `graph` frames must fetch
 * both. CGP's `snippet`, `symbol` and `doc` are not produced — engram holds no
 * file ranges or documents — and are absent from the declared capability
 * rather than returned empty.
 */
import type { FrameKind } from "@contextgraphprotocol/typescript-sdk";
import type { RecordKind } from "@oxagen/engram";

const RECORD_TO_FRAME: Readonly<Record<RecordKind, FrameKind>> = {
  episodic: "episode",
  semantic: "fact",
  procedural: "memory",
  entity: "graph",
  edge: "graph",
};

/** Every CGP kind this provider can serve, for the capability handshake. */
export const SERVED_FRAME_KINDS: readonly FrameKind[] = Object.freeze([
  ...new Set(Object.values(RECORD_TO_FRAME)),
]);

/** The CGP kind an engram record is served as. Total over `RecordKind`. */
export function frameKindOf(kind: RecordKind): FrameKind {
  return RECORD_TO_FRAME[kind];
}

/**
 * The engram kinds a CGP kind filter selects.
 *
 * An unserved or unknown CGP kind contributes nothing, so a query asking only
 * for `doc` selects no records rather than silently returning everything —
 * a filter that cannot be honoured must narrow, never widen.
 */
export function recordKindsFor(frameKinds: readonly FrameKind[]): RecordKind[] {
  const wanted = new Set<string>(frameKinds);
  return (Object.keys(RECORD_TO_FRAME) as RecordKind[]).filter((record) =>
    wanted.has(RECORD_TO_FRAME[record]),
  );
}
