/**
 * The one transcript fold (Mission Control spec §14; ADR-058; ADR-182).
 *
 * A run's frames read at three zoom levels, and every level is this fold:
 *
 * - `everything` is one entry per frame.
 * - `steps` is one entry per model call, per tool call and per event, built
 *   by the rules below. A step never crosses a turn boundary.
 * - `turns` is the steps grouped by the turn they fall in, so the two zooms
 *   cannot disagree about what a turn holds.
 *
 * Each entry carries the facts a reader would otherwise derive from its
 * frames: its key, the step that spawned it, what kind of row it is, whether
 * it has anything to show, how it ended, the approval it waits on, every
 * decision made about it, what it acted on, its tool family, its model, how
 * long it took, and the entry it repeats. The Run page used to derive each of
 * these again in the browser, by its own rules, and the two readings
 * disagreed (#3375, #3994). A rule about how a run reads is now made here and
 * tested here, and every surface reads it.
 *
 * ## How frames become steps
 *
 * Within one turn, frames are taken in order, and each frame no earlier step
 * claimed opens a step:
 *
 * 1. A frame that carries a call key and is not a model frame gathers every
 *    unclaimed frame with the same key on its chain, when one of them is a
 *    tool frame. That is one tool call, however many sources sealed it: the
 *    gate's decision, the request, the harness's own check, the receipt, and
 *    digest-only copies. The step opens on the earliest of them.
 * 2. A model request pairs with the next unclaimed response of its spelling:
 *    on the call key where the request has one, else the frame right after
 *    it. Each request takes a response no other request took (#3994).
 * 3. A tool request with no key takes the unkeyed gates right after it, and
 *    the unkeyed receipt that closes it.
 * 4. A lone model or tool frame is a whole step.
 * 5. A run of identical frames with nothing to read on them (Claude Code's
 *    thirty hook registrations) is one event step.
 * 6. Any other frame is its own event step.
 *
 * A tool step also takes the effect frames (`command`, `file_io`, `network`)
 * right after it that name its call, or that name no call when the step
 * names none either. An effect frame that names another call stays its own
 * step.
 *
 * Nothing here reads a body. A frame carries its body reference, and the fold
 * prefers a half whose body was kept; the caller reads the bodies of the
 * halves it names.
 */
import {
  addFrameUsage,
  boundaryHalf,
  COMMAND_APPLIED,
  FAILED_OUTCOMES,
  type FrameUsage,
  frameKey,
  frameKinds,
  opensRunTurn,
  POLICY_TYPES,
  RECALL_TYPES,
  type RunFrame,
  stepKind,
  stopsRun,
  type TranscriptKind,
  turnOrdinals,
} from "./run-frames";
import {
  TRANSCRIPT_NODES,
  TRANSCRIPT_OUTCOMES,
  type TranscriptNode,
  type TranscriptOutcome,
} from "@oxagen/tacho";
import { bareToolName, type ToolFamily, toolFamilyOf } from "./tool-family";

export type TranscriptZoom = "turns" | "steps" | "everything";

export type TranscriptEntryKind =
  | "turn"
  | "model_call"
  | "tool_call"
  | "policy"
  | "frame";

// The node and outcome vocabularies are the leaf package's, like the chips,
// so the contract that publishes them as enums and this fold read one list.
export {
  TRANSCRIPT_NODES,
  TRANSCRIPT_OUTCOMES,
  type TranscriptNode,
  type TranscriptOutcome,
};

/** A decision a rule or a person made about the call an entry records. */
export interface TranscriptDecision {
  seq: string;
  /** The subagent chain the decision was recorded on; absent on the run's own. */
  sessionUuid?: string;
  /**
   * The recorded word: `allow`, `deny`, `route`, or whatever the rule wrote.
   * An operator command records the command: `pause`, `resume`, `cancel` or
   * `steer`.
   */
  decision: string;
  type: string;
  /** Who decided, in `FrameIdentity.policySource`'s words; null when unrecorded. */
  source: string | null;
  at: Date;
}

/**
 * One transcript entry before its text is attached.
 *
 * `request` and `response` are the two halves of the exchange the entry
 * records: the frame that carried what went out and the frame that carried
 * what came back. A producer that appends a single terminal receipt for the
 * whole exchange (`tool.call_completed`, `llm_call`) records it as the
 * `response`, because its body is the result; `request` is then null. A turn
 * boundary carries its own words: a `turn_start` is the request, a `turn_end`
 * or a reported message the response.
 */
