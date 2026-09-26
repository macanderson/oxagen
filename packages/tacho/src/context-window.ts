/**
 * The context window of one model request, block by block (ADR-200).
 *
 * A window lists what the request carried in five blocks, each with its
 * bytes and its item count. The bytes are the UTF-8 length of each part's
 * JSON, measured on the request as it left for the vendor. No token is
 * counted here: a reader divides the prompt total the vendor reported across
 * the blocks by their bytes (`apportionWindowTokens`), so the blocks sum to
 * that total and nothing is tokenized locally.
 *
 * This is the leaf's copy of the vocabulary. The in-app assistant records
 * the same blocks on `model.engine_call_started` (`@oxagen/run-ledger`), and
 * the tacho model proxy records them on its `llm_call` frame as the
 * `oxagen.window` attribute. An attribute is part of the envelope, so it
 * survives `digest_only` retention, which drops the bodies.
 */

/** The blocks of a window, in the order a request carries them. */
export const CONTEXT_WINDOW_BLOCKS = [
  "system",
  "steering",
  "tools",
  "context",
  "conversation",
] as const;

export type ContextWindowBlockKind = (typeof CONTEXT_WINDOW_BLOCKS)[number];

/** One block of a window: what it held, in bytes and in items. */
export interface ContextWindowBlock {
  kind: ContextWindowBlockKind;
  /** The UTF-8 length of the block's parts, each serialized as JSON. */
  bytes: number;
  /** Messages, tools or text parts, by the block's kind. */
  items: number;
}

/** The `llm_call` attribute the model proxy writes the window into. */
export const CONTEXT_WINDOW_ATTR = "oxagen.window";

/**
 * The UTF-8 length of `value` as JSON; zero for a value JSON cannot hold.
 *
 * @internal Exported for its test.
 */
export function windowJsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
  } catch {
    return 0;
  }
}

/**
 * A block of `parts`: each part's JSON length summed, one item per part.
 *
 * @internal Exported for its test.
 */
export function windowBlockOf(
  kind: ContextWindowBlockKind,
  parts: readonly unknown[],
): ContextWindowBlock {
  let bytes = 0;
  for (const part of parts) bytes += windowJsonBytes(part);
  return { kind, bytes, items: parts.length };
}

/** The blocks in the canonical order, each kind at most once. */
function orderWindowBlocks(
  blocks: readonly ContextWindowBlock[],
): ContextWindowBlock[] {
  const byKind = new Map<ContextWindowBlockKind, ContextWindowBlock>();
  for (const block of blocks) byKind.set(block.kind, block);
  return CONTEXT_WINDOW_BLOCKS.flatMap((kind) => {
    const block = byKind.get(kind);
    return block === undefined ? [] : [block];
  });
}

/** Every byte the window measured. */
export function windowBytes(blocks: readonly ContextWindowBlock[]): number {
  let total = 0;
  for (const block of blocks) total += block.bytes;
  return total;
}

/**
 * The attribute value: `kind=bytes:items`, joined by `;`, in block order.
 * `system=1204:1;tools=9120:14;conversation=48211:37`.
 */
export function encodeWindowAttr(
  blocks: readonly ContextWindowBlock[],
): string {
  return orderWindowBlocks(blocks)
    .map((block) => `${block.kind}=${block.bytes}:${block.items}`)
    .join(";");
}

const BLOCK_PART = /^([a-z]+)=(\d{1,15}):(\d{1,9})$/;

/** Whether `kind` names one of the five blocks. */
function isWindowBlockKind(
  kind: string,
): kind is ContextWindowBlockKind {
  return (CONTEXT_WINDOW_BLOCKS as readonly string[]).includes(kind);
}

/**
 * The blocks an attribute value names, or null when it names none or any
 * part of it does not read. A window that half reads is not a window: the
 * shares of the blocks that did read would not sum to the vendor's total.
 */
export function decodeWindowAttr(
  value: string | undefined | null,
): ContextWindowBlock[] | null {
  if (value === undefined || value === null || value.length === 0) return null;
  const seen = new Set<string>();
  const blocks: ContextWindowBlock[] = [];
  for (const part of value.split(";")) {
    const match = BLOCK_PART.exec(part);
    if (match === null) return null;
    const [, kind, bytes, items] = match;
    if (
      kind === undefined ||
      bytes === undefined ||
      items === undefined ||
      !isWindowBlockKind(kind) ||
      seen.has(kind)
    )
      return null;
    seen.add(kind);
    blocks.push({
      kind,
      bytes: Number(bytes),
      items: Number(items),
    });
  }
  return orderWindowBlocks(blocks);
}

