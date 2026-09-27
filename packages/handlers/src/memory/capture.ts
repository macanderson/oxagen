// What a sealed run's memory tool calls leave behind (ADR-206, decision 2).
//
// When a run seals, `run.reflect` reads each remember_lesson and
// record_reflection call from the run's frames and hands them here. This
// module checks each input against its contract again, skips a call Oxagen
// denied or that failed, and turns the rest into drafts. The agent and the run
// come from the run record, never from the tool input.
import {
  lessonInputSchema,
  type LessonInput,
} from "@oxagen/oxagen/contracts/agent.memory.lesson.remember";
import {
  reflectionInputSchema,
  type ReflectionInput,
} from "@oxagen/oxagen/contracts/agent.memory.reflection.record";
import {
  BUILTIN_SERVER,
  TOOL_NAME_PATTERN,
  TOOL_SEPARATOR,
} from "@oxagen/oxagen/steering-repo/names";
import { statementHash } from "./statement";
import type {
  MemoryDraft,
  ReflectionDraft,
  ReflectionLesson,
  RunCapture,
} from "./types";

/** The two memory tools, by their bare names. */
export type MemoryTool = "remember_lesson" | "record_reflection";

/** One memory tool call, as the run's frame recorded it. */
export interface MemoryToolCall {
  /** The frame's number in the run. */
  seq: string;
  /** The tool name the frame recorded, such as `mcp__oxagen__remember_lesson`. */
  tool: string;
  /** How the call ended, or null when the frame records no status. */
  status: string | null;
  /** The call's input, already parsed from the frame. */
  input: unknown;
}

/**
 * The statuses of a call that did not complete. A copy of `FAILED_OUTCOMES`
 * in packages/run-ledger/src/run-frames.ts, which the run-ledger package does
 * not export.
 */
export const FAILED_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "denied",
  "cancelled",
  "error",
  "timeout",
  "refused",
  "rejected",
]);

/** A memory tool's bare name at the end of a tool name, after nothing, `__`, `.`, or `/`. */
const MEMORY_TOOL_NAME = /(?:^|__|[./])(remember_lesson|record_reflection)$/;

/**
 * The memory tool a recorded tool name calls, or null for any other tool.
 * `remember_lesson`, `mcp__oxagen__remember_lesson`, and
 * `oxagen.remember_lesson` all name remember_lesson.
 */
export function memoryToolOf(tool: string): MemoryTool | null {
  const match = MEMORY_TOOL_NAME.exec(tool);
  return match === null ? null : (match[1] as MemoryTool);
}

/** The evidence reference for one frame of a run: `frame:<run>/<seq>`. */
export function frameRef(runPublicId: string, seq: string): string {
  return `frame:${runPublicId}/${seq}`;
}

/** The prefix Claude Code puts before an MCP server's tool name. */
const MCP_PREFIX = "mcp__";

/**
 * A tool name without the `mcp__` prefix Claude Code adds.
 * `mcp__billing__create_refund` becomes `billing__create_refund`. The name
 * `mcp__query` is the tool `query` of a server named mcp, so it stays as it is.
 */
export function withoutMcpPrefix(seen: string): string {
  const rest = seen.startsWith(MCP_PREFIX) ? seen.slice(MCP_PREFIX.length) : "";
  return rest.includes(TOOL_SEPARATOR) ? rest : seen;
}

/**
 * A tool name as the agent saw it, mapped to `<server>__<tool>`. Claude Code's
 * `mcp__billing__create_refund` becomes `billing__create_refund`, and
 * `billing__create_refund` stays as it is. A built-in tool such as `Bash` has
 * no server owner, so it maps to null. So does a `builtin__` tool, and any
 * name that is not a tool name once the prefix is gone.
 */
export function serverToolName(seen: string): string | null {
  const name = withoutMcpPrefix(seen);
  if (!TOOL_NAME_PATTERN.test(name)) return null;
  const server = name.slice(0, name.indexOf(TOOL_SEPARATOR));
  return server === BUILTIN_SERVER ? null : name;
}

/**
 * Tool grades keyed `<server>__<tool>`, without the tools that have no server
 * owner. When two names the agent saw map to one tool, the first grade wins.
 */
export function serverToolGrades(
  grades: Readonly<Record<string, number>>,
): Record<string, number> {
  const kept = new Map<string, number>();
  for (const [seen, grade] of Object.entries(grades)) {
    const name = serverToolName(seen);
    if (name !== null && !kept.has(name)) kept.set(name, grade);
  }
  return Object.fromEntries(kept);
}

/** Tool feedback with each tool as `<server>__<tool>`, without the tools that have no server owner. */
export function serverToolFeedback(
  feedback: ReadonlyArray<{ tool: string; problem: string }>,
): Array<{ tool: string; problem: string }> {
  const kept: Array<{ tool: string; problem: string }> = [];
  for (const entry of feedback) {
    const tool = serverToolName(entry.tool);
    if (tool !== null) kept.push({ tool, problem: entry.problem });
  }
  return kept;
}