export interface TranscriptFold {
  /** The frame that opens the entry. */
  opening: RunFrame;
  endSeq: string;
  /**
   * The frame `endSeq` names. A run that reads its subagents' chains holds
   * frames from several chains, each numbered from 0, so a sequence alone
   * does not name one frame there; this does.
   */
  last: RunFrame;
  /** Every frame the entry holds, in the order they were read. */
  members: RunFrame[];
  /** The positions of the opening and last frames in the frames folded. */
  span: { open: number; end: number };
  kind: TranscriptEntryKind;
  frames: number;
  /** Summed cost records of the folded frames; null when none carried one. */
  costMicros: number | null;
  usage: FrameUsage | null;
  request: RunFrame | null;
  response: RunFrame | null;
  /** The last decision folded into the entry; null when none was. */
  decision: TranscriptDecision | null;
  /** Every decision folded into the entry, in the order recorded. */
  gates: TranscriptDecision[];
  /** Every chip a frame folded into the entry answers to (#3370). */
  kinds: Set<TranscriptKind>;
  /** The opening frame's name within the run (`frameKey`). */
  key: string;
  /** The turn the opening frame falls in (`turnOrdinals`); null before the first. */
  turn: number | null;
  /**
   * The key of the entry that spawned this subagent entry: the Task or Agent
   * call whose key the subagent's chain names, or else the latest entry on
   * the parent chain that recorded a `subagent_start`. Null on the run's own
   * chain, and where neither was recorded.
   */
  parentKey: string | null;
  /** What kind of row the entry is; null for a turn, which is a group. */
  node: TranscriptNode | null;
  /** True when the entry has nothing to show a reader beyond its frames. */
  quiet: boolean;
  outcome: TranscriptOutcome | null;
  /** The approval a parked call waits on (`apr_…`), when its receipt named one. */
  approvalId: string | null;
  /** The tool the entry is about, as recorded; null when none was named. */
  subject: string | null;
  family: ToolFamily | null;
  /** `provider/model` of a model call; null elsewhere. */
  model: string | null;
  /** First frame to last, in milliseconds; null for one frame or an unfinished call. */
  durationMs: number | null;
  /**
   * The key of an earlier entry in the same turn whose kept body this one
   * repeats byte for byte: a message that echoes the operator's prompt, or a
   * reply that says again what the last one said. Null otherwise.
   */
  echoOf: string | null;
}

// ── Frame vocabulary ────────────────────────────────────────────────────────

/** A model request and the response that closes it, per spelling. */
const MODEL_CLOSE: Readonly<Record<string, string>> = {
  "model.request": "model.response",
  "model.engine_call_started": "model.engine_call_completed",
};
/** A tool request and the receipt that closes it, per spelling. */
const TOOL_CLOSE: Readonly<Record<string, string>> = {
  tool_requested: "tool_call",
  "tool.engine_call_started": "tool.engine_call_completed",
};
/** Decisions about a tool call; an operator command is about the run instead. */
const TOOL_GATE: ReadonlySet<string> = new Set(
  [...POLICY_TYPES].filter((type) => type !== COMMAND_APPLIED),
);
/**
 * The effect frames the recorder writes about a tool call: the command it
 * ran, the file it touched, the host it reached (tacho spec §6.1). They are
 * more evidence for the call beside them, not steps of their own.
 */
const EFFECT: ReadonlySet<string> = new Set(["command", "file_io", "network"]);
/**
 * The harness's own permission check (Claude Code's `tool_decision`). It is
 * evidence about the call and never Oxagen's verdict, so only a refusal
 * changes how the entry reads.
 */
const HARNESS = "harness_permission";
/** A decision word that refuses the call. */
const DENIED = /^(deny|denied|reject|rejected|refused)$/;
/** A decision word that holds the call until someone answers it. */
const ASK = /^(ask|approve|approval|approval_required|pending|parked)$/;
/** Frames that record someone answering an approval. */
const ANSWER: ReadonlySet<string> = new Set([
  "approval_decision",
  "tool.approval_recorded",
  "token_denied",
]);
/** Frames that frame the run rather than record what it did. */
const CONTROL: ReadonlySet<string> = new Set([
  "agent_start",
  "agent_stop",
  "steering.manifest",
  "subagent_start",
  "subagent_stop",
  "turn_start",
  "turn_end",
]);
const REPLY: ReadonlySet<string> = new Set(["turn_end", "oxagen:message"]);
/** Decision sources that are the agent's harness checking itself. */
const HARNESS_SOURCES: ReadonlySet<string> = new Set([
  "harness",
  "managed_settings",
]);

