/**
 * The system context of a model call and its three token sources, measured
 * from the request the loopback proxy recorded (#4493, ADR-062).
 *
 * A model call's input is the system context plus the conversation. The
 * system context is what the harness sends on every call: the system prompt,
 * the tool definitions, the steering records the session was delivered, and
 * any context frames a harness injected. This module lists those parts as
 * ids, digests, and token counts, never their text, and sums three of them:
 *
 * - `tool_definition_tokens`: the tools the request declared.
 * - `steering_tokens`: the session's latest `steering.manifest` frame. That
 *   is the assembled text's `spent_tokens`, header and headings included,
 *   plus each operator message the host delivered beside it. A manifest
 *   without `spent_tokens` counts its included items. Claude Code delivers
 *   steering through `SessionStart` context, which rides the conversation,
 *   so the request cannot say which bytes are steering. The manifest can.
 * - `context_frame_tokens`: the text Oxagen's own hooks handed the agent
 *   after its start (#5339). That is a later hook's `additionalContext`,
 *   such as recalled memories or an operator's message, and a `Stop` block's
 *   reason. The text rides the conversation, so the request cannot say which
 *   bytes are Oxagen's (ADR-200). The hook answer can, so the daemon notes
 *   each answer's text here as it leaves ({@link
 *   SystemContextTracker.noteInjectedContext}). The text stays in the
 *   conversation, so every later call carries it again, and each call counts
 *   the running total, the way each call counts the steering. A compaction
 *   or a `/clear` empties the total. The count leaves out context a person's
 *   own hooks add, which Oxagen never sees, so a total of zero is left absent
 *   and never written as zero.
 *
 * Claude Code reports none of the three, so each count is an estimate:
 * `budgetTokens`, the UTF-8 byte count over four, the unit the steering
 * assembler already budgets in. Each count carries its basis beside it.
 *
 * What each path can measure (ADR-062, amendments of 2026-10-02 and
 * 2026-10-03):
 *
 * - The loopback proxy records the request, so a proxied call carries the
 *   tool definition count, the steering count, the context frame count, the
 *   system context digest, and its parts ({@link
 *   SystemContextTracker.measure}).
 * - An OTel `api_request` record and a transcript `assistant` record carry
 *   usage and ids, never the request. On a session the proxy did not carry,
 *   the counted row of a call carries the steering count and the context
 *   frame count ({@link SystemContextTracker.measureUnseen}). The manifest
 *   and the hook answers say what Oxagen delivered, whichever path saw the
 *   call. The tool definitions and the system context stay absent. A digest
 *   over the steering parts alone would read as the whole context, and a
 *   change to a tool would look like no change.
 * - The context frames are a count and never a part. They ride the
 *   conversation, not the prefix the digest covers, so a new recall does not
 *   read as a changed system context.
 *
 * Only a call that carries the session's conversation carries its steering.
 * Claude Code also makes side calls, such as a session title or a check of a
 * Bash command's prefix, and those send a short prompt of their own without
 * the `SessionStart` context. A side call takes no steering count and no
 * steering parts. The proxy reads a request that declares no tools as a side
 * call (see `measure`). The recorder reads OTel's `query_source` for the
 * same question (`recorder.ts`).
 *
 * The proxy stores a request with the part its session's prior holds cut
 * out (`request-prefix.ts`). A cut request names the call that holds the cut
 * fields by that call's full digest, so this module remembers what each
 * request it measured resolved to, by full digest, and a cut request reuses
 * the parts it points at. A digest names exact bytes, so the memory is
 * shared by every recorder in the process.
 *
 * A cut request resolves by this rule (#4348, #4508):
 *
 * 1. A call becomes its session's prior only once its frame is on the WAL.
 *    Sealing that frame measured the call, so its context was in this memory
 *    before any later call could name it.
 * 2. The proxy keeps that context beside the prior in `RequestPrefixMemory`,
 *    which evicts by session, as the prior itself is evicted. A fold takes
 *    the context of the call it cut against and holds it until its own frame
 *    seals.
 * 3. Just before that seal, the proxy puts the context back in this memory
 *    (`SystemContextMemory.restorePrior`). Resolving then never depends on
 *    what this memory evicted since: another session's calls, or a call
 *    that settled out of order.
 *
 * So this memory is only the hand-off between a seal and the proxy, and a
 * small bound serves it. A cut request whose earlier call this process never
 * measured, after a restart, measures no system context.
 */
