// Which Steering view a request asks for (#2961): a tab, a kind on Records, a
// page offset, and a selected proposal on Context PRs, all from the query
// string. A tab is a query rather than a route (ARCHITECTURE.md §1.2: this
// lane adds no route), and a value the page does not know falls back to the
// default rather than failing the page.
import { RECORD_KINDS, type RecordKind } from "@/data/contracts/steering";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

/** The tabs in the mockup's order; Effect and Retirement are not in this release. */
export const STEERING_TABS = ["records", "proposals", "prs"] as const;
export type SteeringTab = (typeof STEERING_TABS)[number];

export type SteeringView = {
  tab: SteeringTab;
  /** Only on Records. */
  kind: RecordKind | null;
  offset: number;
  /** Only on Context PRs. */
  proposal: string | null;
};

/** The workspace a link on the page points into. */
export type SteeringAt = { org: string; ws: string };

const OFFSET = /^(0|[1-9][0-9]{0,5})$/;
/** get_context_pr's own id rule, with a length the contract's id column holds. */
const PROPOSAL = /^prp_[0-9A-Za-z]{1,60}$/;

type Params = Readonly<Record<string, string | string[] | undefined>>;

export function parseSteeringView(params: Params): SteeringView {
  const rawTab = firstParam(params.tab);
  const tab = STEERING_TABS.find((t) => t === rawTab) ?? "records";
  const rawKind = firstParam(params.kind);
  const rawOffset = firstParam(params.offset);
  const rawProposal = firstParam(params.proposal);
  return {
    tab,
    kind:
      tab === "records"
        ? (RECORD_KINDS.find((k) => k === rawKind) ?? null)
        : null,
    offset:
      rawOffset !== undefined && OFFSET.test(rawOffset) ? Number(rawOffset) : 0,
    proposal:
      tab === "prs" && rawProposal !== undefined && PROPOSAL.test(rawProposal)
        ? rawProposal
        : null,
  };
}

/** The route for a view; the defaults (Records, all kinds, the first page) are left off the query. */
export function steeringLink(
  at: SteeringAt,
  to: {
    tab: SteeringTab;
    kind?: RecordKind | null;
    offset?: number;
    proposal?: string | null;
  },
): SafePath {
  return routes.steering(at.org, at.ws, {
    tab: to.tab === "records" ? undefined : to.tab,
    kind: to.kind ?? undefined,
    offset:
      to.offset === undefined || to.offset === 0
        ? undefined
        : String(to.offset),
    proposal: to.proposal ?? undefined,
  });
}