/** The run a draft belongs to, as the run record gives it. */
interface RunMeta {
  runPublicId: string;
  agentLineage: string | null;
}

/**
 * A contract lesson as a reflection keeps it. Each frame number becomes a
 * frame reference, and a lesson that cites no frame cites the frame of the
 * call that carried it.
 */
function lessonOf(
  input: LessonInput,
  runPublicId: string,
  seq: string,
): ReflectionLesson {
  const cited = [...new Set(input.evidence)].map((frame) =>
    frameRef(runPublicId, String(frame)),
  );
  return {
    statement: input.statement,
    kind: input.kind,
    repos: input.repos,
    applies_to: input.applies_to,
    tools: input.tools,
    evidence: cited.length > 0 ? cited : [frameRef(runPublicId, seq)],
  };
}

/** One lesson as a memory with capture `remember`. */
function memoryDraft(meta: RunMeta, lesson: ReflectionLesson): MemoryDraft {
  const hash = statementHash(lesson.statement);
  return {
    agentLineage: meta.agentLineage,
    runPublicId: meta.runPublicId,
    capture: "remember",
    statement: lesson.statement,
    statementHash: hash,
    kind: lesson.kind,
    repos: lesson.repos ?? null,
    appliesTo: lesson.applies_to ?? null,
    tools: lesson.tools ?? null,
    evidence: lesson.evidence,
    source: null,
    dedupeKey: `${meta.runPublicId}:${hash}`,
  };
}

/**
 * Each lesson of a reflection as a memory, with the reflection's agent and
 * run. The lessons already carry their evidence.
 */
export function lessonMemories(reflection: ReflectionDraft): MemoryDraft[] {
  return reflection.lessons.map((lesson) => memoryDraft(reflection, lesson));
}

/** A record_reflection input as the agent's reflection on its run. */
function reflectionOf(
  input: ReflectionInput,
  meta: RunMeta,
  seq: string,
): ReflectionDraft {
  return {
    runPublicId: meta.runPublicId,
    agentLineage: meta.agentLineage,
    source: "agent",
    outcome: input.outcome,
    summary: input.summary,
    grades: {
      work: input.grades.work,
      tools: serverToolGrades(input.grades.tools),
    },
    lessons: input.lessons.map((lesson) =>
      lessonOf(lesson, meta.runPublicId, seq),
    ),
    toolFeedback: serverToolFeedback(input.tool_feedback ?? []),
  };
}

type Captured =
  | { tool: "remember_lesson"; memory: MemoryDraft }
  | { tool: "record_reflection"; reflection: ReflectionDraft };

/** Did the call fail, or did Oxagen deny it? A call with no status did neither. */
function callFailed(status: string | null): boolean {
  return status !== null && FAILED_STATUSES.has(status);
}

/**
 * The memories and the reflection one sealed run holds. `calls` come in
 * frame order, and a call to any other tool is ignored.
 *
 * A remember_lesson call becomes one memory. When the run holds more than one
 * valid record_reflection call, the last one is the run's reflection, and only
 * its lessons become memories. A memory whose statement the run already gave
 * is dropped, and the first one stays.
 */
export function captureRun(args: {
  runPublicId: string;
  agentLineage: string | null;
  calls: readonly MemoryToolCall[];
}): RunCapture {
  const meta: RunMeta = {
    runPublicId: args.runPublicId,
    agentLineage: args.agentLineage,
  };
  const captured: Captured[] = [];
  let reflection: ReflectionDraft | null = null;
  for (const call of args.calls) {
    if (callFailed(call.status)) continue;
    const tool = memoryToolOf(call.tool);
    if (tool === "remember_lesson") {
      const input = lessonInputSchema.safeParse(call.input);
      if (!input.success) continue;
      const lesson = lessonOf(input.data, meta.runPublicId, call.seq);
      captured.push({ tool, memory: memoryDraft(meta, lesson) });
    } else if (tool === "record_reflection") {
      const input = reflectionInputSchema.safeParse(call.input);
      if (!input.success) continue;
      reflection = reflectionOf(input.data, meta, call.seq);
      captured.push({ tool, reflection });
    }
  }

  const memories: MemoryDraft[] = [];
  const keys = new Set<string>();
  const keep = (draft: MemoryDraft): void => {
    if (keys.has(draft.dedupeKey)) return;
    keys.add(draft.dedupeKey);
    memories.push(draft);
  };
  for (const item of captured) {
    if (item.tool === "remember_lesson") keep(item.memory);
    else if (item.reflection === reflection) {
      for (const draft of lessonMemories(item.reflection)) keep(draft);
    }
  }
  return { memories, reflection };
}
