/**
 * The context windows a run recorded, read from its model-call frames
 * (ADR-200), and the assembler's manifests beside them.
 *
 * The window is the record. The in-app assistant writes it on
 * `model.engine_call_started` as the payload's `window`, and the provider's
 * token counts arrive on the matching `model.engine_call_completed`, joined
 * on `model_call_id`. The tacho model proxy writes it on its `llm_call` frame
 * as the `oxagen.window` attribute, beside the usage the vendor reported.
 * Either way a block's tokens are its byte share of the prompt total the
 * vendor reported (`apportionWindowTokens`), so the blocks sum to that total
 * and nothing is tokenized here.
 *
 * A model call recorded with no window is counted as unmeasured and never
 * filled with a substitute.
 */
import {
  apportionWindowTokens,
  type ContextWindowBlock,
  type ContextWindowBlockKind,
  decodeWindowAttr,
  CONTEXT_WINDOW_ATTR,
  LLM_CALL_DUPLICATE_OF_ATTR,
  windowBytes,
} from "@oxagen/tacho";
import { contextWindowPayloadSchema } from "./event-payload-registry";
import type { AttemptEventReadRecord } from "./run-store";

/** One block of a recorded window, with its share of the vendor's total. */
export interface RecordedWindowBlock {
  kind: ContextWindowBlockKind;
  bytes: number;
  items: number;
  /** The block's byte share of `promptTokens`; null when the call reported no input. */
  tokens: number | null;
}

/** One model request's window, as the run recorded it. */
export interface RecordedWindow {
  /** The frame that recorded the request: the started frame, or the `llm_call`. */
  seq: string;
  /** The frame that recorded the answer; the same frame on a wrapped run, null when none arrived. */
  responseSeq: string | null;
  /** The call's id as the producer recorded it; null where it named none. */
  modelCallId: string | null;
  provider: string | null;
  /** The model that answered, else the model the host asked for. */
  model: string | null;
  /**
   * The prompt tokens the vendor reported: uncached input, cache reads and
   * cache writes together. Null when the call reported no input count.
   */
  promptTokens: number | null;
  /** Every byte the window measured. */
  bytes: number;
  blocks: RecordedWindowBlock[];
}

/** What the assembler put in front of the model, from a `steering.manifest` frame. */
export interface RecordedAssembly {
  seq: string;
  budgetTokens: number;
  spentTokens: number;
  included: number;
  cut: number;
  /** The digest of the text the model read; null when nothing was included. */
  textDigest: string | null;
}

/** A window's blocks with each one's share of `promptTokens`. */
function windowBlocksWithTokens(
  blocks: readonly ContextWindowBlock[],
  promptTokens: number | null,
): RecordedWindowBlock[] {
  const shares =
    promptTokens === null ? null : apportionWindowTokens(promptTokens, blocks);
  return blocks.map((block, index) => ({
    kind: block.kind,
    bytes: block.bytes,
    items: block.items,
    tokens: shares === null ? null : (shares[index] ?? 0),
  }));
}