import { budgetTokens } from "@contextgraphprotocol/typescript-sdk";
import type { z } from "zod";
import { type PrefixFold, PRIOR_MEMBER } from "../collector/request-prefix";
import {
  digestBytes,
  digestJcs,
  isSha256Digest,
  jcs,
  type JsonValue,
  type Sha256Digest,
} from "../digest";
import {
  modelFacts,
  refineTokenSourcePairs,
  SYSTEM_CONTEXT_PARTS_MAX,
  type SystemContextPart,
} from "../envelope";
import type { DraftContent } from "../evidence/frame-body";

/** The attr the proxy sets to the digest of the full decoded request. */
export const REQUEST_FULL_DIGEST_ATTR = "oxagen.request_full_digest";

/**
 * Set on a frame whose system context had more parts than one frame lists.
 * Its counts and `system_context_digest` are still set.
 */
export const SYSTEM_CONTEXT_PARTS_OMITTED_ATTR =
  "oxagen.system_context_parts_omitted";

/**
 * How many measured requests the shared memory holds. It is a hand-off, not
 * the store a later fold reads (see the rule above), so its bound does not
 * limit how many sessions resolve.
 */
const MEMORY_REQUESTS = 512;

/** How many distinct system contexts one turn lists before listing again. */
const LISTED_PER_TURN = 16;

/**
 * How many hook answers the tracker keeps a running total for. A call reads
 * the total as of when it was made, and its OTel or transcript record can
 * arrive after later answers left. This many answers can pass before the
 * record arrives and the call still reads its own total.
 */
const INJECTED_MARKS_MAX = 32;

const U32_MAX = 4_294_967_295;
const NAME_MAX = 512;

/** The model-call members this module sets. */
const tokenSourceFacts = modelFacts
  .pick({
    tool_definition_tokens: true,
    tool_definition_tokens_basis: true,
    context_frame_tokens: true,
    context_frame_tokens_basis: true,
    steering_tokens: true,
    steering_tokens_basis: true,
    system_context_digest: true,
    system_context_parts: true,
  })
  .strict()
  .superRefine((facts, ctx) => refineTokenSourcePairs(facts, ctx));

export type TokenSourceFacts = z.output<typeof tokenSourceFacts>;

/** The request parts that are not steering, as one request resolved them. */
export interface RequestContext {
  /** From `system`: one part for a string, one per block for an array. */
  system: readonly SystemContextPart[];
  /** From `instructions`, the Responses API's system prompt. */
  instructions: readonly SystemContextPart[];
  /**
   * The leading `system` and `developer` messages of the conversation: a
   * chat request's `messages`, or a Responses request's `input`.
   */
  leading: readonly SystemContextPart[];
  tools: readonly SystemContextPart[];
}

/** What each measured request resolved to, by the digest of its full text. */
export class SystemContextMemory {
  private readonly entries = new Map<Sha256Digest, RequestContext>();

  constructor(private readonly capacity = MEMORY_REQUESTS) {}

  get(digest: Sha256Digest): RequestContext | undefined {
    const entry = this.entries.get(digest);
    if (entry !== undefined) {
      this.entries.delete(digest);
      this.entries.set(digest, entry);
    }
    return entry;
  }

  set(digest: Sha256Digest, context: RequestContext): void {
    this.entries.delete(digest);
    this.entries.set(digest, context);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * Put back the context of the call `fold` cut against, as the fold took it
   * from the prefix memory, so the frame about to seal resolves it whatever
   * this memory evicted since. A fold that cut nothing, or whose prior was
   * remembered with no context, puts back nothing.
   */
  restorePrior(
    fold: Pick<PrefixFold<RequestContext>, "prior" | "priorPayload">,
  ): void {
    if (fold.prior === undefined || fold.priorPayload === undefined) return;
    this.set(fold.prior.unchanged_from, fold.priorPayload);
  }
}

/**
 * The memory every recorder in the process resolves against by default. The
 * proxy reads and restores contexts here around each seal, so the two share
 * this one instance.
 */
export const SHARED_SYSTEM_CONTEXT_MEMORY = new SystemContextMemory();

type Json = Record<string, JsonValue | undefined>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampU32(value: number): number {
  return Math.min(U32_MAX, Math.max(0, Math.trunc(value)));
}

function clip(value: string): string {
  return value.length > NAME_MAX ? value.slice(0, NAME_MAX) : value;
}

/**
 * A part's digest and token count. The digest is over the part's canonical
 * JSON less a top-level `cache_control` member, which is a caching hint and
 * not context: a breakpoint that moves does not read as a changed part. The
 * count is over the text the model reads where the part is text, and over
 * the canonical JSON otherwise.
 */
function measurePart(value: JsonValue): PartMeasure {
  const bare: JsonValue =
    isObject(value) && "cache_control" in value
      ? (Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "cache_control"),
        ) as JsonValue)
      : value;
  return {
    digest: digestJcs(bare),
    tokens: clampU32(budgetTokens(textOf(bare))),
  };
}

