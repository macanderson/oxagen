// The title a harness gave its own session. Claude Code writes an `ai-title`
// line each time it renames a session, and the collector seals each one as an
// `oxagen:session_title` frame whose body is `{ session_title }`. An
// `agent_start` body can carry the same field from the session inventory.
// The operator already sees this title in their terminal, so the Run page
// shows it ahead of any name Oxagen wrote.

type TitledEvent = { ts: string; body?: unknown };

export interface HarnessTitle {
  title: string;
  at: Date;
}

/**
 * The latest non-blank `session_title` in a batch, by frame time. The kind is
 * not checked: any frame whose body names the session title counts. Returns
 * null when no frame carries one.
 */
export function latestHarnessTitle(
  events: readonly TitledEvent[],
): HarnessTitle | null {
  let latest: HarnessTitle | null = null;
  for (const event of events) {
    const body = event.body;
    if (typeof body !== "object" || body === null) continue;
    const raw = (body as Record<string, unknown>)["session_title"];
    if (typeof raw !== "string") continue;
    const title = raw.trim();
    if (title.length === 0) continue;
    const at = new Date(event.ts);
    if (Number.isNaN(at.getTime())) continue;
    if (latest === null || at.getTime() >= latest.at.getTime()) {
      latest = { title, at };
    }
  }
  return latest;
}
