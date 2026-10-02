// Which Steering view a request asks for (roadmap pages/steering.md): six
// tabs, each a path segment, and on the Library a shelf, also a path segment.
// `/steering` and `/steering/library` are the Library's All shelf;
// `/steering/records`, `/skills`, `/memory`, `/ontology` and `/instructions`
// are its other shelves. A filter, a page offset, the rows a Proposals,
// Memories or Skills page holds (#4693), a selected proposal, the memory the
// Memories drawer opens (#4914) and a Skills cursor stay query values.
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
import {
  MEMORY_HARNESSES,
  type MemoryHarness,
  RECORD_KINDS,
  type RecordKind,
  STEERING_PAGE,
  WORKSPACE_MEMORY_STATES,
  type WorkspaceMemoryState,
} from "@/data/contracts/steering";
import { SKILL_PAGE, SKILL_ROWS } from "@/data/contracts/skills";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

/**
 * The six tabs, in the design's order; each answers one question. Memories
 * sits beside the Library, as the design puts it beside Records.
 */
export const STEERING_TABS = [
  "library",
  "memories",
  "assignments",
  "gates",
  "proposals",
  "compiler",
] as const;
export type SteeringTab = (typeof STEERING_TABS)[number];

/** The id of the region the selected tab controls: the shelf row and the body. */
export const TAB_PANEL_ID = "steering-panel";

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

/** The page sizes Rows per page offers under both Proposals segments and on Memories (#4693). */
export const PROPOSAL_ROWS: readonly number[] = [10, 25, 50, 100];

/**
 * The State filter on Memories: Waiting and In PR together by default, one
 * state, or every state.
 */
export const MEMORY_STATE_FILTERS = [
  "open",
  ...WORKSPACE_MEMORY_STATES,
  "all",
] as const;
type MemoryStateFilter = (typeof MEMORY_STATE_FILTERS)[number];

/** The Memories tab's filters, and the memory its drawer opens. */
export type MemoriesView = {
  state: MemoryStateFilter;
  harness: MemoryHarness | null;
  /** An agent key, `org_ns.ws_ns.slug`. */
  agent: string | null;
  /** `<host>/<owner>/<name>`, such as `github.com/acme/api`. */
  repo: string | null;
  /** A Claude Code memory type, such as `feedback`. */
  type: string | null;
  memory: string | null;
};

/** Memories with no filter: Waiting and In PR, and no drawer. */
export const NO_MEMORY_FILTERS: MemoriesView = {
  state: "open",
  harness: null,
  agent: null,
  repo: null,
  type: null,
  memory: null,
};

/** The states a State filter value lists. */
export function memoryStates(
  state: MemoryStateFilter,
): readonly WorkspaceMemoryState[] {
  if (state === "open") return ["waiting", "in_pr"];
  if (state === "all") return WORKSPACE_MEMORY_STATES;
  return [state];
}

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
  /**
   * How many rows a page holds: on either Proposals segment one of
   * PROPOSAL_ROWS, on the Skills shelf one of SKILL_ROWS, and
   * `STEERING_PAGE` everywhere else.
   */
  rows: number;
  /** Only on the Context PRs segment: the Context PR selected. */
  proposal: string | null;
  /** Only on the Skills shelf: the inventory page `list_skills` answered with. */
  cursor: string | null;
  /** Only on the Skills shelf: which of its views is open. */
  skillView: string | undefined;
  /** Only on the Skills shelf's `source` view: the skill `/skills/<id>/source` names. */
  skill: string | null;
  /** Only on Memories. */
  memories: MemoriesView | null;
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
/** get_workspace_memory's id rule, with a length a URL may carry. */
const MEMORY = /^mem_[0-9A-Za-z]{1,60}$/;
/** An agent key, `org_ns.ws_ns.slug`, within list_workspace_memories' bound. */
const AGENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** The repository rule list_workspace_memories enforces (REPO_REF_PATTERN). */
const REPO_REF =
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/(?!\.\.?(?:\/|$))[a-z0-9_.-]+){2,}$/;
const REPO_MAX = 200;
/** A Claude Code memory type, as list_workspace_memories takes it. */
const MEMORY_TYPE = /^[a-z][a-z0-9_-]{0,31}$/;
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

const isShelfSegment = (raw: string): raw is Exclude<LibraryShelf, "all"> =>
  SHELF_SEGMENTS.has(raw);

const isTab = (raw: string): raw is SteeringTab =>
  STEERING_TABS.some((tab) => tab === raw);

/** The query values a view keeps, whatever path it moved to. */
function carried(query: Params) {
  const agent = firstParam(query.agent);
  return {
    kind: firstParam(query.kind),
    rows: firstParam(query.rows),
    offset: firstParam(query.offset),
    proposal: firstParam(query.proposal),
    cursor: firstParam(query.cursor),
    view: firstParam(query.view),
    state: firstParam(query.state),
    harness: firstParam(query.harness),
    // A redirect that names the Compiler's agent itself keeps that one.
    ...(agent === undefined ? {} : { agent }),
    repo: firstParam(query.repo),
    type: firstParam(query.type),
    memory: firstParam(query.memory),
  };
}