const chainOf = (frame: RunFrame): string => frame.chain?.sessionUuid ?? "";
const callOf = (frame: RunFrame): string | null => frame.identity.callId;

function isControl(type: string): boolean {
  return (
    CONTROL.has(type) ||
    type.startsWith("oxagen:") ||
    type.startsWith("admission.")
  );
}

function addCost(sum: number | null, cost: number | null): number | null {
  if (cost === null) return sum;
  return (sum ?? 0) + cost;
}

function decisionOf(frame: RunFrame): TranscriptDecision | null {
  if (!POLICY_TYPES.has(frame.type)) return null;
  return {
    seq: frame.seq,
    ...(frame.chain === undefined
      ? {}
      : { sessionUuid: frame.chain.sessionUuid }),
    decision: frame.identity.policy ?? frame.type,
    type: frame.type,
    source: frame.identity.policySource ?? null,
    at: frame.observedAt,
  };
}

/**
 * The decision `frame` records about the call an entry holds. An operator
 * command is about the run, not about any one call, so folding it into a
 * step or a turn does not make it that entry's decision. It is the decision
 * of the entry it opens.
 */
function callDecisionOf(frame: RunFrame): TranscriptDecision | null {
  return frame.type === COMMAND_APPLIED ? null : decisionOf(frame);
}

/** The word a decision recorded; null when the frame recorded only its type. */
function wordOf(gate: TranscriptDecision): string | null {
  return gate.decision === gate.type ? null : gate.decision;
}

/** A frame with nothing to read on it: no call half, no decision, no kept boundary body. */
function isBare(frame: RunFrame): boolean {
  return (
    stepKind(frame) === null &&
    !POLICY_TYPES.has(frame.type) &&
    boundaryHalf(frame) === null
  );
}

function harnessRefused(frame: RunFrame): boolean {
  return frame.type === HARNESS && DENIED.test(frame.identity.policy ?? "");
}

// ── Grouping ────────────────────────────────────────────────────────────────

type Tag = "model" | "tool" | "event";

interface Group {
  indexes: number[];
  tag: Tag;
}

/** The steps of the frames in `[from, to)`, one turn's worth. */
function groupTurn(frames: readonly RunFrame[], from: number, to: number) {
  const byKey = new Map<string, number[]>();
  for (let i = from; i < to; i += 1) {
    const key = callOf(frames[i] as RunFrame);
    if (key === null) continue;
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [i]);
    else list.push(i);
  }
  const claimed = new Set<number>();
  const at = (i: number) => frames[i] as RunFrame;

  /** The effect frames right after `indexes` that belong to its call. */
  const withEffects = (
    indexes: number[],
    key: string | null,
    chain: string,
  ): number[] => {
    const out = [...indexes];
    for (let j = Math.max(...indexes) + 1; j < to; j += 1) {
      const next = at(j);
      if (!EFFECT.has(next.type) || claimed.has(j)) break;
      if (chainOf(next) !== chain || callOf(next) !== key) break;
      out.push(j);
    }
    return out;
  };

  /** Rule 1: every frame of one tool call, gathered on its key. */
  const callGroup = (i: number): Group | null => {
    const first = at(i);
    const key = callOf(first);
    if (key === null || stepKind(first) === "model_call") return null;
    const chain = chainOf(first);
    const indexes = (byKey.get(key) ?? []).filter(
      (j) =>
        j >= i &&
        !claimed.has(j) &&
        stepKind(at(j)) !== "model_call" &&
        chainOf(at(j)) === chain,
    );
    if (!indexes.some((j) => stepKind(at(j)) === "tool_call")) return null;
    return { indexes: withEffects(indexes, key, chain), tag: "tool" };
  };

  /** Rule 2: the next response of `type` that no other request took. */
  const closeOf = (i: number, type: string): number | null => {
    const first = at(i);
    const key = callOf(first);
    if (key === null) {
      const j = i + 1;
      const next = frames[j];
      return j < to &&
        next !== undefined &&
        !claimed.has(j) &&
        next.type === type &&
        callOf(next) === null &&
        chainOf(next) === chainOf(first)
        ? j
        : null;
    }
    for (const j of byKey.get(key) ?? []) {
      if (j <= i || claimed.has(j)) continue;
      if (at(j).type === type && chainOf(at(j)) === chainOf(first)) return j;
    }
    return null;
  };

  const pairGroup = (i: number): Group => {
    const first = at(i);
    const chain = chainOf(first);
    const modelClose = MODEL_CLOSE[first.type];
    if (modelClose !== undefined) {
      const j = closeOf(i, modelClose);
      return { indexes: j === null ? [i] : [i, j], tag: "model" };
    }
    const toolClose = TOOL_CLOSE[first.type];
    if (toolClose !== undefined) {
      // Rule 3. A keyed request never reaches here: rule 1 gathered it.
      const indexes = [i];
      for (let j = i + 1; j < to; j += 1) {
        const next = at(j);
        if (claimed.has(j) || chainOf(next) !== chain || callOf(next) !== null)
          break;
        if (next.type === toolClose) {
          indexes.push(j);
          return { indexes: withEffects(indexes, null, chain), tag: "tool" };
        }
        if (!TOOL_GATE.has(next.type)) break;
        indexes.push(j);
      }
      return { indexes, tag: "tool" };
    }
    // Rule 4.
    const kind = stepKind(first);
    if (kind === "model_call") return { indexes: [i], tag: "model" };
    if (kind === "tool_call")
      return { indexes: withEffects([i], callOf(first), chain), tag: "tool" };
    // Rule 5.
    const indexes = [i];
    if (isBare(first)) {
      for (let j = i + 1; j < to; j += 1) {
        const next = at(j);
        if (
          claimed.has(j) ||
          !isBare(next) ||
          next.type !== first.type ||
          callOf(next) !== callOf(first) ||
          chainOf(next) !== chain
        )
          break;
        indexes.push(j);
      }
    }
    // Rule 6 is the same shape with one frame.
    return { indexes, tag: "event" };
  };

  const groups: Group[] = [];
  for (let i = from; i < to; i += 1) {
    if (claimed.has(i)) continue;
    const group = callGroup(i) ?? pairGroup(i);
    for (const j of group.indexes) claimed.add(j);
    group.indexes.sort((a, b) => a - b);
    groups.push(group);
  }
  return groups;
}

