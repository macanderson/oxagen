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
import type { ContextPr } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { getAuthUser } from "@/server/session";
import { PageRecord } from "@/features/shell";
import { Skills, SkillsLoading } from "@/features/skills";
import type { WsCtx } from "@/server/viewer";
import { useFormatter } from "@/ui/formatter";
import { SteeringCreate, tabHoldsPrimary } from "./create-action";
import { GovernanceChip } from "./governance";
import { LibraryAll } from "./library-all";
import { readLibrary } from "./library-read";
import { SteeringEmpty, SteeringFailure } from "./page-state";
import { type ShelfCounts, ShelfRow } from "./shelves";
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
}: {
  ctx: WsCtx;
  source: DataSource;
  view: SteeringView;
  at: SteeringAt;
  /** The selected Context PR, when the hub read it. */
  pr: Read<ContextPr> | null;
}) {
  // The async bodies are awaited here rather than rendered as elements, so
  // each read runs before the hub returns and a test renders the result.
  switch (view.tab) {
    case "assignments":
      return await AssignmentsTab({ ctx, source });
    case "gates":
      return await GatesTab({ ctx, source });
    case "compiler":
      return <CompilerTab agent={view.agent} />;
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
            offset: view.offset,
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
          return <MemoryShelf />;
        case "ontology":
          return <OntologyShelf />;
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

/** The failed read's trace instant, in the viewer's zone. */
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
  const format = useFormatter();
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
      readAt={format.dateTime(new Date(readAt), {
        dateStyle: "medium",
        timeStyle: "long",
      })}
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
  // The All shelf reads the whole list, in the assembler's order; every other
  // view needs only the count. The selected Context PR is read here, beside
  // them, because its state decides whether the header keeps the gold.
  const [library, hub, pr] = await Promise.all([
    onAll
      ? readLibrary(ctx, source)
      : source.steering.records(ctx, { kind: null, offset: 0 }),
    source.steering.hub(ctx),
    view.segment === "prs" && view.proposal !== null
      ? source.steering.contextPr(ctx, view.proposal)
      : null,
  ]);
  if (!library.ok) {
    // The denied state names who is signed in; the session is memoized per
    // request, so this is no second lookup.
    const user = library.reason === "denied" ? await getAuthUser() : null;
    return (
      <FailureAt
        ctx={ctx}
        read={library}
        view={view}
        readAt={readAt}
        viewer={user === null ? null : user.name || user.email || null}
      />
    );
  }
  const mergeable = pr?.ok === true && pr.value.status === "checks_passed";
  const governance = hub.ok ? hub.value.governance : null;
  const records = library.value.total;
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
          {empty ? null : (
            <SteeringCreate
              view={view}
              primary={!tabHoldsPrimary(view, mergeable)}
            />
          )}
        </>,
      )}
      <SteeringTabs
        at={at}
        current={view.tab}
        counts={{
          library: records,
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
          <SteeringEmpty
            repository={
              governance?.state === "read" ? governance.repository : null
            }
          />
        ) : onAll ? (
          <LibraryAll at={at} page={library.value} />
        ) : (
          await Body({ ctx, source, view, at, pr })
        )}
      </div>
    </div>
  );
}