/** One query value when it matches `rule`, else null. */
function matched(raw: string | undefined, rule: RegExp): string | null {
  return raw !== undefined && rule.test(raw) ? raw : null;
}

/** The Memories filters a query names; a value the reads would refuse reads as no filter. */
function memoriesOf(query: Params): MemoriesView {
  const state = firstParam(query.state);
  const harness = firstParam(query.harness);
  const repo = firstParam(query.repo);
  return {
    state: MEMORY_STATE_FILTERS.find((s) => s === state) ?? "open",
    harness: MEMORY_HARNESSES.find((h) => h === harness) ?? null,
    agent: matched(firstParam(query.agent), AGENT_KEY),
    repo:
      repo !== undefined && repo.length <= REPO_MAX && REPO_REF.test(repo)
        ? repo
        : null,
    type: matched(firstParam(query.type), MEMORY_TYPE),
    memory: matched(firstParam(query.memory), MEMORY),
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
  const rawRows = Number(firstParam(query.rows));
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
    // A size Rows does not offer reads as the default, so a hand-typed URL
    // cannot ask for more rows than a page shows.
    rows:
      tab === "proposals" || tab === "memories"
        ? (PROPOSAL_ROWS.find((size) => size === rawRows) ?? STEERING_PAGE)
        : shelf === "skills"
          ? (SKILL_ROWS.find((size) => size === rawRows) ?? SKILL_PAGE)
          : STEERING_PAGE,
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
    skill: shelf === "skills" ? (base.skill ?? null) : null,
    memories: tab === "memories" ? memoriesOf(query) : null,
  };
}

/**
 * The view a Steering request names: `segments` is the path under
 * `/steering` (none on the bare route) and `query` the search values.
 */
/**
 * The Skills inventory's page size as an address carries it: left off at the
 * default, so a route that forwards the size needs no contract import (#4693).
 */
export function skillRowsParam(rows: number): string | undefined {
  return rows === SKILL_PAGE ? undefined : String(rows);
}

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
      ? view({
          tab: "library",
          shelf: "skills",
          skillView: "source",
          skill: second,
        })
      : notFound;
  }

  if (isShelfSegment(first)) {
    // `/records/<lineage>` is the record page, its own route; nothing else nests.
    if (second !== undefined) return notFound;
    return view({
      tab: "library",
      shelf: first,
    });
  }

  if (first === "assignments" || first === "gates" || first === "memories") {
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

/**
 * The route for a view; a page's defaults (the first page, every kind,
 * `STEERING_PAGE` rows) are left off the query.
 */
export function steeringLink(
  at: SteeringAt,
  to: {
    tab: SteeringLinkTab;
    agent?: string | null;
    kind?: RecordKind | null;
    offset?: number;
    /** How many proposals a page holds; only on Proposals. */
    rows?: number;
    proposal?: string | null;
    /** A skill whose source the Skills shelf opens. */
    skill?: string | null;
    /**
     * Only on Memories: the filters and the memory the drawer opens. The
     * agent filter is `agent` above, which names the Compiler's agent there.
     */
    memories?: Partial<Omit<MemoriesView, "agent">>;
  },
): SafePath {
  const m = to.memories ?? {};
  return routes.steering(at.org, at.ws, {
    tab: to.tab,
    agent: to.agent ?? undefined,
    kind: to.kind ?? undefined,
    rows:
      to.rows === undefined || to.rows === STEERING_PAGE
        ? undefined
        : String(to.rows),
    offset:
      to.offset === undefined || to.offset === 0
        ? undefined
        : String(to.offset),
    proposal: to.proposal ?? undefined,
    skill: to.skill ?? undefined,
    state: m.state === undefined || m.state === "open" ? undefined : m.state,
    harness: m.harness ?? undefined,
    repo: m.repo ?? undefined,
    type: m.type ?? undefined,
    memory: m.memory ?? undefined,
  });
}

/**
 * The Memories address for `view` with `change` applied. A change to a
 * filter starts the list at its first page and closes the drawer.
 */
export function memoriesLink(
  at: SteeringAt,
  view: Pick<SteeringView, "rows" | "offset"> & { memories: MemoriesView },
  change: Partial<MemoriesView> & { offset?: number; rows?: number },
): SafePath {
  const next = { ...view.memories, ...change };
  const filtered = Object.keys(change).some(
    (key) => key !== "memory" && key !== "offset" && key !== "rows",
  );
  return steeringLink(at, {
    tab: "memories",
    agent: next.agent,
    rows: change.rows ?? view.rows,
    offset: filtered ? 0 : (change.offset ?? view.offset),
    memories: {
      state: next.state,
      harness: next.harness,
      repo: next.repo,
      type: next.type,
      memory: filtered ? null : next.memory,
    },
  });
}

/** Where a shelf chip points: All is `/steering/library`, every other shelf its own segment. */
export function shelfLink(at: SteeringAt, shelf: LibraryShelf): SafePath {
  return steeringLink(at, { tab: shelf === "all" ? "library" : shelf });
}