/** Every step of `frames`, turn by turn, in the order each step opens. */
function groupSteps(
  frames: readonly RunFrame[],
  turns: readonly (number | null)[],
): Group[] {
  const out: Group[] = [];
  let from = 0;
  for (let i = 1; i <= frames.length; i += 1) {
    if (i < frames.length && turns[i] === turns[from]) continue;
    out.push(...groupTurn(frames, from, i));
    from = i;
  }
  return out;
}

// ── Facts ───────────────────────────────────────────────────────────────────

/**
 * A call's two halves: the first request frame and the first frame that came
 * back, each preferring a copy whose body was kept over a digest-only one.
 */
function halvesOf(members: readonly RunFrame[]): {
  request: RunFrame | null;
  response: RunFrame | null;
} {
  const pick = (list: RunFrame[]) =>
    list.find((frame) => frame.body.bodyRef !== null) ?? list[0] ?? null;
  const halves = members.filter((frame) => stepKind(frame) !== null);
  return {
    request: pick(halves.filter((frame) => frame.phase === "request")),
    response: pick(halves.filter((frame) => frame.phase !== "request")),
  };
}

function elapsed(from: RunFrame, to: RunFrame): number {
  return Math.max(0, to.observedAt.getTime() - from.observedAt.getTime());
}

type Facts = Pick<
  TranscriptFold,
  | "node"
  | "quiet"
  | "outcome"
  | "approvalId"
  | "subject"
  | "family"
  | "model"
  | "durationMs"
>;

function toolFacts(
  members: readonly RunFrame[],
  gates: readonly TranscriptDecision[],
  kinds: ReadonlySet<TranscriptKind>,
): Facts {
  const close =
    members.find(
      (frame) => stepKind(frame) === "tool_call" && frame.phase !== "request",
    ) ?? null;
  const status = close?.identity.toolStatus ?? null;
  const words = gates.flatMap((gate) => wordOf(gate) ?? []);
  const denied =
    words.some((word) => DENIED.test(word)) ||
    members.some(harnessRefused) ||
    (status !== null && DENIED.test(status));
  const failed =
    kinds.has("errors") || (status !== null && FAILED_OUTCOMES.has(status));
  const asked =
    members.some((frame) => frame.type === "approval_request") ||
    words.some((word) => ASK.test(word));
  const answered =
    members.some((frame) => ANSWER.has(frame.type)) ||
    words.some((word) => !ASK.test(word));
  const parkedClose = status === "parked";
  const parked = parkedClose || (close === null && asked && !answered);
  const subject =
    [close, ...members]
      .map((frame) => frame?.identity.tool ?? null)
      .find((tool) => tool !== null) ?? null;
  const last = members[members.length - 1] as RunFrame;
  return {
    node: "tool",
    quiet: false,
    outcome: denied
      ? "denied"
      : failed
        ? "failed"
        : parked
          ? "parked"
          : close === null
            ? "pending"
            : "ok",
    approvalId: parkedClose ? (close?.identity.approvalId ?? null) : null,
    subject,
    family: subject === null ? null : toolFamilyOf(subject),
    model: null,
    // A call with no result has taken no time the record can state: the gap
    // to its last gate frame is a wait, not the call.
    durationMs:
      close === null || members.length < 2
        ? null
        : elapsed(members[0] as RunFrame, last),
  };
}

