/**
 * The reassembly a transcript half carries (spec §14).
 *
 * The fold itself happened at ingest (`@oxagen/run-ledger`'s
 * `content-blocks.ts`). This is the read side and it does three things,
 * none of which is folding:
 *
 *   1. Reads the stored fold beside the body, and folds the wire itself only
 *      when there is none to read — an older run, a deployment whose store
 *      had no assembly seam, or a fold this codebase has since improved.
 *   2. Clamps what the page carries. Text is clamped on a LINE boundary, so a
 *      cut never lands mid-word, and a tool call's long string fields are
 *      folded to their length. Both are measured on the message, never on the
 *      transport, which is the whole point: the old cut spent about six parts
 *      of its budget on JSON envelope and landed inside a token.
 *   3. Prices each block at the model's output rate and builds the step's one
 *      line, both pure.
 *
 * A half that carries an assembly carries no `text`. The list a run page
 * reads never holds the wire bytes at all; `get_run_frame_body` answers them
 * byte for byte when a person asks for the transport.
 */
import {
  TRANSCRIPT_FIELD_MAX,
  TRANSCRIPT_TEXT_MAX,
  type TranscriptAssembly,
  type TranscriptContentBlock,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import {
  assembleModelStream,
  type BlockJson,
  type ContentBlock,
  decodeAssembly,
  type MessageAssembly,
  type RunFrame,
  summarizeStep,
} from "@oxagen/run-ledger";

/**
 * Clamp on a line boundary, never inside a line and never inside a word.
 *
 * A message cut at a character index reads as a sentence the model never
 * wrote. Cutting at the last newline that fits leaves a message that is short
 * and true, and the reader is told how much was left.
 */
export function clampOnLine(text: string, max: number): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const newline = head.lastIndexOf("\n");
  if (newline > max / 4) return { text: head.slice(0, newline), truncated: true };
  const space = head.lastIndexOf(" ");
  return {
    text: space > max / 4 ? head.slice(0, space) : head,
    truncated: true,
  };
}

/**
 * A tool call's input with every long string folded to its length. A `Write`
 * call's content is the file; a page of steps carrying every one of them
 * would be the same mistake the wire was.
 */
export function foldLongFields(
  value: BlockJson,
  max: number,
): { value: BlockJson; folded: boolean } {
  let folded = false;
  const walk = (node: BlockJson): BlockJson => {
    if (typeof node === "string") {
      if (node.length <= max) return node;
      folded = true;
      return `…${node.length} characters`;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [key, walk(child)]),
      );
    }
    return node;
  };
  return { value: walk(value), folded };
}

/** Micro-USD as the cost record the contract carries. */
function costOf(micros: number | null): TranscriptContentBlock["cost"] {
  return micros === null
    ? null
    : { micros: String(micros), currency: "USD", basis: "client_attested" };
}

/**
 * The stored fold for this body, or the wire folded here when there is none.
 *
 * `getAssembly` answering null is not an error and never an empty transcript:
 * it means this frame predates the ingest-time fold, so the read pays for one
 * fold and the page reads exactly the same.
 */
export async function readAssembly(
  store: { getAssembly(scope: Scope, ref: string): Promise<Uint8Array | null> },
  scope: Scope,
  bodyRef: string,
  wire: string,
  frame: RunFrame,
): Promise<MessageAssembly | null> {
  const stored = await store.getAssembly(scope, bodyRef);
  if (stored !== null) {
    const decoded = decodeAssembly(stored);
    if (decoded !== null) return decoded;
  }
  return assembleModelStream(wire, {
    ttftMs: frame.timing.ttftMs,
    durationMs: frame.timing.durationMs,
  });
}

interface Scope {
  orgId: string;
  workspaceId: string;
}

/** One block as the contract carries it: clamped, folded and priced. */
function blockView(
  block: ContentBlock,
  costMicros: number | null,
): TranscriptContentBlock {
  const base = {
    id: block.id,
    chars: block.chars,
    tokens: block.tokens,
    partial: block.partial,
    cost: costOf(costMicros),
  };
  switch (block.kind) {
    case "text": {
      const clamped = clampOnLine(block.text, TRANSCRIPT_TEXT_MAX);
      return { ...base, kind: "text", ...clamped };
    }
    case "thinking": {
      const clamped = clampOnLine(block.text, TRANSCRIPT_TEXT_MAX);
      return { ...base, kind: "thinking", ...clamped, seconds: block.seconds };
    }
    case "tool_use": {
      const input = foldLongFields(block.input, TRANSCRIPT_FIELD_MAX);
      return {
        ...base,
        kind: "tool_use",
        name: block.name,
        input: input.value,
        inputRaw: block.inputRaw,
        inputFolded: input.folded,
        callKey: block.callKey,
        verdict: block.verdict,
      };
    }
    default:
      return {
        ...base,
        kind: "tool_result",
        forId: block.forId,
        ok: block.ok,
        summary: block.summary,
        bytes: block.bytes,
        ms: block.ms,
      };
  }
}

/**
 * The assembly as the contract carries it.
 *
 * `outputMicrosPerMillion` is the model's output rate from the price book,
 * null when the book prices no output for it. Every figure it cannot price is
 * left out rather than drawn as a zero.
 */
export function assemblyView(
  assembly: MessageAssembly,
  outputMicrosPerMillion: number | null,
): TranscriptAssembly {
  const summary = summarizeStep(
    assembly.blocks,
    assembly.usage,
    { ttftMs: assembly.ttftMs, durationMs: assembly.durationMs },
    outputMicrosPerMillion,
  );
  const costById = new Map(
    summary.blocks.map((figure) => [figure.id, figure.costMicros]),
  );
  return {
    blocks: assembly.blocks.map((block) =>
      blockView(block, costById.get(block.id) ?? null),
    ),
    precis: summary.precis,
    stopReason: assembly.stopReason,
    ttftMs: assembly.ttftMs,
    durationMs: assembly.durationMs,
    tokensPerSecond: summary.tokensPerSecond,
    usage: assembly.usage,
    partial: assembly.partial,
    wire: assembly.wire,
  };
}
