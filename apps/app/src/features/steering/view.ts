// Which Steering view a request asks for (roadmap pages/steering.md): five
// tabs, each a path segment, and on the Library a shelf, also a path segment.
// `/steering` and `/steering/library` are the Library's All shelf;
// `/steering/records`, `/skills`, `/memory`, `/ontology` and `/instructions`
// are its other shelves. A filter, a page offset, a selected proposal and a
// Skills cursor stay query values.
//
// Every address written before the five tabs still lands. `/steering/policy`
// is Gates, `/steering/preview/<agent>` is `/steering/compiler/<agent>`,
// `/steering/prs` is `/steering/proposals/prs`, and a `?tab=` query from the
// old one-route page moves to the path it now names. The tabs this page had
// before the design (Settings and Delivery) moved into the tab whose question
// they answer: the freshness gates refuse stale runs, so they are Gates, and
// the per-run delivery report says which agent received what, so it is
// Assignments. `/steering/library/<shelf>` from the interim hub lands on the
// shelf. A segment that names nothing is a 404 rather than a page that
// guesses.
import { RECORD_KINDS, type RecordKind } from "@/data/contracts/steering";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

/** The five tabs, in the design's order; each answers one question. */
export const STEERING_TABS = [
  "library",
  "assignments",
  "gates",
  "proposals",
  "compiler",
] as const;
export type SteeringTab = (typeof STEERING_TABS)[number];

/**
 * The Library's shelves, in the design's order. Instructions renders only
 * where the workspace has one, so All stays the sum of the chips beside it.
 */
export const LIBRARY_SHELVES = [
  "all",
  "records",
  "instructions",
  "skills",
  "memory",
  "ontology",
] as const;
export type LibraryShelf = (typeof LIBRARY_SHELVES)[number];

/** The two segments of Proposals: the candidates and their Context PRs. */
export type ProposalSegment = "candidates" | "prs";

export type SteeringView = {
  tab: SteeringTab;
  /** Only on the Library. */
  shelf: LibraryShelf | null;
  /** Only on Proposals. */
  segment: ProposalSegment | null;
  /** Only on the Compiler: the agent it assembles for. */
  agent: string | null;
  /** Only on the Records shelf. */
  kind: RecordKind | null;
  offset: number;
  /** Only on the Context PRs segment. */
  proposal: string | null;
  /** Only on the Skills shelf: the inventory page `list_skills` answered with. */
  cursor: string | null;
  /** Only on the Skills shelf: which of its views is open. */
  skillView: string | undefined;
};

/** What a request resolves to: a view, a move to where the view lives now, or nothing. */
export type SteeringRoute =
  | { kind: "view"; view: SteeringView }
  | { kind: "redirect"; to: SafePath }
  | { kind: "not_found" };

/** The workspace a link on the page points into. */
export type SteeringAt = { org: string; ws: string };

/** Any id `routes.steering` maps to a path: a tab, a shelf, or an id from before the rename. */
export type SteeringLinkTab =
  | SteeringTab
  | Exclude<LibraryShelf, "all">
  | "prs"
  | "policy"
  | "preview"
  | "settings"
  | "freshness"
  | "deliveries";

const OFFSET = /^(0|[1-9][0-9]{0,5})$/;
/** get_context_pr's own id rule, with a length the contract's id column holds. */
const PROPOSAL = /^prp_[0-9A-Za-z]{1,60}$/;
/** An opaque inventory cursor; the length bounds what a URL may carry. */
const CURSOR_MAX = 512;
/** An agent slug or a skill id as the registry mints it. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
/** Views of the Skills shelf a path segment may name. */
const SKILL_VIEWS: ReadonlySet<string> = new Set([
  "catalog",
  "search",
  "versions",
]);

type Params = Readonly<Record<string, string | string[] | undefined>>;

/** Old ids that name a tab by another name, and the id each lands on. */
const ALIASES: Readonly<Record<string, SteeringLinkTab>> = {
  policy: "gates",
  settings: "gates",
  freshness: "gates",
  deliveries: "assignments",
  preview: "compiler",
  prs: "prs",
};

const SHELF_SEGMENTS: ReadonlySet<string> = new Set(
  LIBRARY_SHELVES.filter((shelf) => shelf !== "all"),
);

const isTab = (raw: string): raw is SteeringTab =>
  STEERING_TABS.some((tab) => tab === raw);

/** The query values a view keeps, whatever path it moved to. */
function carried(query: Params) {
  return {
    kind: firstParam(query.kind),
    offset: firstParam(query.offset),
    proposal: firstParam(query.proposal),
    cursor: firstParam(query.cursor),
    view: firstParam(query.view),
  };
}

