// Which Spend view a request asks for (#2962, #2963): a tab, and with it
// either one key's drill on the operator, agent and tool tabs or one finding's
// evidence on the Findings tab, all from the query string. A tab is a query
// rather than a route (ARCHITECTURE.md §1.2: neither lane adds a route), and a
// value the page does not know opens the first tab with nothing selected
// rather than an error page.
import { type DayRange, SpendDrillKind } from "@/data/contracts/spend";
import { firstParam } from "@/shared/safe-path";
import { isFindingId } from "./forms";

/**
 * The tabs in the mockup's order: the page leads with Findings, and Pricing
 * closes it — the book every figure above was priced against, and the models
 * it cannot price, which is why some of those figures read "not recorded".
 */
export const SPEND_TABS = [
  "findings",
  "tokens",
  "operator",
  "agent",
  "model",
  "tool",
  "task",
  "cost_center",
  "waste",
  "budgets",
  "pricing",
] as const;
export type SpendTab = (typeof SPEND_TABS)[number];

export type SpendView =
  /** The Findings section, with one finding's evidence open or none. */
  | { tab: "findings"; drill: null; finding: string | null }
  | { tab: Exclude<SpendTab, "findings">; drill: null; finding: null }
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

export function parseSpendView(
  params: Readonly<Record<string, string | string[] | undefined>>,
): SpendView {
  const raw = firstParam(params.tab);
  const tab = isTab(raw) ? raw : "findings";
  const drill = firstParam(params.drill);
  // A drill opens only on a tab the request named: a tab that fell back to the
  // first one does not carry the drill with it.
  const kind = SpendDrillKind.safeParse(raw);
  if (
    kind.success &&
    drill !== undefined &&
    drill.length > 0 &&
    drill.length <= KEY_MAX &&
    (kind.data !== "operator" || PRINCIPAL.test(drill))
  ) {
    return { tab: kind.data, drill, finding: null };
  }
  if (tab === "findings") {
    const finding = firstParam(params.finding);
    return {
      tab,
      drill: null,
      finding: finding !== undefined && isFindingId(finding) ? finding : null,
    };
  }
  return { tab, drill: null, finding: null };
}

/** The UTC calendar month up to and including `today`, the clock's today by default. */
export function monthToDate(today: Date = new Date()): DayRange {
  const to = today.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}

/**
 * The one UTC day `today`, the clock's today by default.
 *
 * @deregistered Retained with Fleet's spend tiles; DEREGISTERED.md §16.
 */
export function dayOf(today: Date = new Date()): DayRange {
  const day = today.toISOString().slice(0, 10);
  return { from: day, to: day };
}
