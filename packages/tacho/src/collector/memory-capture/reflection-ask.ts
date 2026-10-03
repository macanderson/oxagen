/**
 * The reflection ask: at the Stop that ends a Claude Code turn, a run that
 * showed a sign of trouble is asked, once per session, to call the Oxagen
 * MCP tool that records a reflection. The hook handler notes the signals as
 * hooks arrive, and `reflectionAsk` turns them into the Stop's block reason.
 *
 * The state lives in a module-level `WeakMap` keyed by the session record,
 * so `SessionRecord` keeps its shape and the state goes when the record does.
 * A daemon restart starts every session's state over.
 *
 * Signals are noted on spool replays too: a replay is a call the agent made
 * while the daemon was down. Only the ask itself skips a replay, because a
 * replayed Stop's answer reaches no harness.
 *
 * The ask names a tool from Oxagen's MCP server, which enrolling Claude Code
 * adds to Claude Code's user config (`cli/claude-code-mcp.ts`, #5287). A
 * session on a host without that server is never asked.
 */
import { type JsonValue, jcs } from "../../digest";
import { OXAGEN_MCP_SERVER_KEY } from "../../host/mcp-config-writer";
import type { TachoHarness } from "../../wire";
import type { SessionRecord } from "../registry";

/** The tool the ask names, as Claude Code lists an MCP server's tool. */
export const REFLECTION_TOOL_NAME = `mcp__${OXAGEN_MCP_SERVER_KEY}__record_reflection`;

/**
 * Openers that mark a later prompt as a person correcting the agent. The
 * list stays short on purpose: a prompt counts only when it opens with one
 * of these as whole words, so "now run the tests" and "notice the log" do
 * not count.
 */
export const CORRECTION_OPENERS: readonly string[] = [
  "no",
  "nope",
  "wrong",
  "that's wrong",
  "that is not",
  "not what i asked",
  "don't",
  "do not",
  "stop",
  "actually",
  "instead",
  "you didn't",
  "you forgot",
  "you missed",
  "undo",
  "revert",
];

/** How many identical calls in a row count as a retry loop. */
export const RETRY_LOOP_LENGTH = 3;

/** The hard cap on the ask's length. */
export const REFLECTION_ASK_MAX_CHARS = 700;

/** The kinds of trouble a run can show, in the order the ask lists them. */
export type ReflectionSignalKind =
  | "tool_failure"
  | "policy_denial"
  | "retry_loop"
  | "correction";

const SIGNAL_ORDER: readonly ReflectionSignalKind[] = [
  "tool_failure",
  "policy_denial",
  "retry_loop",
  "correction",
];

/** Tool names kept per signal kind for the ask. */
const TOOLS_PER_SIGNAL = 3;

/** Longest tool name the ask prints before it clips the name. */
const TOOL_NAME_MAX_CHARS = 64;

interface SignalCount {
  count: number;
  /** Distinct tool names, first seen first, at most `TOOLS_PER_SIGNAL`. */
  tools: string[];
}

interface ReflectionState {
  signals: Map<ReflectionSignalKind, SignalCount>;
  /** The key of the last tool call, and how many times in a row it came. */
  lastCall: string | undefined;
  repeats: number;
  promptSeen: boolean;
  asked: boolean;
  /** The agent already called `record_reflection`, so there is nothing to ask. */
  reflected: boolean;
}

const states = new WeakMap<SessionRecord, ReflectionState>();

function stateOf(record: SessionRecord): ReflectionState {
  let state = states.get(record);
  if (state === undefined) {
    state = {
      signals: new Map(),
      lastCall: undefined,
      repeats: 0,
      promptSeen: false,
      asked: false,
      reflected: false,
    };
    states.set(record, state);
  }
  return state;
}

function addSignal(
  record: SessionRecord,
  kind: ReflectionSignalKind,
  toolName: string | undefined,
): void {
  const state = stateOf(record);
  const signal = state.signals.get(kind) ?? { count: 0, tools: [] };
  signal.count += 1;
  if (
    toolName !== undefined &&
    toolName.length > 0 &&
    signal.tools.length < TOOLS_PER_SIGNAL &&
    !signal.tools.includes(toolName)
  )
    signal.tools.push(toolName);
  state.signals.set(kind, signal);
}

/** A tool call that failed (Claude Code's `PostToolUseFailure`). */
export function noteToolFailure(
  record: SessionRecord,
  toolName: string | undefined,
): void {
  addSignal(record, "tool_failure", toolName);
}

/** A tool call the policy denied. Operator pauses and steers do not count. */
export function notePolicyDenial(
  record: SessionRecord,
  toolName: string | undefined,
): void {
  addSignal(record, "policy_denial", toolName);
}

/**
 * The key two calls share when they are the same call: the tool name and the
 * JCS text of its input. Undefined when the input has no JCS text, which
 * leaves that call out of retry tracking.
 */
function callKey(toolName: string, toolInput: unknown): string | undefined {
  try {
    const input = toolInput === undefined ? "" : jcs(toolInput as JsonValue);
    return `${toolName}\u0000${input}`;
  } catch {
    return undefined;
  }
}

/**
 * A tool call the agent asked for. The third identical call in a row counts
 * as one retry loop. A fourth or fifth in the same run does not count again.
 * A different call ends the run, so a later run can count once more.
 */