type PartMeasure = { digest: Sha256Digest; tokens: number };

/** The text the model reads in a part: a string, a `text`, or a `content`. */
function textOf(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (isObject(value)) {
    const text = value["text"];
    if (typeof text === "string") return text;
    const content = value["content"];
    if (typeof content === "string") return content;
  }
  return jcs(value);
}

function systemParts(value: JsonValue | undefined): SystemContextPart[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    return value.length === 0
      ? []
      : [{ kind: "system", name: "system", ...measurePart(value) }];
  }
  if (Array.isArray(value)) {
    return value.map(
      (block, index): SystemContextPart => ({
        kind: "system",
        name: `system[${index}]`,
        ...measurePart(block),
      }),
    );
  }
  return [{ kind: "system", name: "system", ...measurePart(value) }];
}

function instructionParts(value: JsonValue | undefined): SystemContextPart[] {
  return typeof value === "string" && value.length > 0
    ? [{ kind: "system", name: "instructions", ...measurePart(value) }]
    : [];
}

function isLeadingInstruction(message: JsonValue | undefined): boolean {
  if (!isObject(message)) return false;
  const role = message["role"];
  return role === "system" || role === "developer";
}

/**
 * The conversation arrays a request may carry: `messages` for Anthropic
 * Messages and chat completions, `input` for Responses. The order is the one
 * the proxy's fold reads them in (`request-prefix.ts`), so a cut request's
 * kept count applies to the same array here.
 */
const CONVERSATION_FIELDS = ["messages", "input"] as const;

/** The first conversation array a request carries, with its field name. */
function conversationOf(
  request: Json,
): { field: string; items: readonly JsonValue[] } | undefined {
  for (const field of CONVERSATION_FIELDS) {
    const items = request[field];
    if (Array.isArray(items)) return { field, items };
  }
  return undefined;
}

/** The leading instruction messages, named by position from `offset`. */
function leadingParts(
  field: string,
  messages: readonly JsonValue[],
  offset: number,
): SystemContextPart[] {
  const parts: SystemContextPart[] = [];
  for (const message of messages) {
    if (!isLeadingInstruction(message)) break;
    parts.push({
      kind: "system",
      name: `${field}[${offset + parts.length}]`,
      ...measurePart(message),
    });
  }
  return parts;
}

/** The server an MCP tool is served by, or `builtin`. */
export function toolProvider(name: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return mcp?.[1] !== undefined ? clip(mcp[1]) : "builtin";
}

function toolName(tool: JsonValue, index: number): string {
  if (isObject(tool)) {
    const fn = tool["function"];
    for (const candidate of [
      tool["name"],
      isObject(fn) ? fn["name"] : undefined,
      tool["type"],
    ]) {
      if (typeof candidate === "string" && candidate.length > 0)
        return clip(candidate);
    }
  }
  return `tools[${index}]`;
}

function toolParts(value: JsonValue | undefined): SystemContextPart[] {
  if (!Array.isArray(value)) return [];
  return value.map((tool, index): SystemContextPart => {
    const name = toolName(tool, index);
    return {
      kind: "tool",
      name,
      provider: toolProvider(name),
      ...measurePart(tool),
    };
  });
}

/** What a cut request's `$oxagen_prior` member says was left out. */
type Prior = { from: Sha256Digest; messages: number; fields: Set<string> };

