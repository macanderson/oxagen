// feedback.ts: agent feedback for get_studio_server (#4678, part 4;
// mcp-studio-spec, Feedback; ADR-234).
//
// Two signals show where a tool confuses agents. The gateway's counts come
// from ClickHouse `served_tool_calls`: calls, schema rejections, error
// results, and retries per tool. The notes come from reflections'
// `tool_feedback` in Postgres, each naming a tool and the problem an agent
// had with it.
//
// Both name a tool by its full served name, `<folder>__<key>`, the name
// compile gives it. The output names it by the tools.toml key.
import { schema, withTenantDb } from "@oxagen/database";
import type { ToolStudioServerGetOutput } from "@oxagen/oxagen/contracts/tool.studio.server.get";
import { readServedToolFeedback, type ServedToolFeedback } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { logger } from "../../logger";
import type { DiscoveryScope } from "./types";

/** How far back the feedback reads, in days. list_tool_versions reads calls30d the same way. */
export const FEEDBACK_WINDOW_DAYS = 30;

/** The most notes one tool shows. */
export const NOTES_PER_TOOL = 5;

/** The most reflections with tool feedback one read scans, newest first. */
export const REFLECTIONS_READ = 200;

type Feedback = ToolStudioServerGetOutput["feedback"];

/** One reflection's note about one tool. */
export interface ToolNote {
  /** The full tool name: billing__create_refund. */
  tool: string;
  problem: string;
}

export interface ToolFeedbackReader {
  /** The gateway's counts per full tool name, or null when ClickHouse did not answer. */
  counts(scope: DiscoveryScope, server: string, windowDays: number): Promise<readonly ServedToolFeedback[] | null>;
  /** Reflections' notes about any tool, newest first, within the window. */
  notes(scope: DiscoveryScope, windowDays: number): Promise<readonly ToolNote[]>;
}

function noteEntries(value: unknown): ToolNote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { tool, problem } = entry as Record<string, unknown>;
    return typeof tool === "string" && typeof problem === "string" ? [{ tool, problem }] : [];
  });
}

/** The reader get_studio_server uses in production. */
export const liveToolFeedbackReader: ToolFeedbackReader = {
  async counts(scope, server, windowDays) {
    try {
      return await runInTenantScope(scope, () => readServedToolFeedback({ server, windowDays }));
    } catch (error) {
      // The panel draws the counts as not recorded. The rest of the folder
      // still answers.
      logger.warn({ err: error, server }, "get_studio_server: ClickHouse did not answer, so the feedback counts are null");
      return null;
    }
  },
  async notes(scope, windowDays) {
    const t = schema.memoryReflections;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const rows = await runInTenantScope(scope, () =>
      withTenantDb((tx) =>
        tx
          .select({ toolFeedback: t.toolFeedback })
          .from(t)
          .where(
            and(
              eq(t.orgId, scope.orgId),
              eq(t.workspaceId, scope.workspaceId),
              gte(t.createdAt, since),
              sql`${t.toolFeedback} <> '[]'::jsonb`,
            ),
          )
          .orderBy(desc(t.createdAt), desc(t.id))
          .limit(REFLECTIONS_READ),
      ),
    );
    return rows.flatMap((row) => noteEntries(row.toolFeedback));
  },
};

/**
 * Each tools.toml key's feedback, in the order the keys are given. A key with
 * no call in the window reads zeros when the counts answered. Notes keep
 * their order, newest first, with repeats dropped and at most NOTES_PER_TOOL.
 */
export function feedbackOf(
  server: string,
  keys: readonly string[],
  counts: readonly ServedToolFeedback[] | null,
  notes: readonly ToolNote[],
): Feedback {
  const byTool = new Map((counts ?? []).map((row) => [row.tool, row]));
  const notesByTool = new Map<string, string[]>();
  for (const note of notes) {
    const kept = notesByTool.get(note.tool) ?? [];
    if (kept.length < NOTES_PER_TOOL && !kept.includes(note.problem)) kept.push(note.problem);
    notesByTool.set(note.tool, kept);
  }
  return {
    windowDays: FEEDBACK_WINDOW_DAYS,
    tools: keys.map((key) => {
      const full = `${server}__${key}`;
      const row = byTool.get(full);
      return {
        tool: key,
        counts:
          counts === null
            ? null
            : {
                calls: row?.calls ?? 0,
                schemaRejections: row?.schemaRejections ?? 0,
                errorResults: row?.errorResults ?? 0,
                retries: row?.retries ?? 0,
              },
        notes: notesByTool.get(full) ?? [],
      };
    }),
  };
}