function modelFacts(
  members: readonly RunFrame[],
  halves: { request: RunFrame | null; response: RunFrame | null },
  kinds: ReadonlySet<TranscriptKind>,
): Facts {
  const last = members[members.length - 1] as RunFrame;
  return {
    node: "model",
    quiet: false,
    outcome: kinds.has("errors")
      ? "failed"
      : halves.response === null
        ? "pending"
        : "ok",
    approvalId: null,
    subject: null,
    family: null,
    model:
      members
        .map((frame) => frame.identity.model)
        .find((model) => model !== null) ?? null,
    durationMs:
      members.length < 2 ? null : elapsed(members[0] as RunFrame, last),
  };
}

function eventNode(opening: RunFrame): TranscriptNode {
  if (opensRunTurn(opening)) return "prompt";
  if (REPLY.has(opening.type)) return "reply";
  if (RECALL_TYPES.has(opening.type)) return "recall";
  if (stopsRun(opening)) return "seal";
  if (POLICY_TYPES.has(opening.type)) return "policy";
  if (isControl(opening.type)) return "control";
  return "event";
}

function eventFacts(
  members: readonly RunFrame[],
  gates: readonly TranscriptDecision[],
  kinds: ReadonlySet<TranscriptKind>,
  halves: { request: RunFrame | null; response: RunFrame | null },
): Facts {
  const opening = members[0] as RunFrame;
  const last = members[members.length - 1] as RunFrame;
  const node = eventNode(opening);
  const denied =
    members.some(harnessRefused) ||
    gates.some((gate) => DENIED.test(wordOf(gate) ?? ""));
  const outcome = denied ? "denied" : kinds.has("errors") ? "failed" : null;
  const quiet =
    node === "prompt"
      ? halves.request === null
      : node === "reply"
        ? halves.response === null
        : node === "recall" || node === "seal"
          ? false
          : gates.length === 0 && outcome === null;
  const subject =
    TOOL_GATE.has(opening.type) || opening.type === HARNESS
      ? opening.identity.tool
      : null;
  return {
    node,
    quiet,
    outcome,
    approvalId: null,
    subject,
    family: null,
    model: null,
    durationMs:
      members.length < 2 ? null : elapsed(members[0] as RunFrame, last),
  };
}

/** The entry `group` holds, with every fact the fold states about it. */
function stepFold(
  frames: readonly RunFrame[],
  group: Group,
  turns: readonly (number | null)[],
): TranscriptFold {
  const { indexes, tag } = group;
  const members = indexes.map((i) => frames[i] as RunFrame);
  const opening = members[0] as RunFrame;
  const last = members[members.length - 1] as RunFrame;
  let costMicros: number | null = null;
  let usage: FrameUsage | null = null;
  const kinds = new Set<TranscriptKind>();
  const gates: TranscriptDecision[] = [];
  for (const frame of members) {
    costMicros = addCost(costMicros, frame.costMicros);
    usage = addFrameUsage(usage, frame.usage);
    for (const kind of frameKinds(frame)) kinds.add(kind);
    const gate = frame === opening ? decisionOf(frame) : callDecisionOf(frame);
    if (gate !== null) gates.push(gate);
  }
  const decision = gates[gates.length - 1] ?? null;
  if (decision !== null) kinds.add("policy");
  const slot = boundaryHalf(opening);
  const halves =
    tag === "event"
      ? {
          request: slot === "request" ? opening : null,
          response: slot === "response" ? opening : null,
        }
      : halvesOf(members);
  const facts =
    tag === "tool"
      ? toolFacts(members, gates, kinds)
      : tag === "model"
        ? modelFacts(members, halves, kinds)
        : eventFacts(members, gates, kinds, halves);
  return {
    opening,
    endSeq: last.seq,
    last,
    members,
    span: {
      open: indexes[0] as number,
      end: indexes[indexes.length - 1] as number,
    },
    kind:
      tag === "model"
        ? "model_call"
        : tag === "tool"
          ? "tool_call"
          : POLICY_TYPES.has(opening.type)
            ? "policy"
            : "frame",
    frames: members.length,
    costMicros,
    usage,
    request: halves.request,
    response: halves.response,
    decision,
    gates,
    kinds,
    key: frameKey(opening),
    turn: turns[indexes[0] as number] ?? null,
    parentKey: null,
    echoOf: null,
    ...facts,
  };
}

