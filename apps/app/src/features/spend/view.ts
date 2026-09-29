// Which Spend view a request asks for (#2962, #2963): a tab, and with it
// either one operator's, agent's, or tool's drill, one finding's evidence on
// the Findings tab, or the grouping on the Month tab. The tab and the drill
// are path segments (`/spend/<tab>/<drill>`, the mockup's route).
// The evidence is a dialog over the Findings tab and the grouping is a choice
// within the Month tab, so both are query values. A segment the page does not
// know is a 404 rather than a page that guesses.
import { type DayRange, SpendDrillKind } from "@/data/contracts/spend";
import { firstParam } from "@/shared/safe-path";
import { isFindingId } from "./forms";

/**
 * Month first, the v3 design's landing tab (ADR-226), then the earlier
 * design's tabs that Month does not replace, Findings to Budgets. Month groups
 * by operator, agent, and model, so those three tabs and Coaching are gone
 * (#2962); a drill still reaches one operator, agent, or tool. The three after
 * Budgets are this build's own and are not in either design: By task and By
 * cost center (ADR-142), and Pricing, the book every figure above was priced
 * against with the models it cannot price, which is why some of those figures
 * read "not recorded".
 */
export const SPEND_TABS = [
  "month",
  "findings",
  "tokens",
  "tool",
  "waste",
  "budgets",
  "task",
  "cost_center",
  "pricing",
] as const;
export type SpendTab = (typeof SPEND_TABS)[number];

/**
 * The groupings the Month tab offers, the first one the default. The design's
 * By work item is not here: no run records the work item it served (#2962).
 */
export const SPEND_MONTH_BY = [
  "agent",
  "operator",
  "model",
  "mcp_server",
] as const;
export type SpendMonthBy = (typeof SPEND_MONTH_BY)[number];

export type SpendView =
  /** The month's spend, grouped one way. */
  | { tab: "month"; drill: null; finding: null; by: SpendMonthBy }
  /** The Findings section, with one finding's evidence open or none. */
  | { tab: "findings"; drill: null; finding: string | null }
  | {
      tab: Exclude<SpendTab, "month" | "findings">;
      drill: null;
      finding: null;
    }
  | { tab: SpendDrillKind; drill: string; finding: null };

/** The workspace a link on the page points into. */
export type SpendAt = { org: string; ws: string };

/**
 * How many machines a saved gateway policy reaches.
 *
 * `hosts` is every machine enrolled in the workspace, and today the answer is
 * none of them: no bundle carries a `models` clause, so every enrolled host
 * keeps calling whatever model it likes whatever this policy says.
 * `hostsEnforcingModels` counts the hosts that advertised they could parse the
 * clause if one were sent, which is what the count will mean when one is. The
 * section renders the gap rather than letting a saved list read as an applied
 * one.
 */
export type GatewayReach = { hosts: number; hostsEnforcingModels: number };

/** An operator key is a principal public id; get_spend_drill refuses any other. */
const PRINCIPAL = /^prn_[0-9a-z]+$/;
const KEY_MAX = 256;

function isTab(value: string | undefined): value is SpendTab {
  return SPEND_TABS.some((tab) => tab === value);
}

function monthBy(value: string | undefined): SpendMonthBy {
  return SPEND_MONTH_BY.find((by) => by === value) ?? "agent";
}

/**
 * The view the path segments after `/spend` name, or null for a path that
 * names none (the route answers 404). `finding` is the query value that opens
 * one finding's evidence over the Findings tab, and `by` the Month tab's
 * grouping; a grouping the tab does not offer reads as the default.
 *
 * A drill is its kind and a key whether or not the kind is still a tab, so a
 * link to one key's drill outlives the tab it was first reached from.
 */
export function parseSpendView(
  segments: readonly string[] | undefined,
  finding?: string | string[],
  by?: string | string[],
): SpendView | null {
  const [raw, drill, ...rest] = segments ?? [];
  if (rest.length > 0) return null;
  if (drill !== undefined) {
    const kind = SpendDrillKind.safeParse(raw);
    if (
      !kind.success ||
      drill.length === 0 ||
      drill.length > KEY_MAX ||
      (kind.data === "operator" && !PRINCIPAL.test(drill))
    ) {
      return null;
    }
    return { tab: kind.data, drill, finding: null };
  }
  const tab = raw === undefined ? "month" : raw;
  if (!isTab(tab)) return null;
  if (tab === "month") {
    return {
      tab,
      drill: null,
      finding: null,
      by: monthBy(firstParam(by)),
    };
  }
  if (tab === "findings") {
    const id = firstParam(finding);
    return {
      tab,
      drill: null,
      finding: id !== undefined && isFindingId(id) ? id : null,
    };
  }
  return { tab, drill: null, finding: null };
}

/** The UTC calendar month up to and including `today`, the clock's today by default. */
export function monthToDate(today: Date = new Date()): DayRange {
  const to = today.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}

/** The one UTC day `today`, the clock's today by default. */
export function dayOf(today: Date = new Date()): DayRange {
  const day = today.toISOString().slice(0, 10);
  return { from: day, to: day };
}