/**
 * Each block's tokens: its byte share of `total`, the prompt tokens the
 * vendor reported, by largest remainder. The shares sum to `total` exactly.
 * A remainder tie goes to the earlier block, so the same window always
 * splits the same way. A window with no bytes has no shares to give, and
 * every block gets zero.
 */
export function apportionWindowTokens(
  total: number,
  blocks: readonly ContextWindowBlock[],
): number[] {
  const bytes = BigInt(windowBytes(blocks));
  if (bytes === 0n || total <= 0) return blocks.map(() => 0);
  const whole = BigInt(Math.trunc(total));
  const shares = blocks.map((block) => {
    const scaled = whole * BigInt(block.bytes);
    return { floor: scaled / bytes, remainder: scaled % bytes };
  });
  let left = whole - shares.reduce((sum, share) => sum + share.floor, 0n);
  const order = shares
    .map((share, index) => ({ index, remainder: share.remainder }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  const tokens = shares.map((share) => share.floor);
  for (const { index } of order) {
    if (left === 0n) break;
    tokens[index] = (tokens[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return tokens.map(Number);
}

/** The vendor APIs whose request shape the proxy can measure. */
type WindowApi =
  | "anthropic.messages"
  | "openai.chat"
  | "openai.responses";

type Json = Record<string, unknown>;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

function isLeadingInstruction(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const role = (message as Json)["role"];
  return role === "system" || role === "developer";
}

/** The system, tools and conversation parts of one request body. */
function partsOf(
  api: WindowApi,
  body: Json,
): { system: unknown[]; tools: unknown[]; conversation: unknown[] } {
  const tools = asArray(body["tools"]);
  switch (api) {
    case "anthropic.messages": {
      const system = body["system"];
      return {
        system:
          system === undefined || system === null
            ? []
            : Array.isArray(system)
              ? system
              : [system],
        tools,
        conversation: asArray(body["messages"]),
      };
    }
    case "openai.chat": {
      const messages = asArray(body["messages"]);
      let lead = 0;
      while (lead < messages.length && isLeadingInstruction(messages[lead]))
        lead += 1;
      return {
        system: messages.slice(0, lead),
        tools,
        conversation: messages.slice(lead),
      };
    }
    case "openai.responses": {
      const instructions = body["instructions"];
      const input = body["input"];
      return {
        system:
          typeof instructions === "string" && instructions.length > 0
            ? [instructions]
            : [],
        tools,
        conversation:
          input === undefined || input === null
            ? []
            : Array.isArray(input)
              ? input
              : [input],
      };
    }
  }
}

/**
 * The window of a request the proxy is about to send, or null for an API it
 * does not parse or a body it could not read.
 *
 * `sent` is the body the vendor reads. When the proxy's `beforeForward`
 * changed it, `original` is the body as the harness sent it, and what the
 * change added to the system block is counted as steering. A harness's own
 * hook context rides its conversation, and the proxy cannot tell it apart,
 * so a proxied window has no `context` block and counts that text in
 * `conversation`.
 */
export function measureProviderRequest(
  api: string,
  sent: Json | undefined,
  original?: Json,
): ContextWindowBlock[] | null {
  if (
    sent === undefined ||
    (api !== "anthropic.messages" &&
      api !== "openai.chat" &&
      api !== "openai.responses")
  )
    return null;
  const parts = partsOf(api, sent);
  const system = windowBlockOf("system", parts.system);
  const blocks: ContextWindowBlock[] = [system];
  if (original !== undefined && original !== sent) {
    const before = windowBlockOf("system", partsOf(api, original).system);
    const added = Math.max(0, system.bytes - before.bytes);
    if (added > 0) {
      blocks[0] = { kind: "system", bytes: before.bytes, items: before.items };
      blocks.push({
        kind: "steering",
        bytes: added,
        items: Math.max(1, system.items - before.items),
      });
    }
  }
  blocks.push(windowBlockOf("tools", parts.tools));
  blocks.push(windowBlockOf("conversation", parts.conversation));
  const ordered = orderWindowBlocks(blocks);
  return windowBytes(ordered) === 0 ? null : ordered;
}