/**
 * Each subagent entry's parent: the entry that holds the call its chain was
 * spawned by (`FrameChain.spawnToolUseId`), or else the latest entry on the
 * parent chain that recorded a `subagent_start`. Entries are visited in
 * order, so a parent is always an earlier entry, and a late subagent entry
 * still finds its call wherever the page puts it (#4083).
 */
function nestSubagents(folds: readonly TranscriptFold[]): void {
  const owner = new Map<string, TranscriptFold>();
  const spawner = new Map<string, TranscriptFold>();
  const chains = new Set<string>();
  for (const fold of folds) {
    const chain = fold.opening.chain;
    if (chain !== undefined) {
      const parentChain =
        chain.parentSessionUuid !== null && chains.has(chain.parentSessionUuid)
          ? chain.parentSessionUuid
          : "";
      const parent =
        (chain.spawnToolUseId === null
          ? undefined
          : owner.get(chain.spawnToolUseId)) ?? spawner.get(parentChain);
      if (parent !== undefined && chainOf(parent.opening) !== chain.sessionUuid)
        fold.parentKey = parent.key;
      chains.add(chain.sessionUuid);
    }
    for (const frame of fold.members) {
      const key = callOf(frame);
      if (key !== null && !owner.has(key)) owner.set(key, fold);
    }
    if (fold.members.some((frame) => frame.type === "subagent_start"))
      spawner.set(chainOf(fold.opening), fold);
  }
}

/**
 * Each reply that repeats an earlier entry of its turn byte for byte. On the
 * run's own chain, a message whose body is the operator's prompt is that
 * prompt again (a run recorded before #4051 sealed the transcript's copy of
 * it). On any chain, a reply identical to the reply before it is the same
 * words twice. Bodies compare by their recorded digest.
 */
function markEchoes(folds: readonly TranscriptFold[]): void {
  let turn: number | null | undefined;
  let prompts = new Map<string, string>();
  let previous = null as { digest: string; key: string } | null;
  for (const fold of folds) {
    if (fold.turn !== turn) {
      turn = fold.turn;
      prompts = new Map();
      previous = null;
    }
    if (fold.node === "prompt") {
      const digest = fold.request?.body.bodyDigest ?? null;
      if (digest !== null && !prompts.has(digest))
        prompts.set(digest, fold.key);
      continue;
    }
    if (fold.node !== "reply") continue;
    const digest = fold.response?.body.bodyDigest ?? null;
    if (digest === null) continue;
    const prompt =
      fold.opening.chain === undefined ? prompts.get(digest) : undefined;
    if (prompt !== undefined) fold.echoOf = prompt;
    else if (previous?.digest === digest) fold.echoOf = previous.key;
    else previous = { digest, key: fold.key };
  }
}

function withRelations(folds: TranscriptFold[]): TranscriptFold[] {
  nestSubagents(folds);
  markEchoes(folds);
  return folds;
}

// ── Zooms ───────────────────────────────────────────────────────────────────

/** The `steps` zoom: one entry per step, by the rules at the top of this file. */
export function stepFolds(frames: readonly RunFrame[]): TranscriptFold[] {
  const turns = turnOrdinals(frames);
  return withRelations(
    groupSteps(frames, turns).map((group) => stepFold(frames, group, turns)),
  );
}

/**
 * The `everything` zoom: one entry per frame, each read as a step of one
 * frame.
 *
 * A call's request frame on its own says what went out and nothing about how
 * the call ended, so its outcome is null rather than `pending`: the call it
 * opens may well have completed in a later frame.
 */
export function frameFolds(frames: readonly RunFrame[]): TranscriptFold[] {
  const turns = turnOrdinals(frames);
  return withRelations(
    frames.map((frame, i) => {
      const kind = stepKind(frame);
      const fold = stepFold(
        frames,
        {
          indexes: [i],
          tag:
            kind === "model_call"
              ? "model"
              : kind === "tool_call"
                ? "tool"
                : "event",
        },
        turns,
      );
      if (kind !== null && frame.phase === "request") fold.outcome = null;
      return fold;
    }),
  );
}

/**
 * The `turns` zoom: `steps` grouped by turn. A turn's request is the
 * operator's prompt, or the first request of a step on the run's own chain
 * when the prompt kept no body. Its response is the last reply on the run's
 * own chain: the last model response or reported message. Frames before the
 * first turn are one entry of their own.
 */