/** The `$oxagen_prior` member of a cut request, when it is well formed. */
function readPrior(value: JsonValue | undefined): Prior | undefined {
  if (!isObject(value)) return undefined;
  const from = value["unchanged_from"];
  const messages = value["messages"];
  const fields = value["fields"];
  if (!isSha256Digest(from)) return undefined;
  if (typeof messages !== "number" || !Number.isSafeInteger(messages))
    return undefined;
  if (messages < 0 || !Array.isArray(fields)) return undefined;
  const names = fields.filter((field) => typeof field === "string");
  return { from, messages, fields: new Set(names as string[]) };
}

/**
 * Resolve one recorded request to its system context. A cut request takes
 * the fields it left out from the call it names. Returns undefined when that
 * call is not in memory, or the cut marker is malformed.
 */
export function resolveRequest(
  request: Json,
  memory: SystemContextMemory,
): RequestContext | undefined {
  const marker = request[PRIOR_MEMBER];
  const prior = marker === undefined ? undefined : readPrior(marker);
  if (marker !== undefined && prior === undefined) return undefined;
  const base = prior === undefined ? undefined : memory.get(prior.from);
  if (prior !== undefined && base === undefined) return undefined;
  const cut = prior?.fields ?? new Set<string>();

  let leading: readonly SystemContextPart[] = [];
  const conversation = conversationOf(request);
  if (conversation !== undefined) {
    const { field, items } = conversation;
    const kept = prior?.messages ?? 0;
    const inherited = base?.leading ?? [];
    // Past the end of the earlier call's lead, the cut prefix already holds
    // a message that is not an instruction, so the lead ends there.
    leading =
      kept > inherited.length
        ? inherited
        : [...inherited.slice(0, kept), ...leadingParts(field, items, kept)];
  }

  return {
    system:
      cut.has("system") && base !== undefined
        ? base.system
        : systemParts(request["system"]),
    instructions:
      cut.has("instructions") && base !== undefined
        ? base.instructions
        : instructionParts(request["instructions"]),
    leading,
    tools:
      cut.has("tools") && base !== undefined
        ? base.tools
        : toolParts(request["tools"]),
  };
}

/**
 * The request half of a proxy exchange body, as text and parsed, or
 * undefined. The proxy stores the request as a JSON string inside the
 * exchange, so it parses twice.
 */
function requestOf(
  content: DraftContent | undefined,
): { text: string; request: Json } | undefined {
  if (content === undefined) return undefined;
  if (!content.content_type.startsWith("application/json")) return undefined;
  try {
    const exchange: unknown = JSON.parse(
      Buffer.from(content.bytes).toString("utf8"),
    );
    if (!isObject(exchange)) return undefined;
    const text = exchange["request"];
    if (typeof text !== "string") return undefined;
    const request: unknown = JSON.parse(text);
    return isObject(request) ? { text, request } : undefined;
  } catch {
    return undefined;
  }
}

/** One digest over the ordered parts: each part's kind, name, and digest. */
export function systemContextDigest(
  parts: readonly SystemContextPart[],
): Sha256Digest {
  return digestJcs(parts.map((part) => [part.kind, part.name, part.digest]));
}

function sum(parts: readonly SystemContextPart[]): number {
  return clampU32(parts.reduce((total, part) => total + part.tokens, 0));
}

/**
 * The name of the steering part that stands for the assembled text: every
 * included record with the header, the force headings, the separators, and
 * any omission note. It is always the first steering part, and its digest is
 * the manifest's `text_digest`, so a record that happens to share the name
 * still reads as a separate part.
 */
export const STEERING_ASSEMBLY_PART = "$assembly";

/** A session's steering: its parts, and the tokens they cost together. */
export interface SteeringContext {
  parts: SystemContextPart[];
  tokens: number;
}

/**
 * The steering a `steering.manifest` body names. The host appends one
 * included `steer` item per operator message it delivered beside the
 * assembled text, so those count on top of it, one part each.
 *
 * The assembler's `spent_tokens` covers its whole text, and `text_digest`
 * names those bytes. When the manifest carries both, the assembled text is
 * one {@link STEERING_ASSEMBLY_PART} part with that digest and that count,
 * and the total is `spent_tokens` plus the delivered steers. The part is
 * digested over the text alone, so a bundle assembled again with the same
 * text and a new record `id` or `recorded_at` keeps its digest, and so does
 * the whole context (#4508). A changed header changes it.
 *
 * A manifest without both lists each included item as its own part,
 * digested over the item's manifest entry, and counts the items alone.
 */
