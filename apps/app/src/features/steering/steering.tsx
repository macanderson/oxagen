// The Steering hub (roadmap pages/steering.md; #2961): the header with the
// governance chip and the one gold action, the five tabs, the Library's shelf
// row, and the body of the tab or shelf in view.
//
// Every tab reads the record registry first, because the Library's count sits
// on the Library tab wherever the reader is, and because that read is the
// page's own: a refusal or an outage there is the page's denied or error
// state, which replaces the body and the header with it and never the shell.
// The hub read (governance mode and proposals waiting) fails on its own
// inside its value, so GitHub being down leaves the library standing.
//
// The Library's All and Records shelves share one empty state; every other
// tab and shelf owns its empty copy in its own body. Each body makes only the
// reads it shows.
import { Suspense, type ReactNode } from "react";
import {
  type ContextPr,
  type MemoryPage,
  STEERING_READ_MAX,
} from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { getAuthUser } from "@/server/session";
import { PageRecord } from "@/features/shell";
import { Skills, SkillsLoading } from "@/features/skills";
import type { WsCtx } from "@/server/viewer";
import { SteeringCreate, tabHoldsPrimary } from "./create-action";
import { GovernanceChip } from "./governance";
import { LibraryAll } from "./library-all";
import { readLibrary } from "./library-read";
import { SteeringEmpty, SteeringFailure } from "./page-state";
import { type ShelfCounts, ShelfRow } from "./shelves";
import { bodyTakesHeaderGold } from "./tab-primary";
import { SteeringTabs } from "./tabs";
import { AssignmentsTab } from "./tabs/assignments";
import { CompilerTab } from "./tabs/compiler";
import { GatesTab } from "./tabs/gates";
import { InstructionsShelf } from "./tabs/instructions";
import { MemoryShelf } from "./tabs/memory";
import { OntologyShelf } from "./tabs/ontology";
import { ProposalsTab } from "./tabs/proposals";
import { RecordsShelf } from "./tabs/records";
import { SkillSourceShelf } from "./tabs/skill-source";
import {
  type SteeringAt,
  type SteeringView,
  TAB_PANEL_ID,
  tabId,
} from "./view";
import { routes } from "@/shared/safe-path";

/** The page header, drawn by the route with these actions; the route owns its title key. */
export type SteeringHeader = (actions: ReactNode) => ReactNode;

async function Body({
  ctx,
  source,
  view,
  at,
  pr,
  published,
  memories,
  repository,
}: {
  ctx: WsCtx;
  source: DataSource;
  view: SteeringView;
  at: SteeringAt;
  /** The selected Context PR, when the hub read it. */
  pr: Read<ContextPr> | null;
  /** Records in force, from the hub's own read. */
  published: number;
  /** The Memory shelf's read, made by the hub; null off that shelf. */
  memories: MemoryPage | null;
  /** The main repository the governance read named, or null. */
  repository: string | null;
}) {
  // The async bodies are awaited here rather than rendered as elements, so
  // each read runs before the hub returns and a test renders the result.
  switch (view.tab) {
    case "assignments":
      return await AssignmentsTab({ ctx, source, at });
    case "gates":
      return await GatesTab({ ctx, source, at });
    case "compiler":
      return await CompilerTab({
        ctx,
        source,
        at,
        agent: view.agent,
        published,
      });
    case "proposals":
      return await ProposalsTab({
        ctx,
        source,
        at,
        segment: view.segment ?? "candidates",
        offset: view.offset,
        proposal: view.proposal,
        pr,
      });
    case "library":
      switch (view.shelf) {
        case "records":
          return await RecordsShelf({
            ctx,
            source,
            at,
            kind: view.kind,
          });
        case "skills":
          return (
            <>
              {view.skill === null ? null : (
                <SkillSourceShelf skill={view.skill} />
              )}
              <Suspense fallback={<SkillsLoading />}>
                <Skills
                  ctx={ctx}
                  source={source}
                  cursor={view.cursor}
                  view={view.skillView}
                />
              </Suspense>
            </>
          );
        case "memory":
          // The hub read it; a failed read is the hub's own state and
          // never reaches here.
          return memories === null ? null : (
            <MemoryShelf at={at} page={memories} />
          );
        case "ontology":
          return <OntologyShelf repository={repository} />;
        case "instructions":
          return <InstructionsShelf />;
        case "all":
        case null:
          // The All shelf is drawn from the hub's own read in Steering.
          return null;
      }
  }
}

/**
 * The instant the reads were attempted, taken before them. Declared outside
 * the component because a component may not read a clock during render.
 */
function instantOfRead(): string {
  return new Date().toISOString();
}

/**
 * The failed read's trace instant in UTC, as the design prints it:
 * `2026-09-11 09:16:04Z`. A trace line is quoted into an incident, so it
 * carries one zone for every reader rather than the viewer's own.
 *
 * @internal Exported for steering.test.tsx.
 */