export function noteToolCall(
  record: SessionRecord,
  toolName: string,
  toolInput: unknown,
): void {
  const state = stateOf(record);
  // Any harness's spelling: mcp__oxagen__record_reflection, or a bare name.
  if (toolName === "record_reflection" || toolName.endsWith("__record_reflection"))
    state.reflected = true;
  const key = callKey(toolName, toolInput);
  if (key === undefined) {
    state.lastCall = undefined;
    state.repeats = 0;
    return;
  }
  if (key === state.lastCall) {
    state.repeats += 1;
  } else {
    state.lastCall = key;
    state.repeats = 1;
  }
  if (state.repeats === RETRY_LOOP_LENGTH)
    addSignal(record, "retry_loop", toolName);
}

/**
 * Whether a prompt opens with one of `CORRECTION_OPENERS` as whole words,
 * ignoring case, the whitespace around it, and curly apostrophes.
 */
export function isCorrectionPrompt(prompt: string): boolean {
  const text = prompt.trim().toLowerCase().replace(/[‘’]/g, "'");
  return CORRECTION_OPENERS.some((opener) => {
    if (!text.startsWith(opener)) return false;
    const next = text.charAt(opener.length);
    return next === "" || !/[a-z0-9']/.test(next);
  });
}

/**
 * A prompt the session received. The first prompt of a session opens the
 * work, so it never counts. A later one counts when it opens with a
 * correction.
 */
export function notePrompt(
  record: SessionRecord,
  prompt: string | undefined,
): void {
  const state = stateOf(record);
  if (!state.promptSeen) {
    state.promptSeen = true;
    return;
  }
  if (prompt !== undefined && isCorrectionPrompt(prompt))
    addSignal(record, "correction", undefined);
}

export interface ReflectionAskOptions {
  /** The session's harness. Undefined for an agent Oxagen cannot ask. */
  harness: TachoHarness | undefined;
  /** Claude Code's `stop_hook_active`: this Stop follows a block. */
  stopHookActive: boolean;
  /** The hook is a spool replay or a deferred hook. */
  replayed: boolean;
  /**
   * Whether the session can reach `REFLECTION_TOOL_NAME`: this enrollment
   * wrote the `oxagen` server into Claude Code's user config and has the key
   * the gateway serves Oxagen's tools with (#5287). Without both, an ask
   * would block a stop for a tool the agent cannot call. Called only once
   * every cheaper check has passed, because it reads a file.
   */
  toolRegistered: () => boolean;
}

function clipTool(name: string): string {
  return name.length > TOOL_NAME_MAX_CHARS
    ? `${name.slice(0, TOOL_NAME_MAX_CHARS - 3)}...`
    : name;
}

function signalPhrase(
  kind: ReflectionSignalKind,
  signal: SignalCount,
  withTools: boolean,
): string {
  const one = signal.count === 1;
  const label =
    kind === "tool_failure"
      ? one
        ? "a failed tool call"
        : `${signal.count} failed tool calls`
      : kind === "policy_denial"
        ? one
          ? "a call the policy denied"
          : `${signal.count} calls the policy denied`
        : kind === "retry_loop"
          ? one
            ? `a call repeated ${RETRY_LOOP_LENGTH} times in a row`
            : `${signal.count} calls repeated ${RETRY_LOOP_LENGTH} times in a row`
          : one
            ? "a prompt that corrected you"
            : `${signal.count} prompts that corrected you`;
  return withTools && signal.tools.length > 0
    ? `${label} (${signal.tools.map(clipTool).join(", ")})`
    : label;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function askText(state: ReflectionState, withTools: boolean): string {
  const phrases: string[] = [];
  for (const kind of SIGNAL_ORDER) {
    const signal = state.signals.get(kind);
    if (signal !== undefined) phrases.push(signalPhrase(kind, signal, withTools));
  }
  return [
    `This run had ${joinList(phrases)}.`,
    `Before you finish, call ${REFLECTION_TOOL_NAME} once to record a reflection.`,
    "Give the outcome, a one-paragraph summary, a grade from 1 to 5 for the work, a grade from 1 to 5 for each tool you used, lessons with frame numbers where you know them, and any problem with a tool's description.",
    "Stop after the call.",
    "Skip the call only if the tool is not available.",
  ].join(" ");
}

/**
 * The text a Stop hands the agent to ask for a reflection, or undefined.
 * It asks only a Claude Code session, only at a Stop that does not follow a
 * block and is not a replay, only when the run showed a signal and the agent
 * has not already called `record_reflection`, only when the session can
 * reach that tool, and only once per session. The session is marked asked
 * before the text returns. A Stop that finds the tool missing does not use
 * up the ask.
 */
export function reflectionAsk(
  record: SessionRecord,
  options: ReflectionAskOptions,
): string | undefined {
  if (
    options.harness !== "claude-code" ||
    options.stopHookActive ||
    options.replayed
  )
    return undefined;
  const state = states.get(record);
  if (
    state === undefined ||
    state.asked ||
    state.reflected ||
    state.signals.size === 0
  )
    return undefined;
  if (!options.toolRegistered()) return undefined;
  state.asked = true;
  const full = askText(state, true);
  return full.length <= REFLECTION_ASK_MAX_CHARS
    ? full
    : askText(state, false);
}
