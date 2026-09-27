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
 * - `context_frame_tokens`: left absent. Claude Code's hook context rides the
 *   conversation too, and nothing marks it apart (ADR-200), so no count here
 *   would be honest.
 *
 * Claude Code reports none of the three, so each count is an estimate:
 * `budgetTokens`, the UTF-8 byte count over four, the unit the steering
 * assembler already budgets in. Each count carries its basis beside it.
 *
 * The proxy stores a request with the prefix the previous call holds cut out
 * (`request-prefix.ts`). A cut request names the call that holds the cut
 * fields by that call's full digest, so this module remembers what each
 * request it measured resolved to, by full digest, and a cut request reuses
 * the parts it points at. A digest names exact bytes, so the memory is
 * shared by every recorder in the process. A cut request whose earlier call
 * this process never measured, after a restart, measures no system context.
 */
import { budgetTokens } from "@contextgraphprotocol/typescript-sdk";
import type { z } from "zod";
import { PRIOR_MEMBER } from "../collector/request-prefix";
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

/** How many measured requests the shared memory holds. */
const MEMORY_REQUESTS = 512;

/** How many distinct system contexts one turn lists before listing again. */
const LISTED_PER_TURN = 16;

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
  .strict();

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
}

const SHARED_MEMORY = new SystemContextMemory();

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
 * The name of the steering part that stands for the assembled text around
 * the items: the header, the force headings, the separators, and any
 * omission note. It is always the first steering part, and its digest is the
 * manifest's `text_digest`, so a record that happens to share the name still
 * reads as a separate part.
 */
export const STEERING_ASSEMBLY_PART = "$assembly";

/** A session's steering: its parts, and the tokens they cost together. */
export interface SteeringContext {
  parts: SystemContextPart[];
  tokens: number;
}

/**
 * The steering a `steering.manifest` body names. Each included item is a
 * part. The host appends one included `steer` item per operator message it
 * delivered beside the assembled text, so those count on top of it.
 *
 * The assembler's `spent_tokens` covers its whole text, which is more than
 * the item bodies, and `text_digest` names those bytes. When the manifest
 * carries both, the total is `spent_tokens` plus the delivered steers, and
 * one {@link STEERING_ASSEMBLY_PART} part carries the text digest and the
 * tokens the items leave over. A changed header then changes the
 * whole-context digest. A manifest without both counts its items alone.
 *
 * The total follows `spent_tokens`, not the parts. Each item's count rounds
 * up on its own, so the items can add up to more than the assembled text.
 * The assembly part then counts zero, and the parts sum past the total.
 */
export function steeringContext(
  body: Record<string, unknown>,
): SteeringContext | undefined {
  const items = body["items"];
  if (!Array.isArray(items)) return undefined;
  const parts: SystemContextPart[] = [];
  let assembled = 0;
  let delivered = 0;
  for (const item of items) {
    if (!isObject(item) || item["outcome"] !== "included") continue;
    const { id, kind, force, recorded_at, tokens } = item;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) continue;
    parts.push({
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
    });
    if (kind === "steer") delivered += clampU32(tokens);
    else assembled += clampU32(tokens);
  }
  const spent = body["spent_tokens"];
  const text = body["text_digest"];
  if (
    typeof spent !== "number" ||
    !Number.isFinite(spent) ||
    !isSha256Digest(text)
  ) {
    return { parts, tokens: clampU32(assembled + delivered) };
  }
  const assembly: SystemContextPart = {
    kind: "steering",
    name: STEERING_ASSEMBLY_PART,
    digest: text,
    tokens: clampU32(spent - assembled),
  };
  return {
    parts: [assembly, ...parts],
    tokens: clampU32(clampU32(spent) + delivered),
  };
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

  constructor(
    state?: SystemContextState,
    private readonly memory: SystemContextMemory = SHARED_MEMORY,
  ) {
    const parts = state?.steering?.map((part) => ({ ...part }));
    this.steering =
      parts === undefined
        ? undefined
        : { parts, tokens: state?.steeringTokens ?? sum(parts) };
    this.listedTurn = state?.listedTurn;
    this.listed = [...(state?.listed ?? [])];
  }

  state(): SystemContextState {
    const state: SystemContextState = {};
    if (this.steering !== undefined) {
      state.steering = this.steering.parts.map((part) => ({ ...part }));
      state.steeringTokens = this.steering.tokens;
    }
    if (this.listedTurn !== undefined) state.listedTurn = this.listedTurn;
    if (this.listed.length > 0) state.listed = [...this.listed];
    return state;
  }

  /** Take the steering a sealed `steering.manifest` frame names. */
  noteSteeringManifest(body: Record<string, unknown>): void {
    const steering = steeringContext(body);
    if (steering !== undefined) this.steering = steering;
  }

  /**
   * Measure one model call. `content` is the proxy's exchange body, `attrs`
   * the frame's attrs, and `turn` a key that changes when the turn does.
   */
  measure(
    content: DraftContent | undefined,
    attrs: Record<string, string> | undefined,
    turn: string,
  ): SystemContextMeasure {
    const facts: TokenSourceFacts = {};
    const steering = this.steering;
    if (steering !== undefined) {
      facts.steering_tokens = steering.tokens;
      facts.steering_tokens_basis = "estimated";
    }
    const recorded = requestOf(content);
    const resolved =
      recorded === undefined
        ? undefined
        : resolveRequest(recorded.request, this.memory);
    if (recorded === undefined || resolved === undefined)
      return this.checked(facts, {}, () => {});

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