export function steeringContext(
  body: Record<string, unknown>,
): SteeringContext | undefined {
  const items = body["items"];
  if (!Array.isArray(items)) return undefined;
  const parts: SystemContextPart[] = [];
  const steers: SystemContextPart[] = [];
  let total = 0;
  let delivered = 0;
  for (const item of items) {
    if (!isObject(item) || item["outcome"] !== "included") continue;
    const { id, kind, force, recorded_at, tokens } = item;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) continue;
    const part: SystemContextPart = {
      kind: "steering",
      name: clip(id),
      digest: digestJcs({
        id,
        kind: kind ?? null,
        force: force ?? null,
        recorded_at: recorded_at ?? null,
        tokens,
      }),
      tokens: clampU32(tokens),
    };
    parts.push(part);
    total += part.tokens;
    if (kind === "steer") {
      steers.push(part);
      delivered += part.tokens;
    }
  }
  const spent = body["spent_tokens"];
  const text = body["text_digest"];
  if (
    typeof spent !== "number" ||
    !Number.isFinite(spent) ||
    !isSha256Digest(text)
  ) {
    return { parts, tokens: clampU32(total) };
  }
  const assembly: SystemContextPart = {
    kind: "steering",
    name: STEERING_ASSEMBLY_PART,
    digest: text,
    tokens: clampU32(spent),
  };
  return {
    parts: [assembly, ...steers],
    tokens: clampU32(assembly.tokens + delivered),
  };
}

/**
 * The steering count and its basis, or nothing when there is no steering to
 * count: before a manifest seals, or on a side call. A fresh object each time,
 * since `measure` adds members to it.
 */
function steeringFactsOf(
  steering: SteeringContext | undefined,
): TokenSourceFacts {
  if (steering === undefined) return {};
  return {
    steering_tokens: steering.tokens,
    steering_tokens_basis: "estimated",
  };
}

/**
 * The context frame count and its basis, or nothing when Oxagen's hooks had
 * handed the agent no text that the call still carries. Zero is left absent:
 * a person's own hooks can add context Oxagen never sees, so zero from
 * Oxagen is not zero context frames.
 */
function contextFactsOf(tokens: number): TokenSourceFacts {
  if (tokens <= 0) return {};
  return {
    context_frame_tokens: tokens,
    context_frame_tokens_basis: "estimated",
  };
}

/**
 * The running total of the context Oxagen's hooks handed one session, in
 * tokens, as of one hook answer. `at` is when the answer left.
 */
export interface InjectedContextMark {
  at: string;
  tokens: number;
}

/** What a tracker carries over a restart. */
export interface SystemContextState {
  /** The latest manifest's steering parts. Absent until a manifest seals. */
  steering?: SystemContextPart[];
  /**
   * The steering's token count. A state saved before the count was carried
   * has none, and the tracker sums the parts.
   */
  steeringTokens?: number;
  /** The turn `listed` belongs to. */
  listedTurn?: string;
  /** The system context digests already listed on this chain this turn. */
  listed?: string[];
  /**
   * The running totals of the context Oxagen's hooks handed the session
   * after its start, oldest first, at most {@link INJECTED_MARKS_MAX}.
   * Absent until a hook hands the agent text.
   */
  injected?: InjectedContextMark[];
  /** The running total before the oldest mark in `injected`. */
  injectedFloor?: number;
}

/** The marks a saved state carries, dropping any that is malformed. */
function injectedMarksOf(value: unknown): InjectedContextMark[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((mark): InjectedContextMark[] => {
    if (typeof mark !== "object" || mark === null) return [];
    const { at, tokens } = mark as Record<string, unknown>;
    if (typeof at !== "string" || typeof tokens !== "number") return [];
    if (!Number.isFinite(tokens)) return [];
    return [{ at, tokens: clampU32(tokens) }];
  });
}

/** The facts to add to one `llm_call` body, and what to do once it seals. */
export interface SystemContextMeasure {
  facts: TokenSourceFacts;
  attrs: Record<string, string>;
  /** Call once the frame has sealed, so a refused frame leaves no trace. */
  commit: () => void;
}

