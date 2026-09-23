// Steering hub navigation keeps legacy section links and their selections.
import { RECORD_KINDS, type RecordKind } from "@/data/contracts/steering";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

export const STEERING_TABS = ["library", "proposals", "freshness"] as const;
export type SteeringHubTab = (typeof STEERING_TABS)[number];
export type SteeringTab =
  | SteeringHubTab
  | "records"
  | "skills"
  | "prs"
  | "settings";
export const LIBRARY_SHELVES = ["all", "records", "skills", "memory"] as const;
export type LibraryShelf = (typeof LIBRARY_SHELVES)[number];
export type SteeringView = {
  tab: SteeringHubTab;
  shelf: LibraryShelf;
  kind: RecordKind | null;
  offset: number;
  proposal: string | null;
  cursor: string | null;
  section: "candidates" | "prs";
};

/** The workspace a link on the page points into. */
export type SteeringAt = { org: string; ws: string };

const OFFSET = /^(0|[1-9][0-9]{0,5})$/;
/** get_context_pr's own id rule, with a length the contract's id column holds. */
const PROPOSAL = /^prp_[0-9A-Za-z]{1,60}$/;
/** An opaque inventory cursor; the length bounds what a URL may carry. */
const CURSOR_MAX = 512;

type Params = Readonly<Record<string, string | string[] | undefined>>;

export function parseSteeringView(params: Params): SteeringView {
  const rawTab = firstParam(params.tab);
  const aliases: Record<string, SteeringHubTab> = {
    records: "library",
    skills: "library",
    memory: "library",
    prs: "proposals",
    settings: "freshness",
  };
  const tab =
    STEERING_TABS.find((value) => value === rawTab) ??
    (rawTab !== undefined && Object.hasOwn(aliases, rawTab)
      ? aliases[rawTab]
      : undefined) ??
    "library";
  const rawShelf =
    firstParam(params.shelf) ??
    (LIBRARY_SHELVES.includes(rawTab as LibraryShelf)
      ? rawTab
      : firstParam(params.kind) !== undefined
        ? "records"
        : undefined);
  const shelf = LIBRARY_SHELVES.find((value) => value === rawShelf) ?? "all";
  const rawKind = firstParam(params.kind);
  const rawOffset = firstParam(params.offset);
  const rawProposal = firstParam(params.proposal);
  const rawCursor = firstParam(params.cursor);
  const section =
    rawTab === "prs" ||
    firstParam(params.section) === "prs" ||
    rawProposal !== undefined
      ? "prs"
      : "candidates";
  return {
    tab,
    shelf,
    kind:
      tab === "library" && shelf === "records"
        ? (RECORD_KINDS.find((value) => value === rawKind) ?? null)
        : null,
    offset:
      rawOffset !== undefined && OFFSET.test(rawOffset) ? Number(rawOffset) : 0,
    proposal:
      tab === "proposals" &&
      section === "prs" &&
      rawProposal !== undefined &&
      PROPOSAL.test(rawProposal)
        ? rawProposal
        : null,
    cursor:
      tab === "library" &&
      shelf === "skills" &&
      rawCursor !== undefined &&
      rawCursor !== "" &&
      rawCursor.length <= CURSOR_MAX
        ? rawCursor
        : null,
    section,
  };
}

/** Canonical hub paths; old callers retain their section and selected record. */
export function steeringLink(
  at: SteeringAt,
  to: {
    tab: SteeringTab;
    shelf?: LibraryShelf;
    kind?: RecordKind | null;
    offset?: number;
    proposal?: string | null;
    section?: "candidates" | "prs";
    cursor?: string | null;
    view?: string;
  },
): SafePath {
  const view = parseSteeringView({
    tab: to.tab,
    shelf: to.shelf,
    section: to.section,
    proposal: to.proposal ?? undefined,
  });
  return routes.steering(at.org, at.ws, {
    tab: view.tab,
    shelf: view.shelf,
    kind: to.kind ?? undefined,
    offset:
      to.offset === undefined || to.offset === 0
        ? undefined
        : String(to.offset),
    proposal: to.proposal ?? undefined,
    cursor: to.cursor ?? undefined,
    view: to.view,
    section:
      view.tab === "proposals" && view.section === "prs" ? "prs" : undefined,
  });
}

/** Route segments override legacy query selectors; all other query values survive. */
export function steeringPathParams(
  segments: readonly string[],
  query: Params,
): Params {
  const [tab, child] = segments;
  return {
    ...query,
    tab,
    ...(tab === "library" ? { shelf: child ?? "all" } : {}),
  };
}