function viewOf(
  base: Pick<SteeringView, "tab"> & Partial<SteeringView>,
  query: Params,
): SteeringView {
  const tab = base.tab;
  const shelf = base.shelf ?? (tab === "library" ? "all" : null);
  const segment = base.segment ?? (tab === "proposals" ? "candidates" : null);
  const rawKind = firstParam(query.kind);
  const rawOffset = firstParam(query.offset);
  const rawProposal = firstParam(query.proposal);
  const rawCursor = firstParam(query.cursor);
  return {
    tab,
    shelf,
    segment,
    agent: base.agent ?? null,
    kind:
      shelf === "records"
        ? (RECORD_KINDS.find((k) => k === rawKind) ?? null)
        : null,
    offset:
      rawOffset !== undefined && OFFSET.test(rawOffset) ? Number(rawOffset) : 0,
    proposal:
      segment === "prs" &&
      rawProposal !== undefined &&
      PROPOSAL.test(rawProposal)
        ? rawProposal
        : null,
    cursor:
      shelf === "skills" &&
      rawCursor !== undefined &&
      rawCursor !== "" &&
      rawCursor.length <= CURSOR_MAX
        ? rawCursor
        : null,
    skillView:
      shelf === "skills"
        ? (base.skillView ?? firstParam(query.view))
        : undefined,
  };
}

/**
 * The view a Steering request names: `segments` is the path under
 * `/steering` (none on the bare route) and `query` the search values.
 */
export function resolveSteeringRoute(
  at: SteeringAt,
  segments: readonly string[] | undefined,
  query: Params,
): SteeringRoute {
  const redirect = (tab: string, agent?: string): SteeringRoute => ({
    kind: "redirect",
    to: routes.steering(at.org, at.ws, { tab, agent, ...carried(query) }),
  });
  const notFound: SteeringRoute = { kind: "not_found" };
  const view = (base: Parameters<typeof viewOf>[0]): SteeringRoute => ({
    kind: "view",
    view: viewOf(base, query),
  });
  const [first, second, third, ...rest] = segments ?? [];

  if (first === undefined) {
    // The one-route page carried its tab as `?tab=`; a known one moves to its path.
    const legacy = firstParam(query.tab);
    if (
      legacy !== undefined &&
      (isTab(legacy) ||
        SHELF_SEGMENTS.has(legacy) ||
        Object.hasOwn(ALIASES, legacy))
    ) {
      return redirect(legacy);
    }
    return view({ tab: "library" });
  }
  if (rest.length > 0) return notFound;

  if (first === "library") {
    if (second === undefined) return view({ tab: "library" });
    if (third !== undefined) return notFound;
    if (second === "all") return redirect("library");
    return SHELF_SEGMENTS.has(second) ? redirect(second) : notFound;
  }

  if (first === "skills") {
    // `/skills/<view>` and `/skills/<id>/source` are the Skills shelf's own
    // addresses (roadmap pages/skills.md, skill-source.md).
    if (second === undefined) return view({ tab: "library", shelf: "skills" });
    if (third === undefined) {
      return SKILL_VIEWS.has(second)
        ? view({ tab: "library", shelf: "skills", skillView: second })
        : notFound;
    }
    return third === "source" && SLUG.test(second)
      ? view({ tab: "library", shelf: "skills", skillView: "source" })
      : notFound;
  }

  if (SHELF_SEGMENTS.has(first)) {
    // `/records/<lineage>` is the record page, its own route; nothing else nests.
    if (second !== undefined) return notFound;
    return view({
      tab: "library",
      shelf: first as Exclude<LibraryShelf, "all">,
    });
  }

  if (first === "assignments" || first === "gates") {
    return second === undefined ? view({ tab: first }) : notFound;
  }

  if (first === "proposals") {
    if (second === undefined) return view({ tab: "proposals" });
    return second === "prs" && third === undefined
      ? view({ tab: "proposals", segment: "prs" })
      : notFound;
  }

  if (first === "compiler" || first === "preview") {
    if (third !== undefined) return notFound;
    if (second !== undefined && !SLUG.test(second)) return notFound;
    return first === "preview"
      ? redirect("compiler", second)
      : view({ tab: "compiler", agent: second ?? null });
  }

  if (Object.hasOwn(ALIASES, first) && second === undefined) {
    return redirect(ALIASES[first] ?? "library");
  }
  return notFound;
}

/** The route for a view; a page's defaults (the first page, every kind) are left off the query. */
export function steeringLink(
  at: SteeringAt,
  to: {
    tab: SteeringLinkTab;
    agent?: string | null;
    kind?: RecordKind | null;
    offset?: number;
    proposal?: string | null;
  },
): SafePath {
  return routes.steering(at.org, at.ws, {
    tab: to.tab,
    agent: to.agent ?? undefined,
    kind: to.kind ?? undefined,
    offset:
      to.offset === undefined || to.offset === 0
        ? undefined
        : String(to.offset),
    proposal: to.proposal ?? undefined,
  });
}

/** Where a shelf chip points: All is `/steering/library`, every other shelf its own segment. */
export function shelfLink(at: SteeringAt, shelf: LibraryShelf): SafePath {
  return steeringLink(at, { tab: shelf === "all" ? "library" : shelf });
}