export function traceInstant(readAt: string): string {
  const at = new Date(readAt);
  if (Number.isNaN(at.getTime())) return readAt;
  return `${at.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

function FailureAt({
  ctx,
  read,
  view,
  readAt,
  viewer,
}: {
  ctx: WsCtx;
  read: Parameters<typeof SteeringFailure>[0]["read"];
  view: SteeringView;
  readAt: string;
  viewer: string | null;
}) {
  return (
    <SteeringFailure
      read={read}
      org={ctx.orgSlug}
      ws={ctx.wsSlug}
      orgName={ctx.orgName}
      wsSlug={ctx.wsSlug}
      wsRole={ctx.wsRole}
      viewer={viewer}
      retry={retryLink(ctx, view)}
      readAt={traceInstant(readAt)}
    />
  );
}

/** Try again reloads the view that failed. */
function retryLink(ctx: WsCtx, view: SteeringView) {
  const tab =
    view.tab === "library"
      ? view.shelf === "all" || view.shelf === null
        ? "library"
        : view.shelf
      : view.tab === "proposals" && view.segment === "prs"
        ? "prs"
        : view.tab;
  return routes.steering(ctx.orgSlug, ctx.wsSlug, {
    tab,
    agent: view.agent ?? undefined,
  });
}

export async function Steering({
  ctx,
  source,
  view,
  header,
}: {
  ctx: WsCtx;
  source: DataSource;
  view: SteeringView;
  header: SteeringHeader;
}) {
  const at: SteeringAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  const readAt = instantOfRead();
  const onAll = view.tab === "library" && view.shelf === "all";
  const onMemory = view.tab === "library" && view.shelf === "memory";
  // The All shelf reads the whole list, in the assembler's order; every other
  // view needs only the count. The selected Context PR is read here, beside
  // them, because its state decides whether the header keeps the gold.
  //
  // The Memory shelf's read is made here too, because a workspace with no
  // memory is that shelf's empty state, which takes the gold from the header.
  const [library, hub, pr, agents, memories] = await Promise.all([
    onAll
      ? readLibrary(ctx, source)
      : source.steering.records(ctx, { kind: null, offset: 0 }),
    source.steering.hub(ctx),
    view.tab === "proposals" && view.proposal !== null
      ? source.steering.contextPr(ctx, view.proposal)
      : null,
    // The Assignments count: the agents set up for steering (./agents-read.ts).
    source.agents.list(ctx, { cursor: null }),
    onMemory
      ? source.steering.memories(ctx, { limit: STEERING_READ_MAX })
      : null,
  ]);
  // A refused or failed read replaces the header and the body. The Memory
  // shelf's read fails the same way the registry's does, because the shelf is
  // the whole body.
  const failure = async (
    read: Parameters<typeof FailureAt>[0]["read"],
  ): Promise<ReactNode> => {
    // The denied state names who is signed in; the session is memoized per
    // request, so this is no second lookup.
    const user = read.reason === "denied" ? await getAuthUser() : null;
    return (
      <FailureAt
        ctx={ctx}
        read={read}
        view={view}
        readAt={readAt}
        viewer={user === null ? null : user.name || user.email || null}
      />
    );
  };
  if (!library.ok) return await failure(library);
  if (memories !== null && !memories.ok) return await failure(memories);
  const mergeable = pr?.ok === true && pr.value.status === "checks_passed";
  const governance = hub.ok ? hub.value.governance : null;
  const repository =
    governance?.state === "read" ? governance.repository : null;
  const records = library.value.total;
  const memoryPage = memories === null ? null : memories.value;
  // A tab body whose own state holds the gold, or holds none (an empty
  // state), takes it from the header (./tab-primary.ts).
  // The Memory shelf's empty state is decided by the hub's own read.
  const bodyGold =
    memoryPage?.total === 0
      ? "empty"
      : await bodyTakesHeaderGold({
          ctx,
          source,
          view,
          published: records,
          pr,
        });
  // Records is the one shelf a read counts today; the rest print "not
  // recorded" until the steering registry reads them (./library-all.tsx).
  const shelves: ShelfCounts = {
    all: records,
    records,
    instructions: null,
    skills: null,
    memory: null,
    ontology: null,
  };
  const empty =
    records === 0 &&
    view.tab === "library" &&
    (view.shelf === "all" || view.shelf === "records");
  return (
    <div className="flex flex-col gap-4" data-testid="steering">
      {/* `proposal` selects nothing off the Context PRs segment, so the
          parse decides this, not the query string. */}
      <PageRecord route="steering" id={view.proposal} />
      {header(
        <>
          <GovernanceChip
            org={ctx.orgSlug}
            ws={ctx.wsSlug}
            workspace={ctx.wsName}
            governance={governance}
          />
          {empty || bodyGold === "empty" ? null : (
            <SteeringCreate
              view={view}
              primary={
                !tabHoldsPrimary(view, mergeable) && bodyGold !== "primary"
              }
            />
          )}
        </>,
      )}
      <SteeringTabs
        at={at}
        current={view.tab}
        counts={{
          library: records,
          assignments: agents.ok ? agents.value.totals.enrolled : null,
          proposals: hub.ok ? hub.value.proposalsWaiting : null,
        }}
      />
      <div
        role="tabpanel"
        id={TAB_PANEL_ID}
        aria-labelledby={tabId(view.tab)}
        className="flex flex-col gap-4"
      >
        {view.tab === "library" ? (
          <ShelfRow at={at} current={view.shelf ?? "all"} counts={shelves} />
        ) : null}
        {empty ? (
          <SteeringEmpty repository={repository} />
        ) : onAll ? (
          <LibraryAll at={at} page={library.value} />
        ) : (
          await Body({
            ctx,
            source,
            view,
            at,
            pr,
            published: records,
            memories: memoryPage,
            repository,
          })
        )}
      </div>
    </div>
  );
}