function record(payload: unknown): Record<string, unknown> | null {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

const STARTED = "model.engine_call_started";
const COMPLETED = "model.engine_call_completed";
const MANIFEST = "steering.manifest";

/** Whether a ledger event is one `ledgerContextWindows` reads. */
export function isContextWindowEvent(eventType: string): boolean {
  return (
    eventType === STARTED || eventType === COMPLETED || eventType === MANIFEST
  );
}

/**
 * The manifest summary of a `steering.manifest` frame: the ledger's payload
 * or a wrapped frame's body. Null when a member is missing, so a reader never
 * draws a budget the frame did not state.
 */
export function assemblyOf(
  seq: string,
  fields: unknown,
): RecordedAssembly | null {
  const f = record(fields);
  if (f === null) return null;
  const budgetTokens = count(f["budget_tokens"]);
  const spentTokens = count(f["spent_tokens"]);
  const included = count(f["included"]);
  const cut = count(f["cut"]);
  if (
    budgetTokens === null ||
    spentTokens === null ||
    included === null ||
    cut === null
  )
    return null;
  return {
    seq,
    budgetTokens,
    spentTokens,
    included,
    cut,
    textDigest: text(f["text_digest"]),
  };
}

/**
 * Every window a ledger run recorded, in frame order, and how many completed
 * model calls carried none. `events` is the run's events in `run_seq` order;
 * any type but the two model-call events and the manifest is ignored.
 */
export function ledgerContextWindows(
  events: readonly AttemptEventReadRecord[],
): {
  windows: RecordedWindow[];
  assemblies: RecordedAssembly[];
  unmeasured: number;
} {
  const completions = new Map<
    string,
    { seq: string; model: string | null; input: number | null }
  >();
  for (const event of events) {
    if (event.eventType !== COMPLETED) continue;
    const p = record(event.payload);
    const id = text(p?.["model_call_id"]);
    if (id === null || completions.has(id)) continue;
    completions.set(id, {
      seq: event.runSeq,
      model: text(p?.["model"]),
      // The engine reports an input figure that already includes its cached
      // tokens, which is the whole prompt the provider read.
      input: count(p?.["input_tokens"]),
    });
  }
  const windows: RecordedWindow[] = [];
  const assemblies: RecordedAssembly[] = [];
  const measured = new Set<string>();
  for (const event of events) {
    if (event.eventType === MANIFEST) {
      const assembly = assemblyOf(event.runSeq, event.payload);
      if (assembly !== null) assemblies.push(assembly);
      continue;
    }
    if (event.eventType !== STARTED) continue;
    const p = record(event.payload);
    const parsed = contextWindowPayloadSchema.safeParse(p?.["window"]);
    if (!parsed.success) continue;
    const id = text(p?.["model_call_id"]);
    if (id !== null) measured.add(id);
    const answer = id === null ? undefined : completions.get(id);
    const promptTokens = answer?.input ?? null;
    windows.push({
      seq: event.runSeq,
      responseSeq: answer?.seq ?? null,
      modelCallId: id,
      provider: text(p?.["provider"]),
      model: answer?.model ?? text(p?.["model"]),
      promptTokens,
      bytes: windowBytes(parsed.data.blocks),
      blocks: windowBlocksWithTokens(parsed.data.blocks, promptTokens),
    });
  }
  let unmeasured = 0;
  for (const id of completions.keys()) if (!measured.has(id)) unmeasured += 1;
  return { windows, assemblies, unmeasured };
}

/** The `tacho_events` columns a wrapped window is read from. */
export interface TachoModelCallRow {
  seq: number;
  kind: string;
  attrs: Readonly<Record<string, string>> | undefined;
  model: string;
  provider: string;
  /** The vendor's request id; empty when it sent none. */
  requestId: string;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** The typed body as JSON text; read only for a `steering.manifest`. */
  body: string;
}

/**
 * A wrapped `llm_call` frame's window, or null when it recorded none: a call
 * a transcript or OTel reported, one the proxy saw on an API it does not
 * parse, and one recorded before the proxy measured windows.
 *
 * The prompt total is the uncached input plus the two cache classes, the
 * envelope's convention. A class the vendor left out reads as zero when the
 * input count is there, and the total is null when the input count is not.
 */
export function tachoContextWindow(
  row: TachoModelCallRow,
): RecordedWindow | null {
  if (row.kind !== "llm_call") return null;
  const blocks = decodeWindowAttr(row.attrs?.[CONTEXT_WINDOW_ATTR]);
  if (blocks === null) return null;
  const promptTokens =
    row.inputTokens === null
      ? null
      : row.inputTokens +
        (row.cacheReadTokens ?? 0) +
        (row.cacheCreationTokens ?? 0);
  return {
    seq: String(row.seq),
    responseSeq: String(row.seq),
    modelCallId: text(row.requestId),
    provider: text(row.provider),
    model: text(row.model),
    promptTokens,
    bytes: windowBytes(blocks),
    blocks: windowBlocksWithTokens(blocks, promptTokens),
  };
}

/** Whether a wrapped `llm_call` row is a later sighting of a call already counted. */
export function isLaterLlmCallSighting(row: TachoModelCallRow): boolean {
  return (row.attrs?.[LLM_CALL_DUPLICATE_OF_ATTR] ?? "") !== "";
}