export function turnFolds(
  frames: readonly RunFrame[],
  steps: readonly TranscriptFold[],
): TranscriptFold[] {
  const position = new Map(frames.map((frame, i) => [frame, i]));
  const at = (frame: RunFrame) => position.get(frame) ?? -1;
  const out: TranscriptFold[] = [];
  let start = 0;
  for (let i = 1; i <= steps.length; i += 1) {
    const head = steps[start] as TranscriptFold;
    if (i < steps.length && (steps[i] as TranscriptFold).turn === head.turn)
      continue;
    const group = steps.slice(start, i);
    start = i;
    const members = group
      .flatMap((step) => step.members)
      .sort((a, b) => at(a) - at(b));
    const opening = members[0] as RunFrame;
    const last = members[members.length - 1] as RunFrame;
    const own = group.filter((step) => step.opening.chain === undefined);
    const gates = members.flatMap((frame) => {
      const gate =
        frame === opening ? decisionOf(frame) : callDecisionOf(frame);
      return gate === null ? [] : [gate];
    });
    const kinds = new Set<TranscriptKind>();
    let costMicros: number | null = null;
    let usage: FrameUsage | null = null;
    for (const step of group) {
      for (const kind of step.kinds) kinds.add(kind);
      costMicros = addCost(costMicros, step.costMicros);
      usage = addFrameUsage(usage, step.usage);
    }
    const replies = own.filter(
      (step) =>
        (step.node === "model" || step.node === "reply") &&
        step.response !== null,
    );
    out.push({
      opening,
      endSeq: last.seq,
      last,
      members,
      span: { open: at(opening), end: at(last) },
      kind: "turn",
      frames: members.length,
      costMicros,
      usage,
      request:
        own.find((step) => step.node === "prompt")?.request ??
        own.find((step) => step.request !== null)?.request ??
        null,
      response: replies[replies.length - 1]?.response ?? null,
      decision: gates[gates.length - 1] ?? null,
      gates,
      kinds,
      key: frameKey(opening),
      turn: head.turn,
      parentKey: null,
      node: null,
      quiet: false,
      outcome: null,
      approvalId: null,
      subject: null,
      family: null,
      model: null,
      durationMs: members.length < 2 ? null : elapsed(opening, last),
      echoOf: null,
    });
  }
  return out;
}

/** The transcript at a zoom level (see the top of this file). */
export function foldTranscript(
  frames: readonly RunFrame[],
  zoom: TranscriptZoom,
): TranscriptFold[] {
  if (frames.length === 0) return [];
  switch (zoom) {
    case "everything":
      return frameFolds(frames);
    case "steps":
      return stepFolds(frames);
    case "turns":
      return turnFolds(frames, stepFolds(frames));
  }
}

// ── Reading the folded run ──────────────────────────────────────────────────

/**
 * The entries a chip selection keeps, in order. The fold runs first, so a
 * filtered transcript shows the same steps as an unfiltered one, only fewer
 * of them. An empty selection keeps everything: no chip pressed is not the
 * same as every chip pressed off.
 */
export function filterFoldsByKind(
  folds: readonly TranscriptFold[],
  kinds: readonly TranscriptKind[],
): TranscriptFold[] {
  if (kinds.length === 0) return [...folds];
  const wanted = new Set<TranscriptKind>(kinds);
  return folds.filter((fold) => [...fold.kinds].some((k) => wanted.has(k)));
}

/** What a folded run holds, counted over every entry whatever the chips. */
export interface TranscriptCounts {
  /** Entries per chip. An entry that answers two chips counts under both. */
  kinds: Record<TranscriptKind, number>;
  /** Entries that have something to show (`quiet` false). */
  entries: number;
  /** Entries that failed or were refused, or that answer the errors chip. */
  errors: number;
  /** Decisions a rule or a person made; the harness checking itself is not one. */
  policy: number;
}

export function transcriptCounts(
  folds: readonly TranscriptFold[],
  vocabulary: readonly TranscriptKind[],
): TranscriptCounts {
  const kinds = Object.fromEntries(
    vocabulary.map((kind) => [kind, 0]),
  ) as Record<TranscriptKind, number>;
  let entries = 0;
  let errors = 0;
  let policy = 0;
  for (const fold of folds) {
    for (const kind of fold.kinds) kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (!fold.quiet) entries += 1;
    if (
      fold.outcome === "failed" ||
      fold.outcome === "denied" ||
      fold.kinds.has("errors")
    )
      errors += 1;
    const source = fold.decision?.source ?? null;
    if (
      fold.kinds.has("policy") &&
      (source === null || !HARNESS_SOURCES.has(source))
    )
      policy += 1;
  }
  return { kinds, entries, errors, policy };
}