/**
 * The per-chain half: the session's steering, and which system contexts the
 * chain already listed this turn. The first call of a turn lists its parts,
 * and so does any later call in the turn whose digest the turn has not
 * listed. The other calls carry the digest and the counts alone.
 */
export class SystemContextTracker {
  private steering: SteeringContext | undefined;
  private listedTurn: string | undefined;
  private listed: string[];
  private injected: InjectedContextMark[];
  private injectedFloor: number;

  constructor(
    state?: SystemContextState,
    private readonly memory: SystemContextMemory = SHARED_SYSTEM_CONTEXT_MEMORY,
  ) {
    const parts = state?.steering?.map((part) => ({ ...part }));
    this.steering =
      parts === undefined
        ? undefined
        : { parts, tokens: state?.steeringTokens ?? sum(parts) };
    this.listedTurn = state?.listedTurn;
    this.listed = [...(state?.listed ?? [])];
    this.injected = injectedMarksOf(state?.injected);
    const floor = state?.injectedFloor;
    this.injectedFloor =
      typeof floor === "number" && Number.isFinite(floor) ? clampU32(floor) : 0;
  }

  state(): SystemContextState {
    const state: SystemContextState = {};
    if (this.steering !== undefined) {
      state.steering = this.steering.parts.map((part) => ({ ...part }));
      state.steeringTokens = this.steering.tokens;
    }
    if (this.listedTurn !== undefined) state.listedTurn = this.listedTurn;
    if (this.listed.length > 0) state.listed = [...this.listed];
    if (this.injected.length > 0)
      state.injected = this.injected.map((mark) => ({ ...mark }));
    if (this.injectedFloor > 0) state.injectedFloor = this.injectedFloor;
    return state;
  }

  /** Take the steering a sealed `steering.manifest` frame names. */
  noteSteeringManifest(body: Record<string, unknown>): void {
    const steering = steeringContext(body);
    if (steering !== undefined) this.steering = steering;
  }

  /**
   * Note text an Oxagen hook answer handed the agent after its start, at
   * `at`, when the answer left (#5339). The text joins the conversation, so
   * every call made from `at` on carries it. Empty text notes nothing.
   *
   * The caller passes only text the session's own conversation reads. The
   * start's text is the steering manifest's to count, and a subagent's text
   * stays in the subagent's conversation.
   */
  noteInjectedContext(text: string, at: string): void {
    const tokens = clampU32(budgetTokens(text));
    if (tokens === 0) return;
    this.markInjected(at, this.injectedTotal() + tokens);
  }

  /**
   * Empty the running total at `at`: a compaction or a `/clear` took the
   * text out of the conversation. A call made before `at` still reads the
   * total it was made with.
   */
  clearInjectedContext(at: string): void {
    if (this.injected.length === 0 && this.injectedFloor === 0) return;
    this.markInjected(at, 0);
  }

  private injectedTotal(): number {
    return this.injected.at(-1)?.tokens ?? this.injectedFloor;
  }

  private markInjected(at: string, tokens: number): void {
    this.injected.push({ at, tokens: clampU32(tokens) });
    while (this.injected.length > INJECTED_MARKS_MAX) {
      const oldest = this.injected.shift();
      if (oldest !== undefined) this.injectedFloor = oldest.tokens;
    }
  }

  /**
   * The context Oxagen's hooks had handed the session when a call was made
   * at `at`: the latest mark at or before it. A record can arrive after
   * later answers left, since OTel exports in batches and the transcript is
   * read behind the session. A call with no readable time reads the latest
   * total. A call older than every mark kept reads the total before them.
   */
  private injectedAt(at: string | undefined): number {
    const when = at === undefined ? Number.NaN : Date.parse(at);
    if (Number.isNaN(when)) return this.injectedTotal();
    for (let index = this.injected.length - 1; index >= 0; index -= 1) {
      const mark = this.injected[index];
      if (mark === undefined) continue;
      const markAt = Date.parse(mark.at);
      if (Number.isNaN(markAt) || markAt <= when) return mark.tokens;
    }
    return this.injectedFloor;
  }

