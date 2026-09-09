/**
 * Journal parsing: NDJSON in, ordered trace events out. Deliberately strict,
 * as upstream is: a malformed line means the recorder is broken, and a broken
 * recorder must fail the run loudly rather than have its unparseable lines
 * quietly skipped.
 */
import { type TraceEvent, traceEventSchema } from "./types";

export class JournalError extends Error {
  constructor(
    message: string,
    readonly line: number | null,
  ) {
    super(message);
    this.name = "JournalError";
  }
}

export interface Journal {
  events: TraceEvent[];
}

export function journalFromNdjson(input: string): Journal {
  const events: TraceEvent[] = [];
  const lines = input.split("\n");
  lines.forEach((line, index) => {
    if (line.trim() === "") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new JournalError(
        `journal line ${index + 1} is not a valid trace event: ${String(error)}`,
        index + 1,
      );
    }
    const result = traceEventSchema.safeParse(parsed);
    if (!result.success) {
      throw new JournalError(
        `journal line ${index + 1} is not a valid trace event: ${result.error.message}`,
        index + 1,
      );
    }
    events.push(result.data);
  });
  if (events.length === 0) {
    throw new JournalError("journal contains no events", null);
  }
  return { events };
}

export function journalToNdjson(journal: Journal): string {
  return `${journal.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function describeJournal(journal: Journal): string {
  const first = journal.events[0];
  const session = first?.session ?? "<empty>";
  if (first?.event === "session_start") {
    return `session ${session} - agent ${first.agent} (harness ${first.harness}), ${journal.events.length} event(s)`;
  }
  return `session ${session}, ${journal.events.length} event(s)`;
}