/** A `tool_use` block of a model's reply, as far as claiming it needs. */
export interface ToolUseRef {
  name: string;
  callKey: string | null;
}

/**
 * Which tool step recorded each `tool_use` block of a model step's reply, so
 * a reader draws the call once, as that step. A block and a step with the
 * same call key are the same call. Where either side kept no key, the block
 * is the next tool step of the same name in the turn, after the reply, that
 * no other block claimed. Null for a call no tool step recorded.
 *
 * `steps` are the run's `steps` zoom. The claimer keeps its claims across
 * calls, so one reader passes each model step of the run to it in order.
 */
export function toolUseClaimer(
  steps: readonly TranscriptFold[],
): (model: TranscriptFold, uses: readonly ToolUseRef[]) => (string | null)[] {
  const tools = steps.filter((step) => step.node === "tool");
  const byCall = new Map<string, TranscriptFold>();
  for (const tool of tools)
    for (const frame of tool.members) {
      const key = callOf(frame);
      if (key !== null && !byCall.has(key)) byCall.set(key, tool);
    }
  const claimed = new Set<TranscriptFold>();
  return (model, uses) =>
    uses.map((use) => {
      const keyed = use.callKey === null ? undefined : byCall.get(use.callKey);
      if (keyed !== undefined) return keyed.key;
      const name = bareToolName(use.name);
      const match = tools.find(
        (tool) =>
          tool.turn === model.turn &&
          tool.span.open > model.span.end &&
          !claimed.has(tool) &&
          (callOf(tool.opening) === null || use.callKey === null) &&
          tool.subject !== null &&
          bareToolName(tool.subject) === name,
      );
      if (match === undefined) return null;
      claimed.add(match);
      return match.key;
    });
}

// ── Recall ──────────────────────────────────────────────────────────────────

/** What a recall frame says it put in front of the model. */
export interface TranscriptRecall {
  /** What `count` counts: context frames, or the items a manifest included. */
  unit: "frames" | "items";
  count: number | null;
  tokens: number | null;
  cut: number | null;
  /** The items that reached the model, in the order listed. */
  items: { kind: string; label: string; tokens: number | null }[];
}

/** The most listed items a recall carries; a manifest holds at most this many. */
export const RECALL_ITEM_MAX = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, key: string): string | null {
  const found = isRecord(value) ? value[key] : undefined;
  return typeof found === "string" ? found : null;
}

/** A recorded count: a whole number, never below zero. Anything else is none. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * What a recall frame put in front of the model, read from its kept body:
 * a steering manifest (ADR-093) lists its items with the outcome of each, and
 * a context frame lists its frames. A body that lists neither, or none kept,
 * falls back to the frame count the ledger's `context.frames_selected`
 * records. Only items that reached the model are listed; the rest are
 * counted in `cut`.
 */
export function recallOf(
  frame: RunFrame,
  body: string | null,
): TranscriptRecall {
  let parsed: unknown = null;
  if (body !== null) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
  }
  const items = isRecord(parsed) ? parsed["items"] : undefined;
  const list = Array.isArray(items)
    ? items
    : isRecord(parsed)
      ? parsed["frames"]
      : undefined;
  if (isRecord(parsed) && Array.isArray(list)) {
    const listed = list.filter(isRecord);
    const kept = listed.filter(
      (item) => item["outcome"] === undefined || item["outcome"] === "included",
    );
    // A manifest that records the outcome of each item and no total of what
    // it cut has cut what it listed and did not include.
    const judged = listed.some((item) => item["outcome"] !== undefined);
    return {
      unit: Array.isArray(items) ? "items" : "frames",
      count: count(parsed["included"]) ?? kept.length,
      tokens: count(parsed["spent_tokens"]) ?? count(parsed["tokens"]),
      cut:
        count(parsed["cut"]) ?? (judged ? listed.length - kept.length : null),
      items: kept.slice(0, RECALL_ITEM_MAX).map((item) => ({
        kind: text(item, "kind") ?? text(item, "type") ?? "",
        label:
          text(item, "label") ?? text(item, "id") ?? text(item, "name") ?? "",
        tokens: count(item["tokens"]) ?? count(item["tok"]),
      })),
    };
  }
  return {
    unit: "frames",
    count: count(frame.identity.contextRows),
    tokens: null,
    cut: null,
    items: [],
  };
}
