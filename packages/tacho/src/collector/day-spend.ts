/**
 * An agent's observed spend for one UTC day, for the per-day budget (ADR-160).
 *
 * A day is a UTC calendar day, and a call counts toward the day in the
 * timestamp of the frame that records it. The proxy stamps the `llm_call`
 * frame and charges this counter from the same clock read, so the record and
 * the refusal can never disagree about which day a call belonged to.
 *
 * The day's total has three parts:
 *
 *   - This host's calls, read back from its own WAL the first time a day is
 *     asked about. The WAL keeps a week of frames, shipped or not, so a daemon
 *     that restarts at noon still counts its morning.
 *   - Calls this proxy priced since that read, added as they settle.
 *   - What the control plane recorded for the agent that day: its other
 *     hosts' total, and this host's shipped total. The second covers a host
 *     whose WAL was wiped. This host's share is the larger of what it counted
 *     and what the control plane holds, because each is a lower bound on the
 *     truth and neither counts a call twice.
 *
 * Every read here fails open. A fault of Oxagen's (an unreadable WAL, no
 * answer from the control plane) counts as zero rather than stopping a call.
 */

/** The UTC calendar day an instant falls in, as `YYYY-MM-DD`. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The instant the UTC day after `day` begins, as an ISO timestamp. */
export function nextUtcDayStart(day: string): string {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(start + 24 * 60 * 60_000).toISOString();
}

/**
 * The control plane's figures for an agent's day. `day` is the UTC day they
 * were computed for; a figure for any other day is ignored, so a host that
 * slept across midnight never counts yesterday against today.
 */
export interface RecordedDaySpend {
  day: string;
  thisHostMicros: number;
  otherHostsMicros: number;
}

export interface DaySpendDeps {
  /** This host's observed spend on `day`, read from its WAL. */
  priorDaySpendMicros?: (day: string) => number;
  /** The control plane's latest figures, when it has sent any. */
  recordedDaySpend?: () => RecordedDaySpend | undefined;
}

export interface DaySpend {
  /** The agent's observed spend on `day`, in micro-USD. */
  total: (day: string) => number;
  /** Charge one priced call to `day`. */
  add: (day: string, micros: number) => void;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function createDaySpend(deps: DaySpendDeps): DaySpend {
  // One day at a time. The counter only moves forward: a call for an earlier
  // day than the one held (a clock stepped back) is charged to the day held,
  // never used to reopen a day already left.
  let held: { day: string; ownMicros: number } | undefined;

  function own(day: string): number {
    if (held !== undefined && held.day >= day) return held.ownMicros;
    let seeded = 0;
    try {
      seeded = nonNegative(deps.priorDaySpendMicros?.(day) ?? 0);
    } catch {
      seeded = 0;
    }
    held = { day, ownMicros: seeded };
    return seeded;
  }

  function recorded(day: string): RecordedDaySpend | undefined {
    let figures: RecordedDaySpend | undefined;
    try {
      figures = deps.recordedDaySpend?.();
    } catch {
      return undefined;
    }
    return figures?.day === day ? figures : undefined;
  }

  return {
    total(day) {
      const counted = own(day);
      const plane = recorded(day);
      if (plane === undefined) return counted;
      return (
        Math.max(counted, nonNegative(plane.thisHostMicros)) +
        nonNegative(plane.otherHostsMicros)
      );
    },
    add(day, micros) {
      const current = own(day);
      if (held !== undefined) held.ownMicros = current + nonNegative(micros);
    },
  };
}