  /**
   * Measure one model call. `content` is the proxy's exchange body, `attrs`
   * the frame's attrs, `turn` a key that changes when the turn does, and
   * `at` when the call was made.
   */
  measure(
    content: DraftContent | undefined,
    attrs: Record<string, string> | undefined,
    turn: string,
    at?: string,
  ): SystemContextMeasure {
    const recorded = requestOf(content);
    const resolved =
      recorded === undefined
        ? undefined
        : resolveRequest(recorded.request, this.memory);
    // A request the tracker cannot read or resolve keeps the steering and
    // context frame counts. Its tools are out of sight, so the side call rule
    // below cannot apply. The usual cause is a request too large for the
    // proxy to hold, and a side call's short prompt is never that large.
    if (recorded === undefined || resolved === undefined)
      return this.checked(
        {
          ...steeringFactsOf(this.steering),
          ...contextFactsOf(this.injectedAt(at)),
        },
        {},
        () => {},
      );

    // Remembered under the digest a later cut request names: the proxy's
    // attr, or for a request stored whole, the digest of its own text, which
    // is the same value.
    const fullDigest = attrs?.[REQUEST_FULL_DIGEST_ATTR];
    const key: Sha256Digest | undefined = isSha256Digest(fullDigest)
      ? fullDigest
      : recorded.request[PRIOR_MEMBER] === undefined
        ? digestBytes(recorded.text)
        : undefined;
    if (key !== undefined) this.memory.set(key, resolved);

    // A request that declares no tools reads as a side call. Claude Code's
    // main thread sends the session's tools on every call. A side call, such
    // as a session title, sends a short prompt of its own without them, and
    // without the conversation the steering and the hook context rode in on.
    // So it takes no steering or context frame count, and its parts name no
    // steering. The rule only ever takes counts away. It misses two cases: a
    // session run with every tool turned off loses its counts, and a
    // subagent's proxied call, which declares tools, keeps the root
    // session's counts.
    const main = resolved.tools.length > 0;
    const steering = main ? this.steering : undefined;
    const facts: TokenSourceFacts = {
      ...steeringFactsOf(steering),
      ...(main ? contextFactsOf(this.injectedAt(at)) : {}),
    };
    const parts: SystemContextPart[] = [
      ...resolved.system,
      ...resolved.instructions,
      ...resolved.leading,
      ...resolved.tools,
      ...(steering?.parts ?? []),
    ];
    facts.tool_definition_tokens = sum(resolved.tools);
    facts.tool_definition_tokens_basis = "estimated";
    const digest = systemContextDigest(parts);
    facts.system_context_digest = digest;

    const sameTurn = this.listedTurn === turn;
    const already = sameTurn && this.listed.includes(digest);
    const out: Record<string, string> = {};
    if (!already) {
      if (parts.length > SYSTEM_CONTEXT_PARTS_MAX)
        out[SYSTEM_CONTEXT_PARTS_OMITTED_ATTR] = "too_many";
      else facts.system_context_parts = parts.map((part) => ({ ...part }));
    }
    return this.checked(facts, out, () => {
      if (already) return;
      if (!sameTurn) {
        this.listedTurn = turn;
        this.listed = [];
      }
      this.listed.push(digest);
      if (this.listed.length > LISTED_PER_TURN) this.listed.shift();
    });
  }

  /**
   * The token sources of a model call whose request the recorder never saw:
   * the counted OTel or transcript row of a call the proxy did not carry
   * (#4493). Two counts are known without the request: the steering, from
   * the manifest, and the context frames, from the hook answers noted before
   * `at`, when the call was made (#5339). The tool definition count and the
   * system context stay absent, never zero. Nothing changes on the tracker,
   * so there is nothing to commit. The caller asks only for a call that
   * carries the session's conversation, since a side call carries neither.
   */
  measureUnseen(at?: string): TokenSourceFacts {
    return this.checked(
      {
        ...steeringFactsOf(this.steering),
        ...contextFactsOf(this.injectedAt(at)),
      },
      {},
      () => {},
    ).facts;
  }

  /**
   * Hand back facts the envelope accepts, or none. A body the envelope
   * refuses loses its frame, so a measurement that fails the schema is
   * dropped rather than risk the call's record.
   */
  private checked(
    facts: TokenSourceFacts,
    attrs: Record<string, string>,
    commit: () => void,
  ): SystemContextMeasure {
    if (tokenSourceFacts.safeParse(facts).success)
      return { facts, attrs, commit };
    return { facts: {}, attrs: {}, commit: () => {} };
  }
}
